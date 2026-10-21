import json
import subprocess

from scripts import verify_sdk_sandbox as verification


def test_missing_docker_writes_blocked_result_and_never_runs_native_fallback(tmp_path, monkeypatch):
    calls = []
    def unavailable(command, **kwargs):
        calls.append(command)
        raise FileNotFoundError()
    monkeypatch.setattr(verification, "execute", unavailable)
    report = verification.verify(native=False, build=False, image="probe", output=tmp_path)
    assert report["status"] == "blocked"
    assert len(calls) == 1 and calls[0][:2] == ["docker", "info"]
    assert json.loads((tmp_path / "result.json").read_text())["status"] == "blocked"


def test_plain_docker_without_runsc_is_not_reported_as_sandbox_verified(tmp_path, monkeypatch):
    def available(command, **kwargs):
        assert command[:2] == ["docker", "info"]
        return subprocess.CompletedProcess(command, 0, b'{"OSType":"linux","Runtimes":{"runc":{}}}', b"")
    monkeypatch.setattr(verification, "execute", available)
    assert verification.verify(native=False, build=False, image="probe", output=tmp_path)["status"] == "blocked"


def test_container_uses_read_only_runsc_without_host_mounts_or_keys():
    command = verification.container_command("probe", "llmr-sdk-probe-test")
    assert command[command.index("--runtime") + 1] == "runsc"
    assert "--read-only" in command
    assert command[command.index("--network") + 1] == "none"
    assert "--mount" not in command and "-v" not in command
    assert not any("API_KEY" in value or "docker.sock" in value for value in command)


def test_external_sandbox_refuses_host_execution(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("No process may be launched")
    monkeypatch.setattr(verification, "execute", forbidden)
    report = verification.verify(native=True, build=False, image="probe", output=tmp_path, external_sandbox=True)
    assert report["status"] == "blocked"
    command = verification.container_command("probe", "probe", external_sandbox=True)
    assert "--read-only" in command and "LLMR_PROBE_EXTERNAL_SANDBOX=1" in command
