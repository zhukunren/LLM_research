from fastapi.testclient import TestClient

from apps.api.app import conversation_store, db, main


def test_sidebar_histories_filter_before_limiting_and_keep_legacy_queries(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "history.db")
    db.init_db()
    research = conversation_store.create_conversation("report", workflow_type="research")
    screening = conversation_store.create_conversation("technical", workflow_type="screening")
    with TestClient(main.app) as client:
        for workflow, expected in [("research", research), ("screening", screening)]:
            response = client.get(f"/api/v1/conversations?workflow_type={workflow}&limit=1")
            assert response.status_code == 200
            assert [item["id"] for item in response.json()["items"]] == [expected["id"]]
        assert len(client.get("/api/v1/conversations").json()["items"]) == 2
        assert client.get("/api/v1/conversations?workflow_type=chat").status_code == 422
