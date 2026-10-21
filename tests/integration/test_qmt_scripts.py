"""Natural language QMT method -> static tool -> original-byte download."""
import ast
import hashlib
import json
import os
import shutil

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from apps.api.app import codex_context, conversation_store, db, main, qmt_docs, qmt_scripts, research_assistants, research_files, research_models, screening_tools, settings
from apps.api.app.tool_protocol import ToolCall


CODE = '''# coding: utf-8
TRADING_ENABLED = False
def init(C):
    C.set_universe(['000001.SZ'])
def handlebar(C):
    print('信号观察')
'''


@pytest.fixture
def qmt(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "qmt.db")
    monkeypatch.setattr(research_models, "llm_settings", lambda: {"configured": False, "model": "gpt-6-luna", "reasoning_effort": "high"})
    monkeypatch.setattr(settings, "llm_settings", research_models.llm_settings)
    db.init_db()
    cid = conversation_store.create_conversation("screening", workflow_type="research", assistant_id="qmt-script")["id"]
    message = conversation_store.add_user_message(cid, "qmt-request", 0, "生成 QMT 日线均线信号脚本")
    conversation_store.start_turn(cid, message["turn_id"])
    context = codex_context.task_tool_context(cid, message["turn_id"], 0, None, [])
    with TestClient(main.app) as client:
        yield client, context


def call(context, name, args, call_id=None):
    return screening_tools.registry.dispatch(ToolCall(call_id or name, name, args), context)


def consult(context, code=CODE, prefix="read"):
    for doc_id in sorted(qmt_docs.required_docs(code)):
        offset = 0
        while True:
            result = call(context, "read_qmt_doc", {"doc_id": doc_id, "offset": offset}, f"{prefix}-{doc_id}-{offset}")
            assert result["ok"], result
            offset = result["result"]["next_offset"]
            if offset is None:
                break


@pytest.mark.parametrize("encoding", ["gbk", "utf-8"])
def test_export_method_registry_and_download_preserve_encoding_and_versions(qmt, encoding):
    client, context = qmt
    consult(context)
    catalog = client.get("/api/v1/research-assistants").json()["items"]
    assert next(item for item in catalog if item["id"] == "qmt-script")["launch_mode"] == "draft"
    chosen = research_assistants.turn_snapshot(context.conversation_id, context.turn_id)
    assert "export_qmt_script" in chosen["skill_content"]
    names = {tool.name for tool in screening_tools.registry.tools_for_codex(context)}
    assert {"validate_qmt_script", "export_qmt_script"} <= names
    args = {"code": CODE, "encoding": encoding}
    exported = call(context, "export_qmt_script", args)
    assert exported["ok"], exported
    result = exported["result"]
    assert result["valid"] and result["exported"]
    assert result["runtime_verified"] is False and result["validation"] == "static_only"
    assert not result["documentation"]["missing_doc_ids"]
    assert {item["id"] for item in result["documentation"]["references"]} == qmt_docs.required_docs(CODE)
    file = result["file"]
    downloaded = client.get(file["url"])
    assert downloaded.status_code == 200
    assert downloaded.headers["content-disposition"].startswith("attachment;")
    assert downloaded.headers["content-type"] == "text/x-python"
    assert downloaded.headers["x-content-type-options"] == "nosniff"
    text = downloaded.content.decode(encoding)
    assert text.startswith(f"# -*- coding: {encoding} -*-") and "信号观察" in text
    ast.parse(downloaded.content)
    assert hashlib.sha256(downloaded.content).hexdigest() == file["sha256"]
    assert call(context, "export_qmt_script", args) == exported  # Same tool call is replayed.
    repeated = call(context, "export_qmt_script", args, "export-again")
    assert repeated["result"]["file"] == file
    changed = call(context, "export_qmt_script", {**args, "code": CODE.replace("信号观察", "新信号")}, "new-version")
    assert changed["result"]["file"]["url"] != file["url"]
    assert client.get(file["url"]).content == downloaded.content
    assert len(client.get(f"/api/v1/conversations/{context.conversation_id}/generated-files").json()["items"]) == 2
    other = conversation_store.create_conversation("screening", workflow_type="research")["id"]
    assert client.get(file["url"].replace(context.conversation_id, other)).status_code == 404


