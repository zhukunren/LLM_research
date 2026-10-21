"""Bounded, credential-free compatibility checks. Missing isolation fails closed."""
from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]


def execute(command: list[str], *, timeout: int, env=None) -> subprocess.CompletedProcess:
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    try:
        output, error = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # The probe can launch app-server and a browser. Kill only its own tree.
        try:
            import psutil
            children = psutil.Process(process.pid).children(recursive=True)
            for child in reversed(children):
                try:
                    child.kill()
                except psutil.NoSuchProcess:
                    pass
        finally:
            process.kill()
            process.communicate()
        raise
    return subprocess.CompletedProcess(command, process.returncode, output, error)


def container_command(image: str, name: str, *, runtime: str = "runsc", external_sandbox: bool = False) -> list[str]:
    # No host bind mounts, credentials, business code, or Docker socket.
    return ["docker", "run", "--rm", "--name", name, "--runtime", runtime, "--read-only",
            "--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--network", "none", "--memory", "4g", "--cpus", "2", "--pids-limit", "128",
            "--tmpfs", "/workspace:rw,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700",
            "--tmpfs", "/codex-state:rw,nosuid,nodev,size=128m,uid=10001,gid=10001,mode=0700",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777"] + (
                ["--env", "LLMR_PROBE_EXTERNAL_SANDBOX=1"] if external_sandbox else []) + [image]


def verify(*, native: bool, build: bool, image: str, output: Path, runtime: str = "runsc", external_sandbox: bool = False) -> dict:
    report = {"created_at": datetime.now(UTC).isoformat(), "status": "blocked",
              "verification": "native_protocol_only" if native else "linux_gvisor" if runtime == "runsc" else "linux_read_only_container", "checks": {}}
    output.mkdir(parents=True, exist_ok=True)
    name = "llmr-sdk-probe-" + uuid4().hex
    launched = False
    try:
        if native and external_sandbox:
            report["reason"] = "External sandbox mode requires the explicit immutable container check"
            return report
        if native:
            allowed = {"PATH", "SYSTEMROOT", "WINDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LANG"}
            env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
            deps = Path(os.environ.get("LLMR_PYTHON_DEPS") or ROOT / "runtime/python-deps")
            env.update(PYTHONPATH=str(deps), PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8",
                       CODEX_HOME=str(output / "codex-state"), TEMP=str(output), TMP=str(output))
            result = execute([sys.executable, str(ROOT / "deployment/sandbox_probe/probe.py"), "--work", str(output / "work")], timeout=180, env=env)
        else:
            info = execute(["docker", "info", "--format", "{{json .}}"], timeout=10)
            if info.returncode:
                report["reason"] = "Docker engine is unavailable"
                return report
            engine = json.loads(info.stdout)
            if engine.get("OSType") != "linux" or runtime not in engine.get("Runtimes", {}):
                report["reason"] = f"A Linux Docker engine with the {runtime} runtime is required; no fallback is allowed"
                return report
            report["checks"][f"linux_{runtime}_available"] = True
            if build:
                image_build = execute(["docker", "build", "--target", "sandbox-probe", "-f", str(ROOT / "deployment/Dockerfile"), "-t", image, str(ROOT)], timeout=1800)
                if image_build.returncode:
                    report["status"] = "failed"
                    report["reason"] = "Compatibility image build failed"
                    report["build_error"] = image_build.stderr.decode(errors="replace")[-2000:]
                    return report
            launched = True
            result = execute(container_command(image, name, runtime=runtime, external_sandbox=external_sandbox), timeout=180)
        try:
            probe = json.loads(result.stdout.decode("utf-8").strip().splitlines()[-1])
        except (ValueError, IndexError):
            report.update(status="failed", reason="Probe did not return its complete result", error=result.stderr.decode(errors="replace")[-3000:])
            return report
        report["probe"] = probe
        required = {"sdk_initialize", "shell_python_artifacts", "headless_browser", "turn_stream_completed",
                    "mcp_tool_call", "image_input", "thread_resume"}
        if not native:
            required.add("runtime_code_read_only")
        valid = probe.get("sdk_version") == "0.159.0" and all(probe.get("checks", {}).get(key) is True for key in required)
        report["status"] = "passed" if result.returncode == 0 and probe.get("status") == "passed" and valid else "failed"
        if native:
            report["limitation"] = "Native protocol checks do not verify Linux/gVisor or immutable container mounts"
        elif runtime != "runsc":
            report["limitation"] = "Explicit runc compatibility check; does not verify gVisor"
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        report["reason"] = "Required process unavailable or timed out: " + type(exc).__name__
    finally:
        if launched:
            try:
                cleanup = execute(["docker", "rm", "-f", name], timeout=10)
                if cleanup.returncode and b"No such container" not in cleanup.stderr:
                    report.update(status="failed", reason="Could not confirm probe container cleanup")
            except (FileNotFoundError, subprocess.TimeoutExpired):
                report.update(status="failed", reason="Probe container cleanup timed out")
        (output / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--native", action="store_true", help="Protocol-only check; not isolation verification")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--image", default="llmr-sdk-probe:phase1")
    parser.add_argument("--runtime", choices=("runsc", "runc"), default="runsc", help="runc is an explicit container-only check, never gVisor verification")
    parser.add_argument("--external-sandbox", action="store_true", help="Explicitly test typed externalSandbox RPC; immutable container preflight is mandatory")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    deps = Path(os.environ.get("LLMR_PYTHON_DEPS") or ROOT / "runtime/python-deps")
    sys.path.insert(0, str(deps))
    sys.path.insert(0, str(ROOT))
    from apps.api.app.storage import storage_paths
    label = "sdk-native" if args.native else "sdk-gvisor" if args.runtime == "runsc" else "sdk-container"
    if args.external_sandbox:
        label += "-external"
    output = (args.output or storage_paths().state_root / "verification" / label).resolve()
    report = verify(native=args.native, build=args.build, image=args.image, output=output, runtime=args.runtime, external_sandbox=args.external_sandbox)
    print(json.dumps(report, ensure_ascii=True))
    return 0 if report["status"] == "passed" else 2 if report["status"] == "blocked" else 1


if __name__ == "__main__":
    raise SystemExit(main())
