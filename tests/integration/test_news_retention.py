from contextlib import closing
from datetime import date
from pathlib import Path
import shutil
import sqlite3
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from apps.api.app import conversation_store, db, main, news_retention, news_sources, research_workspace, tushare_sync
from apps.api.app.screening_contracts import ConversationSourceReference


TODAY = date(2026, 11, 20)
ENDPOINT = "/api/v1/maintenance/news-retention"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "retention.db")
    monkeypatch.setattr(news_retention, "today", lambda: TODAY)
    with TestClient(main.app) as session:
        yield session


def article(key, publication, *, origin="tushare", available=None, base_id=None):
    result = news_sources.import_items(
        news_sources.NewsImport(request_id=key, items=[news_sources.NewsItemInput(
            title=key, source="Tushare news/eastmoney", body=f"{key} 原文", published_at=publication,
            available_at=available or publication, stock_codes=["000001.SZ"],
        )]),
        origin=origin, base_id=base_id,
    )
    return result["items"][0]


def test_news_window_defaults_and_preserves_manual_and_explicit_sources(client, tmp_path):
    cutoff = article("cutoff", "2026-10-22T00:00:00+08:00")
    current = article("current", "2026-11-20T11:00:00+08:00")
    expired = article("expired", "2026-10-21T23:59:59+08:00", available="2026-11-20T08:00:00+08:00")
    manual = article("manual", "2026-10-01T10:00:00+08:00", origin="manual")
    hidden = article("another-old", "2026-10-01T10:00:00+08:00")
    assert {item["id"] for item in client.get("/api/v1/news").json()["items"]} == {cutoff["id"], current["id"]}
    assert [item["id"] for item in client.get("/api/v1/news?view=today").json()["items"]] == [current["id"]]
    assert [item["id"] for item in client.get("/api/v1/news?view=manual").json()["items"]] == [manual["id"]]
    assert client.get("/api/v1/news?end_date=2026-10-21").json()["total"] == 0
    assert client.get(f"/api/v1/news/{expired['id']}").status_code == 200

    conversation = conversation_store.create_conversation("news", workflow_type="research")
    conversation_store.add_user_message(
        conversation["id"], "explicit-ref", 0, "读取已选的原文。",
        source_refs=[ConversationSourceReference(kind="news_item", source_id=expired["id"])],
    )
    snapshot = tmp_path / "scoped.sqlite"
    research_workspace._snapshot(snapshot, conversation["id"])
    with closing(sqlite3.connect(snapshot)) as connection:
        ids = {row[0] for row in connection.execute("SELECT id FROM news")}
    assert ids == {cutoff["id"], current["id"], expired["id"]}
    assert hidden["id"] not in ids


def test_cleanup_requires_matching_preview_and_skips_active_work_and_referenced_groups(client, monkeypatch):
    old = "2026-10-19T09:00:00+08:00"
    expired = article("expired", old)
    second = article("second", old)
    referenced = article("quoted", old)
    revision = article("revised", old, base_id=referenced["id"])
    manual = article("manual", old, origin="manual")
    recent = article("recent", "2026-10-22T00:00:00+08:00")
    conversation = conversation_store.create_conversation("news", workflow_type="research")
    with db.connect() as connection:
        connection.execute(
            "INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)",
            ("saved-answer", conversation["id"], "assistant", f"[新闻](/api/v1/news/{referenced['id']})", db.utc_now()),
        )
    preview = client.get(ENDPOINT).json()
    assert (preview["enabled"], preview["eligible_count"], preview["protected_count"]) == (False, 2, 1)
    news_retention.cleanup_due()
    assert client.get(f"/api/v1/news/{expired['id']}").status_code == 200
    assert client.put(ENDPOINT, json={"enabled": True, "preview_token": "0" * 64}).status_code == 409
    assert client.put(ENDPOINT, json={"enabled": True, "preview_token": preview["preview_token"]}).json()["enabled"]

    with db.connect() as connection:
        connection.execute(
            "INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            ("active", "data_sync", "{}", "queued", "test", db.utc_now(), db.utc_now()),
        )
    news_retention.cleanup_due()
    assert client.get(ENDPOINT).json()["last_run"] is None
    with db.connect() as connection:
        connection.execute("UPDATE jobs SET state='cancelled' WHERE id='active'")

    monkeypatch.setattr(news_retention, "BATCH_SIZE", 1)
    news_retention.cleanup_due()
    pending = client.get(ENDPOINT).json()["last_run"]
    assert pending["deleted_count"] == 1 and pending["finished_at"] is None
    news_retention.cleanup_due()
    completed = client.get(ENDPOINT).json()["last_run"]
    assert completed["deleted_count"] == completed["receipt_count"] == 2
    assert completed["protected_count"] == 1 and completed["finished_at"]
    news_retention.cleanup_due()
    assert client.get(ENDPOINT).json()["last_run"] == completed
    for item in (expired, second):
        assert client.get(f"/api/v1/news/{item['id']}").status_code == 404
    for item in (referenced, revision, manual, recent):
        assert client.get(f"/api/v1/news/{item['id']}").status_code == 200
    assert client.put(ENDPOINT, json={"enabled": False}).json()["enabled"] is False