@pytest.mark.parametrize("source,error", [
    ("def init(C):\n pass\n", "missing_entrypoint"),
    (CODE + "\nreturn 1\n", "python_syntax"),
    (CODE.replace("def handlebar(C):", "def handlebar(C, required):"), "invalid_entrypoint"),
    ("from xtquant import xtdata\n" + CODE, "wrong_runtime"),
    (CODE + "\nprint('😀')\n", "encoding_error"),
    (CODE + "\nif C.is_back_test: pass\n", "unknown_backtest_flag"),
])
def test_bad_scripts_return_repairable_errors_without_writing(qmt, source, error):
    client, context = qmt
    result = call(context, "export_qmt_script", {"code": source})
    assert result["ok"], result
    assert not result["result"]["exported"]
    assert error in {item["code"] for item in result["result"]["errors"]}
    assert client.get(f"/api/v1/conversations/{context.conversation_id}/generated-files").json()["items"] == []


def test_static_checks_do_not_evaluate_top_level_code_and_report_limits(tmp_path):
    sentinel = tmp_path / "must-not-exist"
    source = CODE + f"\nopen({str(sentinel)!r}, 'w').write('executed')\n"
    result, _ = qmt_scripts.inspect_script(qmt_scripts.QmtScriptArgs(code=source))
    assert result["valid"] and result["runtime_verified"] is False
    assert not sentinel.exists()
    result, _ = qmt_scripts.inspect_script(qmt_scripts.QmtScriptArgs(code=CODE + "\ndef order(C):\n C.get_market_data_ex(['close'])\n passorder(23, 1101, '', '000001.SZ', 5, 0, 100, C)\n"))
    assert {item["code"] for item in result["warnings"]} == {"order_calls", "market_cutoff"}


@pytest.mark.parametrize("filename", ["../escape.py", "C:/escape.py", "sub/escape.py", "bad.py:stream", "qmt.js"])
def test_export_names_cannot_be_paths(filename):
    with pytest.raises(ValidationError):
        qmt_scripts.QmtScriptArgs(code=CODE, filename=filename)


def test_existing_hardlink_is_not_overwritten(qmt, tmp_path):
    _, context = qmt
    consult(context)
    args = qmt_scripts.QmtScriptArgs(code=CODE)
    _, payload = qmt_scripts.inspect_script(args)
    name = "qmt_strategy_" + hashlib.sha256(payload).hexdigest()[:16] + ".py"
    root = research_files._outputs_root(context.conversation_id)
    root.mkdir(parents=True)
    private = tmp_path / "private.txt"
    private.write_text("PRIVATE")
    os.link(private, root / name)
    result = call(context, "export_qmt_script", args.model_dump())
    assert not result["ok"] and result["error"]["code"] == "qmt_export_failed"
    assert private.read_text() == "PRIVATE"


def test_export_requires_complete_current_turn_reads_not_search_excerpts(qmt):
    client, context = qmt
    result = call(context, "export_qmt_script", {"code": CODE}, "before-reading")["result"]
    assert not result["exported"] and result["documentation"]["missing_doc_ids"]
    discovery = call(context, "search_qmt_docs", {"query": "set_universe"})
    assert discovery["ok"] and discovery["result"]["items"]
    assert not call(context, "export_qmt_script", {"code": CODE}, "search-only")["result"]["exported"]
    partial = call(context, "read_qmt_doc", {"doc_id": "strategy-handbook", "limit": 1}, "partial-read")
    assert partial["ok"] and partial["result"]["next_offset"] == 1
    assert "strategy-handbook" in call(context, "export_qmt_script", {"code": CODE}, "partial-only")["result"]["documentation"]["missing_doc_ids"]
    consult(context)
    assert call(context, "export_qmt_script", {"code": CODE}, "after-reading")["result"]["exported"]
    # The missing-read attempt remains an immutable replay, not a second export.
    assert not call(context, "export_qmt_script", {"code": CODE}, "before-reading")["result"]["exported"]
    conversation_store.finish_turn(context.conversation_id, context.turn_id, 0, "succeeded", "已生成", {})
    message = conversation_store.add_user_message(context.conversation_id, "qmt-followup", 0, "调整参数")
    conversation_store.start_turn(context.conversation_id, message["turn_id"])
    followup = codex_context.task_tool_context(context.conversation_id, message["turn_id"], 0, None, [])
    assert not call(followup, "export_qmt_script", {"code": CODE})["result"]["exported"]


