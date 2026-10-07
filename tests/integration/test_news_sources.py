import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, main, news_sources
from apps.api.app.evidence_sources import EvidenceSourceError


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "news.db")
    with TestClient(main.app) as session:
        yield session


def item(**changes):
    value = dict(title="订单公告", body=" 公司新增订单。\n", source="公司公告",
                 stock_codes=["600000.SH"], published_at="2026-09-14T09:00:00+08:00",
                 available_at="2026-09-14T09:05:00+08:00")
    value.update(changes)
    return value


def test_import_is_idempotent_and_identical_content_is_not_duplicated(client):
    payload = {"request_id": "one", "items": [item()]}
    first = client.post("/api/v1/news/import", json=payload)
    replay = client.post("/api/v1/news/import", json=payload)
    duplicate = client.post("/api/v1/news/import", json={**payload, "request_id": "two"})
    assert first.status_code == 201
    assert first.json()["created"] == 1 and replay.json()["replay"] is True
    assert duplicate.json()["duplicates"] == 1
    assert duplicate.json()["items"][0]["id"] == first.json()["items"][0]["id"]
    assert first.json()["items"][0]["body"] == " 公司新增订单。\n"
    assert client.get("/api/v1/news").json()["total"] == 1
    changed = {"request_id": "one", "items": [item(body="不同正文")]}
    assert client.post("/api/v1/news/import", json=changed).status_code == 409


def test_missing_dates_or_security_can_be_read_but_not_screened(client):
    response = client.post("/api/v1/news/import", json=dict(request_id="unknown", items=[
        item(available_at=None), item(title="归属待定", stock_codes=[]),
    ]))
    assert response.status_code == 201
    assert client.get("/api/v1/news").json()["total"] == 2
    assert news_sources.list_news_sources("600000.SH", "2026-09-14")["total"] == 0
    assert client.get("/api/v1/news/" + response.json()["items"][0]["id"]).status_code == 200


def test_local_date_cutoff_and_long_news_chunks(client):
    response = client.post("/api/v1/news/import", json=dict(request_id="boundary", items=[
        item(body="A" * 12000 + "已完成回购。", available_at="2026-09-14T23:59:59+08:00"),
        item(title="次日资料", available_at="2026-09-15T00:00:00+08:00"),
    ]))
    record_id = response.json()["items"][0]["id"]
    assert news_sources.list_news_sources("600000.SH", "2026-09-14")["total"] == 1
    first = news_sources.read_news_chunk(record_id, 1, "600000.SH", "2026-09-14")
    second = news_sources.read_news_chunk(record_id, 1, "600000.SH", "2026-09-14", offset=first["next_offset"])
    assert first["next_offset"] == 12000 and second["text"] == "已完成回购。"
    with pytest.raises(EvidenceSourceError):
        news_sources.read_news_chunk(record_id, 1, "600001.SH", "2026-09-14")


def test_source_edit_creates_new_revision_and_does_not_replace_previous_text(client):
    original = client.post("/api/v1/news/import", json=dict(request_id="original", items=[item()])).json()["items"][0]
    revised = client.post(f"/api/v1/news/{original['id']}/revisions", json=dict(
        request_id="revise", item=item(body="更新：订单已签署。", source="更正公告", available_at="2026-09-16T09:00:00+08:00"),
    ))
    assert revised.status_code == 201
    updated = revised.json()["items"][0]
    assert updated["version"] == 2 and updated["root_id"] == original["root_id"]
    assert client.get(f"/api/v1/news/{original['id']}").json()["body"] == original["body"]
    assert news_sources.list_news_sources("600000.SH", "2026-09-14")["items"][0]["source_id"] == original["id"]
    assert news_sources.list_news_sources("600000.SH", "2026-09-16")["items"][0]["source_id"] == updated["id"]
    stale = client.post(f"/api/v1/news/{original['id']}/revisions", json=dict(request_id="stale", item=item(body="迟到编辑")))
    assert stale.status_code == 409


def test_plain_text_import_empty_library_and_invalid_metadata(client):
    assert client.get("/api/v1/news").json()["items"] == []
    response = client.post("/api/v1/news/import-text", params=dict(request_id="text", title="手动录入", source="本地摘录"),
                           content="原文段落。", headers={"Content-Type": "text/plain"})
    assert response.status_code == 201
    bad_time = item(available_at="2026-09-14T09:05:00")
    assert client.post("/api/v1/news/import", json=dict(request_id="invalid", items=[item(), bad_time])).status_code == 422
    assert client.get("/api/v1/news").json()["total"] == 1
    assert client.get("/api/v1/news?query=手动&limit=1").json()["total"] == 1


def test_new_revision_with_unknown_date_does_not_silently_reuse_old_text(client):
    old = client.post("/api/v1/news/import", json=dict(request_id="old", items=[item()])).json()["items"][0]
    response = client.post(f"/api/v1/news/{old['id']}/revisions", json=dict(
        request_id="unknown-revision", item=item(body="新正文，可用日期待确认。", available_at=None)))
    assert response.status_code == 201
    assert news_sources.list_news_sources("600000.SH", "2026-09-14")["total"] == 0


def test_conversation_news_tools_enforce_security_and_lookback(client):
    from apps.api.app.tool_protocol import ToolCall
    from apps.api.app.screening_tools import ToolContext, registry
    imported = client.post("/api/v1/news/import", json=dict(request_id="tool-data", items=[
        item(), item(title="过期资讯", published_at="2026-09-01T09:00:00+08:00", available_at="2026-09-01T10:00:00+08:00")
    ])).json()["items"]
    conversation = client.post("/api/v1/conversations", json={"entry_scope": "news", "workflow_type": "screening"}).json()
    message = client.post(f"/api/v1/conversations/{conversation['id']}/messages", json=dict(
        client_message_id="news-tools", base_revision=0, content="查看近期资讯")).json()
    context = ToolContext(conversation_id=conversation["id"], turn_id=message["turn_id"], task_revision=0,
                          as_of="2026-09-14", universe_kind="explicit", stock_codes=frozenset({"600000.SH"}), news_lookback_calendar_days=1)
    listed = registry.dispatch(ToolCall("list-news", "list_news_sources", dict(stock_code="600000.SH", offset=0, limit=20)), context)
    assert listed["ok"] and listed["result"]["total"] == 1
    assert listed["result"]["items"][0]["source_id"] == imported[0]["id"]
    outside = registry.dispatch(ToolCall("outside", "read_news_chunk", dict(
        source_id=imported[0]["id"], page_number=1, stock_code="600001.SH", offset=0, limit=100)), context)
    old = registry.dispatch(ToolCall("old", "read_news_chunk", dict(
        source_id=imported[1]["id"], page_number=1, stock_code="600000.SH", offset=0, limit=100)), context)
    assert outside["error"]["code"] == "security_outside_universe"
    assert old["error"]["code"] == "source_ineligible"
