from __future__ import annotations

from fastapi.testclient import TestClient

from apps.api.app import codex_runtime, conversation_store, db, main


def test_process_route_selects_codex_when_runtime_is_ready(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "codex-web.db")
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True, "reason": None})

    def fake_process(conversation_id: str, turn_id: str):
        turn = conversation_store.get_turn(conversation_id, turn_id)
        conversation_store.finish_turn(
            conversation_id,
            turn_id,
            turn["base_revision"],
            "succeeded",
            "Codex 已完成这次研究回合。",
            {"runtime": "codex", "thread_id": "thread-test", "event_count": 1},
        )
        return conversation_store.get_turn(conversation_id, turn_id)

    monkeypatch.setattr(codex_runtime, "process_conversation_turn", fake_process)
    with TestClient(main.app) as client:
        conversation = client.post("/api/v1/conversations", json={"entry_scope": "screening"}).json()
        message = client.post(
            f"/api/v1/conversations/{conversation['id']}/messages",
            json={
                "client_message_id": "codex-route-1",
                "base_revision": 0,
                "content": "解释当前行情覆盖。",
            },
        ).json()
        response = client.post(
            f"/api/v1/conversations/{conversation['id']}/turns/{message['turn_id']}/codex-process"
        )

    assert response.status_code == 200
    assert response.json()["result"]["runtime"] == "codex"
    assert response.json()["response_text"] == "Codex 已完成这次研究回合。"
