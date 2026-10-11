from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from apps.api.app import codex_store, conversation_store as store, db, main, research_sources, research_shares, research_workspace
from apps.api.app.research_answer_actions import apply


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "shares.db")
    monkeypatch.setattr(research_shares, "service_settings", lambda: ("https://share.example.test", "test-write-key"))
    with TestClient(main.app) as session:
        yield session


def create(client):
    return client.post('/api/v1/conversations', json={"entry_scope": "report", "workflow_type": "research"}).json()["id"]


def answer(cid, question="问题", content="研究结论", events=None, legacy=False):
    request = store.add_user_message(cid, question, 0, question)
    store.start_turn(cid, request["turn_id"])
    for index, item in enumerate(events or []):
        codex_store.append_event(cid, request["turn_id"], 'native-thread', 'native-turn', index, 'item/completed', {"item": item})
    if legacy:
        with db.connect() as connection:
            connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,client_message_id,created_at) VALUES(?,?,'assistant',?,?,?)",
                               ('legacy-answer', cid, content, 'assistant:' + request['turn_id'], db.utc_now()))
            connection.execute("UPDATE conversation_turns SET state='succeeded',response_text=? WHERE id=?", (content, request['turn_id']))
        return 'legacy-answer'
    store.finish_turn(cid, request['turn_id'], 0, 'succeeded', content, {})
    return store.get_conversation(cid)['messages'][-1]['id']


def test_sources_include_citations_inside_linked_report_and_native_opened_pages(client):
    cid = create(client)
    research_workspace.write_output(cid, 'full-report.md', '# 结论\n[原始公告](https://example.com/report_(2026))')
    mid = answer(cid, content='[完整报告](outputs/full-report.md)', events=[
        {'type': 'webSearch', 'action': {'type': 'other'}, 'results': [{'ref_id': 'turn1view0', 'url': 'https://example.com/read', 'title': '查阅原文', 'snippet': '实际网页摘录'}]},
        {'type': 'webSearch', 'action': {'type': 'search'}, 'results': [{'ref_id': 'turn0search0', 'url': 'https://example.com/not-read', 'title': '仅检索到'}]},
        {'type': 'commandExecution', 'aggregatedOutput': 'https://secret.test/private', 'command': 'https://secret.test/command'},
        {'type': 'reasoning', 'summary': ['https://secret.test/reasoning']},
    ])
    response = client.get(f'/api/v1/conversations/{cid}/answers/{mid}/sources')
    assert response.status_code == 200
    items = response.json()['items']
    assert {item['url'] for item in items} == {'https://example.com/report_(2026)', 'https://example.com/read'}
    assert next(item for item in items if item['url'].endswith('/read'))['relation'] == 'consulted'
    assert next(item for item in items if item['url'].endswith('/read'))['excerpt_kind'] == 'search_snippet'
    assert 'secret' not in json.dumps(items)
    assert len(store.get_conversation(cid)['messages'][-1]['source_refs']) == 2


def test_legacy_sources_are_recovered_without_mutating_immutable_message(client):
    cid = create(client)
    research_workspace.write_output(cid, 'report.md', '[一手来源](https://example.com/original)')
    mid = answer(cid, content='[完整研究](outputs/report.md)', legacy=True)
    before = store.get_conversation(cid)['messages'][-1]
    response = client.get(f'/api/v1/conversations/{cid}/answers/{mid}/sources')
    assert response.json()['items'][0]['url'] == 'https://example.com/original'
    assert store.get_conversation(cid)['messages'][-1] == before
    (research_workspace.directory(cid) / 'outputs' / 'report.md').write_text('[后续资料](https://example.com/later)', encoding='utf-8')
    assert client.get(f'/api/v1/conversations/{cid}/answers/{mid}/sources').json() == response.json()


def test_local_source_read_keeps_title_page_and_original_excerpt(client):
    cid = create(client)
    mid = answer(cid, events=[{'type': 'mcpToolCall', 'tool': 'read_research_source', 'status': 'completed',
        'arguments': {'kind': 'report', 'source_id': 'report-id', 'page_number': 3},
        'result': {'content': [{'type': 'text', 'text': json.dumps({'ok': True, 'result': {'title': '报告原文', 'source_id': 'report-id', 'page_number': 3, 'text': '来源原文内容'}})}]}}])
    item = client.get(f'/api/v1/conversations/{cid}/answers/{mid}/sources').json()['items'][0]
    assert item['kind'] == 'report_page' and item['page_number'] == 3 and item['excerpt'] == '来源原文内容'
    assert item['excerpt_kind'] == 'original_text'


