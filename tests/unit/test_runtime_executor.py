import json

import pytest

from apps.api.app import runtime_executor


def test_missing_local_dependencies_do_not_execute_in_api_process(monkeypatch):
    monkeypatch.setattr(runtime_executor, "readiness", lambda: {"ready": False, "reason": "NumPy unavailable"})
    monkeypatch.setattr(runtime_executor.subprocess, "Popen", lambda *a, **k: pytest.fail("must not launch"))
    with pytest.raises(runtime_executor.RuntimeUnavailable, match="NumPy"):
        runtime_executor.execute_program(source_code="raise RuntimeError('not executed')", context={}, frames={}, params={})


def test_unwritable_work_directory_fails_before_launching_a_program(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime_executor, "readiness", lambda: {"ready": True})
    blocked = tmp_path / "not-a-directory"
    blocked.write_text("blocked")
    monkeypatch.setattr(runtime_executor, "WORK_ROOT", blocked)
    monkeypatch.setattr(runtime_executor.subprocess, "Popen", lambda *a, **k: pytest.fail("must not launch"))
    with pytest.raises(runtime_executor.RuntimeUnavailable, match="目录权限"):
        runtime_executor.execute_program(source_code="", context={}, frames={}, params={})


@pytest.mark.parametrize("raw", [
    b'{"ok":true,"result":{"decisions":{"A":true,"A":false}}}',
    b'{"ok":true,"result":{"value":NaN}}',
    b'not json',
])
def test_result_transport_rejects_duplicate_keys_nonfinite_values_and_garbage(raw):
    with pytest.raises(runtime_executor.ProgramExecutionError, match="JSON"):
        runtime_executor._decode_result(raw)


def test_error_wrapper_preserves_failure_instead_of_a_false_result():
    with pytest.raises(runtime_executor.ProgramExecutionError, match="division"):
        runtime_executor._decode_result(json.dumps({"ok": False, "error": {"message": "division by zero"}}).encode())


def test_child_environment_does_not_inherit_model_credentials(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-secret")
    monkeypatch.setenv("LLM_API_TOKEN", "fixture-token")
    env = runtime_executor._environment("scratch")
    assert "OPENAI_API_KEY" not in env and "LLM_API_TOKEN" not in env
    assert env["TEMP"] == "scratch"