def test_sync_clamps_backfill_and_checks_that_provider_rows_are_in_range(client, monkeypatch):
    monkeypatch.setattr(tushare_sync, "NEWS_ENDPOINT_SOURCES", ("eastmoney",))
    monkeypatch.setattr(tushare_sync, "SOURCE_DELAY_SECONDS", 0)
    requests = []

    class Relay:
        def raw_query(self, endpoint, **params):
            requests.append((endpoint, params))
            return {"code": 0, "data": {"fields": ["datetime", "content"], "items": [
                ["2026-10-21 23:59:59", "过期正文"],
                ["2026-10-22 00:00:00", "边界正文"],
            ]}}

    entirely_old = tushare_sync.sync_news(Relay(), start=date(2026, 9, 1), as_of=date(2026, 10, 21))
    assert entirely_old["status"] == "no_new_rows" and not requests
    sync = tushare_sync.sync_news(Relay(), start=date(2026, 10, 20), as_of=TODAY)
    assert requests[0][1]["start_date"] == "2026-10-22 00:00:00"
    assert sync["import"]["created"] == 1
    assert client.get("/api/v1/news").json()["items"][0]["title"] == "边界正文"


def test_migration_recognizes_legacy_sync_and_keeps_a_manual_duplicate(tmp_path, monkeypatch):
    latest_migrations = db.MIGRATIONS_DIR
    previous_migrations = tmp_path / "previous"
    previous_migrations.mkdir()
    for file in Path(latest_migrations).glob("*.sql"):
        if file.name < "059_news_retention.sql":
            shutil.copyfile(file, previous_migrations / file.name)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "legacy.db")
    monkeypatch.setattr(db, "MIGRATIONS_DIR", previous_migrations)
    db.init_db()
    automatic, also_manual = str(uuid4()), str(uuid4())
    with db.connect() as connection:
        for record_id in (automatic, also_manual):
            connection.execute("""
                INSERT INTO news_records(id,root_id,version,title,body,source,published_at,stock_codes_json,event_key,payload_json,created_at)
                VALUES(?,?,1,'原始资讯','原文','Tushare news/eastmoney','2026-10-19T00:00:00+00:00','[]','tushare-news:old','{}',?)
            """, (record_id, record_id, db.utc_now()))
        for request_id, item_ids in (
            ("tushare-news-eastmoney-20261001-20261019-" + "b" * 24, [automatic, also_manual]),
            ("user-import", [also_manual]),
        ):
            connection.execute("INSERT INTO news_import_requests VALUES(?,?,?)", (
                request_id, "{}", db.json_dump({"items": [{"id": item_id} for item_id in item_ids]}),
            ))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", latest_migrations)
    monkeypatch.setattr(news_retention, "today", lambda: TODAY)
    db.init_db()
    with db.connect() as connection:
        assert dict(connection.execute("SELECT id,origin FROM news_records").fetchall()) == {
            automatic: "tushare", also_manual: "manual",
        }
    assert news_retention.status()["eligible_count"] == 1
    assert news_retention.status()["enabled"] is False
