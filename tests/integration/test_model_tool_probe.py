from fastapi.testclient import TestClient

from apps.api.app import db, main


def test_model_tool_probe_route_returns_only_safe_status(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tool-probe.db")
    monkeypatch.setattr(
        main,
        "probe_function_calling",
        lambda: {
            "connected": True,
            "tool_calling_supported": True,
            "round_trip_completed": True,
            "echo_confirmed": True,
            "model": "gpt-6-luna",
            "api_mode": "responses",
            "latency_ms": 42,
            "reason": None,
        },
    )
    with TestClient(main.app) as client:
        response = client.post("/api/v1/settings/model-tool-test")

    assert response.status_code == 200
    assert response.json()["round_trip_completed"] is True
    assert "private-test-key" not in response.text
    assert "function_call_output" not in response.text
