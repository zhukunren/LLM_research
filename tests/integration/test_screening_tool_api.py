import json
from datetime import date

from fastapi.testclient import TestClient
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from apps.api.app import db, main, market
from apps.api.app.screening_artifacts import ArtifactError
from apps.api.app.tool_protocol import ToolCall
from apps.api.app.screening_artifacts import read_artifact_chunk
from apps.api.app.screening_tools import ToolContext, ToolRegistry, registry


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tool-tests.db")
    source = tmp_path / "market.parquet"
    pq.write_table(pa.Table.from_pylist([{
        "stock_code": "600000.SH", "trade_date": date(2026, 9, 14),
        "open": 10., "high": 11., "low": 9., "close": 10., "volume": 100., "amount": 1000.,
    }]), source)
    monkeypatch.setattr(market, "STOCK_FILE", source)
    with TestClient(main.app) as session:
        yield session


def begin_turn(client, entry_scope="technical"):
    conversation = client.post("/api/v1/conversations", json={"entry_scope": entry_scope, "workflow_type": "screening"}).json()
    message = client.post(
        f"/api/v1/conversations/{conversation['id']}/messages",
        json={
            "client_message_id": "user-message",
            "base_revision": 0,
            "content": "最近行情如何",
        },
    ).json()
    return ToolContext(
        conversation_id=conversation["id"],
        turn_id=message["turn_id"],
        task_revision=0,
        as_of="2026-09-14",
        universe_kind="explicit",
        stock_codes=frozenset({"600000.SH"}),
    )


def test_dispatch_is_scope_checked_and_idempotent(client, monkeypatch):
    context = begin_turn(client)
    calls = []
    monkeypatch.setattr(
        market,
        "get_bars",
        lambda stock_code, as_of, limit: calls.append((stock_code, as_of, limit))
        or [{"trade_date": "2026-09-14", "close": 10.0, "quality_valid": True}],
    )
    monkeypatch.setattr(market, "source_fingerprint", lambda: ("sample", 100, 1))

    request = ToolCall(
        "call-1", "read_market_window", {"stock_code": "600000.SH", "limit": 20}
    )
    result = registry.dispatch(request, context)
    replay = registry.dispatch(request, context)
    denied = registry.dispatch(
        ToolCall("call-2", "read_market_window", {"stock_code": "600001.SH", "limit": 20}),
        context,
    )

    assert result["ok"] is True
    assert result["result"]["requested_as_of"] == "2026-09-14"
    assert replay == result
    assert len(calls) == 1
    assert denied["ok"] is False
    assert denied["error"]["code"] == "security_outside_universe"
    with db.connect() as connection:
        rows = connection.execute(
            "SELECT tool_name,state,task_revision,as_of,arguments_json FROM tool_calls ORDER BY rowid"
        ).fetchall()
    assert [(row["tool_name"], row["state"]) for row in rows] == [
        ("read_market_window", "succeeded"),
        ("read_market_window", "failed"),
    ]
    assert rows[0]["task_revision"] == 0
    assert rows[0]["as_of"] == "2026-09-14"
    assert json.loads(rows[0]["arguments_json"]) == {"limit": 20, "stock_code": "600000.SH"}


def test_dispatch_rejects_stale_revisions_and_unregistered_tool_names(client):
    context = begin_turn(client)
    with db.connect() as connection:
        connection.execute(
            "UPDATE conversations SET task_revision=1 WHERE id=?",
            (context.conversation_id,),
        )

    stale = registry.dispatch(
        ToolCall("call-stale", "read_market_window", {"stock_code": "600000.SH", "limit": 5}),
        context,
    )
    assert stale["ok"] is False
    assert stale["error"]["code"] == "revision_conflict"

    with db.connect() as connection:
        connection.execute(
            "UPDATE conversations SET task_revision=0 WHERE id=?",
            (context.conversation_id,),
        )
    unknown = registry.dispatch(
        ToolCall("call-unknown", "exec_host_command", {}),
        context,
    )
    assert unknown["ok"] is False
    assert unknown["error"]["code"] == "unknown_tool"


def test_dispatch_keeps_real_missing_market_capability_guard(client, tmp_path, monkeypatch):
    context = begin_turn(client)
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "missing.parquet")
    monkeypatch.setattr(market, "get_bars", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unavailable source must not be read")))
    result = registry.dispatch(ToolCall("missing-market", "read_market_window", {"stock_code": "600000.SH", "limit": 5}), context)
    assert result["ok"] is False and result["error"]["code"] == "capability_unavailable"


def test_large_tool_result_uses_conversation_scoped_content_hashed_artifact(client, tmp_path):
    context = begin_turn(client)
    artifacts_root = tmp_path / "artifacts"
    local_registry = ToolRegistry(artifact_root=artifacts_root)
    local_registry.register(
        "large_test_result",
        "Return a synthetic large JSON response.",
        registry._registrations["get_market_coverage"].argument_model,
        lambda _args, _context: {"value": "x" * 40000},
    )
    result = local_registry.dispatch(ToolCall("call-large", "large_test_result", {}), context)

    artifact = result["result"]
    content = []
    offset = 0
    while True:
        chunk = read_artifact_chunk(
            artifact["artifact_id"],
            context.conversation_id,
            offset,
            12000,
            root=artifacts_root,
        )
        content.append(chunk["content"])
        if chunk["complete"]:
            break
        offset = chunk["next_offset"]
    assert result["ok"] is True
    assert artifact["read_tool"] == "read_artifact_chunk"
    assert json.loads("".join(content))["value"] == "x" * 40000
    with pytest.raises(ArtifactError):
        read_artifact_chunk(
            artifact["artifact_id"],
            "another-conversation",
            0,
            root=artifacts_root,
        )
