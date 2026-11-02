"""History search stays server-side and in the actor's existing database scope."""
import pytest
from apps.api.app import conversation_store, db


@pytest.fixture
def history(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'history.db')
    db.init_db()
    def create(title, *, state='active', pinned=False):
        item = conversation_store.create_conversation('screening', 'research', workflow_type='research')
        with db.connect() as connection:
            connection.execute('UPDATE conversations SET title=?, state=?, pinned=? WHERE id=?', (title, state, pinned, item['id']))
        return item['id']
    return create


def test_finds_older_title_before_limit_and_paginates_without_duplicates(history):
    oldest = history('稀有主题 兑现')
    with db.connect() as connection:
        connection.execute('UPDATE conversations SET updated_at=? WHERE id=?', ('2000-01-01', oldest))
    for n in range(35):
        history(f'普通主题 {n:02}')
    assert oldest not in {r['id'] for r in conversation_store.list_conversations(limit=30)}
    assert [r['id'] for r in conversation_store.list_conversations(q='稀有 兑现', limit=30)] == [oldest]
    first = conversation_store.list_conversations(q='普通主题', limit=10)
    second = conversation_store.list_conversations(q='普通主题', limit=10, offset=10)
    assert len(first) == len(second) == 10
    assert not {r['id'] for r in first} & {r['id'] for r in second}


def test_literal_wildcards_and_existing_filters_are_preserved(history):
    literal = history('50%_增长\\计划', state='archived', pinned=True)
    history('50其他增长计划')
    assert [r['id'] for r in conversation_store.list_conversations(q='%_')] == [literal]
    assert [r['id'] for r in conversation_store.list_conversations(q='\\')] == [literal]
    assert conversation_store.list_conversations(q='%_', state='active') == []
    assert conversation_store.list_conversations(q="' OR 1=1 --") == []
    with db.connect() as connection:
        connection.execute('UPDATE conversations SET deleted_at=? WHERE id=?', ('2026-01-01', literal))
    assert conversation_store.list_conversations(q='%_') == []


def test_query_matches_generated_first_question_title_not_answer_body(history):
    cid = history(None)
    with db.connect() as connection:
        connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,client_message_id,created_at) VALUES (?,?,?,?,?,?)", ('m1', cid, 'user', '订单兑现与利润', 'assistant-launch:one', '2026-01-01'))
    assert [r['id'] for r in conversation_store.list_conversations(q='订单 兑现')] == [cid]


def test_api_contract_validates_query_and_offset(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    # Isolate this route's actual source from unrelated optional market/PDF imports.
    import ast
    from pathlib import Path
    from typing import Literal
    from fastapi import APIRouter, Query
    from apps.api.app.screening_contracts import ConversationScope
    tree = ast.parse(Path('apps/api/app/conversation_api.py').read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'list_conversations')
    router = APIRouter(prefix='/api/v1/conversations')
    namespace = dict(router=router, Query=Query, Literal=Literal, ConversationScope=ConversationScope, conversation_store=conversation_store)
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'conversation_api.py', 'exec'), namespace)
    calls = []
    monkeypatch.setattr(conversation_store, 'list_conversations', lambda *args, **kwargs: calls.append((args, kwargs)) or [])
    app = FastAPI(); app.include_router(router)
    with TestClient(app) as client:
        assert client.get('/api/v1/conversations', params={'q': '订单', 'offset': 30, 'limit': 31}).status_code == 200
        assert calls[-1][1]['q'] == '订单' and calls[-1][1]['offset'] == 30
        for params in [{'offset': -1}, {'q': 'x' * 201}, {'limit': 101}]:
            assert client.get('/api/v1/conversations', params=params).status_code == 422


def test_search_never_crosses_actor_workspace(tmp_path):
    from apps.api.app.security_context import ActorContext, actor_scope
    from dataclasses import fields
    from apps.api.app.storage import StoragePaths
    def workspace(user):
        return {field.name: str(tmp_path / user / ('app.db' if field.name == 'database' else field.name)) for field in fields(StoragePaths)}
    first = ActorContext('first', 'tenant', workspace=workspace('first'))
    second = ActorContext('second', 'tenant', workspace=workspace('second'))
    with actor_scope(first):
        db.init_db()
        cid = conversation_store.create_conversation('screening', 'research', workflow_type='research')['id']
        with db.connect() as connection:
            connection.execute('UPDATE conversations SET title=? WHERE id=?', ('私有历史', cid))
        assert len(conversation_store.list_conversations(q='私有')) == 1
    with actor_scope(second):
        db.init_db()
        assert conversation_store.list_conversations(q='私有', offset=0) == []