def test_share_is_frozen_at_selected_answer_and_published_once(client, monkeypatch):
    cid = create(client)
    first = answer(cid, "第一问题", "[一手来源](https://example.com/original)")
    answer(cid, "后续问题", "不应出现在分享中")
    uploaded = []
    def post(url, **kwargs):
        uploaded.append(kwargs['json'])
        assert kwargs['headers'] == {'Authorization': 'Bearer test-write-key'}
        return SimpleNamespace(status_code=201, json=lambda: {'url': 'https://share.example.test/s/' + kwargs['json']['token']})
    monkeypatch.setattr(research_shares.requests, 'post', post)
    url = f'/api/v1/conversations/{cid}/answers/{first}/share'
    response = client.post(url, json={'request_id': 'share'})
    assert response.status_code == 200
    assert response.json()['url'].startswith('https://share.example.test/s/')
    assert client.post(url, json={'request_id': 'share'}).json() == response.json()
    assert len(uploaded) == 1
    snapshot = uploaded[0]['snapshot']
    assert [message['content'] for message in snapshot['messages']] == ['第一问题', '[一手来源](https://example.com/original)']
    assert snapshot['messages'][-1]['sources'][0]['url'] == 'https://example.com/original'
    assert 'test-write-key' not in json.dumps(snapshot)
    assert client.get(url).json()['share']['url'] == response.json()['url']


def test_selected_old_answer_version_is_shared_instead_of_latest_version(client, monkeypatch):
    cid = create(client)
    original = answer(cid, content='原始结论')
    regenerated = apply(cid, original, 'regenerate', 'regenerate')
    store.start_turn(cid, regenerated['turn_id'])
    store.finish_turn(cid, regenerated['turn_id'], 0, 'succeeded', '新结论', {})
    snapshot = research_shares._snapshot(cid, original)
    assert [message['content'] for message in snapshot['messages']] == ['问题', '原始结论']


def test_share_contains_report_text_and_replaces_owner_only_download_links(client):
    cid = create(client)
    research_workspace.write_output(cid, 'report.md', '# 完整报告\n[出处](https://example.com/source)')
    mid = answer(cid, content='[查看报告](outputs/report.md)')
    snapshot = research_shares._snapshot(cid, mid)
    assert snapshot['messages'][-1]['content'] == '[查看报告](#file-0)'
    assert snapshot['files'][0]['content'].startswith('# 完整报告')
    assert snapshot['messages'][-1]['sources'][0]['url'] == 'https://example.com/source'


def test_failed_publish_retries_original_snapshot_without_publishing_followups(client, monkeypatch):
    cid = create(client)
    mid = answer(cid, content='需要保留的原结论')
    url = f'/api/v1/conversations/{cid}/answers/{mid}/share'
    monkeypatch.setattr(research_shares.requests, 'post', lambda *args, **kwargs: SimpleNamespace(status_code=503))
    assert client.post(url, json={'request_id': 'retry'}).status_code == 503
    answer(cid, '以后追问', '后续结论')
    uploaded = []
    def post(*args, **kwargs):
        uploaded.append(kwargs['json'])
        return SimpleNamespace(status_code=201, json=lambda: {'url': 'https://share.example.test/s/' + kwargs['json']['token']})
    monkeypatch.setattr(research_shares.requests, 'post', post)
    assert client.post(url, json={'request_id': 'retry'}).status_code == 200
    assert [message['content'] for message in uploaded[0]['snapshot']['messages']] == ['问题', '需要保留的原结论']


def test_shares_do_not_read_foreign_messages_or_reuse_request_for_different_answer(client):
    cid, other = create(client), create(client)
    mid = answer(cid)
    assert client.get(f'/api/v1/conversations/{other}/answers/{mid}/sources').status_code == 404
    assert client.post(f'/api/v1/conversations/{other}/answers/{mid}/share', json={'request_id': 'foreign'}).status_code == 422
    assert research_sources.markdown_links('```python\nhttps://private.test\n```\n[安全](javascript:alert(1))') == [('安全', 'javascript:alert(1)')]


def test_share_revocation_invalidates_cloud_snapshot(client, monkeypatch):
    cid = create(client)
    mid = answer(cid)
    monkeypatch.setattr(research_shares.requests, 'post', lambda *args, **kwargs: SimpleNamespace(status_code=201, json=lambda: {'url': 'https://share.example.test/s/' + kwargs['json']['token']}))
    share = client.post(f'/api/v1/conversations/{cid}/answers/{mid}/share', json={'request_id': 'share'}).json()
    calls = []
    monkeypatch.setattr(research_shares.requests, 'delete', lambda url, **kwargs: calls.append(url) or SimpleNamespace(status_code=204))
    assert client.delete(f"/api/v1/conversations/{cid}/shares/{share['id']}").json()['revoked']
    assert calls == [share['url'].replace('/s/', '/api/shares/')]
    assert client.get(f'/api/v1/conversations/{cid}/answers/{mid}/share').json()['share'] is None
    assert client.post(f'/api/v1/conversations/{cid}/answers/{mid}/share', json={'request_id': 'share'}).status_code == 409