def test_document_api_has_search_provenance_and_read_version_checks(qmt):
    client, context = qmt
    discovery = client.get("/api/v1/qmt-docs", params={"query": "C.get_market_data_ex"})
    assert discovery.status_code == 200
    body = discovery.json()
    first = body["items"][0]
    assert first["id"] == "official-market-data" and first["sources"][0].startswith("https://dict.thinktrader.net/")
    assert body["target"] == "qmt_builtin_python" and "path" not in first
    read = client.get(first["url"], params={"expected_sha256": first["sha256"], "limit": 60}).json()
    assert read["next_offset"] == 60 and read["runtime_verified"] is False
    assert client.get(first["url"], params={"expected_sha256": "0" * 64}).status_code == 409
    assert client.get("/api/v1/qmt-docs/unknown").status_code == 404
    result = call(context, "read_qmt_doc", {"doc_id": "official-context", "offset": 99999})
    assert not result["ok"] and result["error"]["code"] == "qmt_reference_error"


def test_legacy_qmt_turn_keeps_its_frozen_export_behavior(qmt):
    _, context = qmt
    # An old assistant profile is frozen before the new registry policy existed.
    legacy = research_assistants.snapshot({**research_assistants._builtins()[0], "id": "qmt-script", "revision": 1})
    with db.connect() as connection:
        connection.execute("UPDATE conversations SET assistant_snapshot_json=? WHERE id=?", (db.json_dump(legacy), context.conversation_id))
    conversation_store.finish_turn(context.conversation_id, context.turn_id, 0, "succeeded", "旧轮次", {})
    message = conversation_store.add_user_message(context.conversation_id, "legacy", 0, "生成旧版脚本")
    conversation_store.start_turn(context.conversation_id, message["turn_id"])
    legacy_context = codex_context.task_tool_context(context.conversation_id, message["turn_id"], 0, None, [])
    assert call(legacy_context, "export_qmt_script", {"code": CODE})["result"]["exported"]


def test_changed_reference_bundle_requires_fresh_reads_and_records_new_version(qmt, tmp_path, monkeypatch):
    _, context = qmt
    consult(context)
    root = tmp_path / "revised-references"
    shutil.copytree(qmt_docs.REFERENCE_ROOT, root)
    catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
    handbook = next(item for item in catalog["documents"] if item["id"] == "strategy-handbook")
    path = root / handbook["path"]
    path.write_text(path.read_text(encoding="utf-8") + "\n修订说明。\n", encoding="utf-8")
    handbook["sha256"] = hashlib.sha256(path.read_text(encoding="utf-8").encode("utf-8")).hexdigest()
    catalog["version"] = "2026-10-15.2"
    (root / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(qmt_docs, "REFERENCE_ROOT", root)
    response = call(context, "export_qmt_script", {"code": CODE}, "changed-docs")
    assert response["ok"], response
    result = response["result"]
    assert not result["exported"] and not result["documentation"]["references"]
    consult(context, prefix="reread")
    exported = call(context, "export_qmt_script", {"code": CODE}, "fresh-docs")["result"]
    assert exported["exported"] and exported["documentation"]["version"] == "2026-10-15.2"
