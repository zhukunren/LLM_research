"""Launch the bundled Windows workbench and its loopback MCP bridge."""

from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
from time import monotonic, sleep
from urllib.request import ProxyHandler, build_opener

import psutil


ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / "runtime" / "python" / "python.exe"
BRIDGE = ROOT / "skills" / "kairos" / "llm-research-workbench" / "scripts" / "workbench.py"
LOOPBACK = build_opener(ProxyHandler({}))


def desktop_state() -> Path:
    default = Path(os.environ["LOCALAPPDATA"]) / "LLMResearchWorkbench" / "Workspace"
    return Path(os.environ.get("LLMR_DESKTOP_STATE_ROOT") or default).resolve()


@contextmanager
def lifecycle_lock(state: Path):
    import msvcrt

    state.mkdir(parents=True, exist_ok=True)
    with (state / "desktop.lock").open("a+b") as lock:
        deadline = monotonic() + 55
        while True:
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError as error:
                if monotonic() >= deadline:
                    raise RuntimeError("另一个工作台启动或停止操作尚未完成。") from error
                sleep(0.15)
        try:
            yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def child_environment(state: Path) -> dict[str, str]:
    env = os.environ.copy()
    for name in ("LLMR_TRUSTED_ORIGIN", "LLMR_WORKBENCH_ORIGIN", "LLMR_KAIROS_WORKBENCH_ORIGIN",
                 "LLMR_WORKBENCH_PUBLIC_ORIGIN", "LLMR_WORKBENCH_PROJECT_ROOT"):
        env.pop(name, None)
    env.update(
        LLMR_STATE_ROOT=str(state),
        LLMR_DB_PATH=str(state / "app.db"),
        LLMR_DATA_ROOT=str(state / "data"),
        LLMR_UPLOAD_ROOT=str(state / "uploads"),
        LLMR_ARTIFACT_ROOT=str(state),
        LLMR_SANDBOX_STATE_ROOT=str(state),
        LLMR_CODEX_HOME=str(state / "codex-home"),
        LLMR_CONFIG_FILE=str(state / "config.ini"),
        LLMR_PYTHON_DEPS=str(ROOT / "runtime" / "python-deps"),
        LLMR_AUTH_MODE="local",
        LLMR_REQUIRE_EXTERNAL_STORAGE="true",
        PATH=str(PYTHON.parent) + os.pathsep + env.get("PATH", ""),
    )
    return env


def read_state(file: Path) -> dict:
    try:
        result = json.loads(file.read_text(encoding="utf-8-sig"))
    except (FileNotFoundError, ValueError):
        return {}
    return result if isinstance(result, dict) else {}


def reserve_port() -> int:
    with socket.socket() as endpoint:
        endpoint.bind(("127.0.0.1", 0))
        return endpoint.getsockname()[1]


def bridge_command(port: int) -> list[str]:
    return [str(PYTHON), "-B", "-X", "utf8", str(BRIDGE), "http", "--port", str(port), "--project-root", str(ROOT)]


def bridge_process(record: dict) -> psutil.Process | None:
    port, pid = record.get("port"), record.get("pid")
    if type(port) is not int or not 1 <= port <= 65535 or type(pid) is not int or pid <= 0:
        return None
    try:
        process = psutil.Process(pid)
        if Path(process.exe()).resolve() == PYTHON and process.cmdline()[1:] == bridge_command(port)[1:]:
            return process
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    return None


def bridge_ready(port: int, pid: int) -> bool:
    try:
        with LOOPBACK.open(f"http://127.0.0.1:{port}/health", timeout=1) as response:
            health = json.load(response)
        return isinstance(health, dict) and health.get("pid") == pid and health.get("source") == str(BRIDGE)
    except (OSError, ValueError):
        return False


def stop_bridge(file: Path) -> None:
    process = bridge_process(read_state(file))
    if process:
        try:
            process.terminate()
            process.wait(timeout=5)
        except psutil.NoSuchProcess:
            pass
    file.unlink(missing_ok=True)


def start_bridge(state: Path, env: dict[str, str]) -> int:
    record_file = state / "desktop-bridge.json"
    record = read_state(record_file)
    process = bridge_process(record)
    if process and bridge_ready(record["port"], process.pid):
        return record["port"]
    stop_bridge(record_file)

    port = reserve_port()
    log_path = state / "logs" / "desktop-mcp.log"
    with log_path.open("ab") as log:
        bridge = subprocess.Popen(bridge_command(port), cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                  stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        pending = record_file.with_suffix(".tmp")
        pending.write_text(json.dumps({"pid": bridge.pid, "port": port}), encoding="utf-8")
        pending.replace(record_file)
        deadline = monotonic() + 10
        while bridge.poll() is None and monotonic() < deadline:
            if bridge_ready(port, bridge.pid):
                return port
            sleep(0.12)
        raise RuntimeError(f"本地 MCP 未就绪。日志位置 {log_path}")
    except BaseException:
        if bridge.poll() is None:
            bridge.terminate()
            bridge.wait(timeout=5)
        record_file.unlink(missing_ok=True)
        raise


def start_workbench(state: Path, env: dict[str, str]) -> dict[str, str]:
    if not (ROOT / "apps" / "api" / "migrations" / "001_initial.sql").is_file():
        raise RuntimeError("本地工作台安装不完整。请重新运行工作台安装包。")
    config = state / "config.ini"
    if not config.exists():
        shutil.copyfile(ROOT / "config.example.ini", config)
    logs = state / "logs"
    logs.mkdir(exist_ok=True)
    launch_log = logs / "desktop-launch.log"
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    with launch_log.open("ab") as log:
        result = subprocess.run(
            [str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", str(ROOT / "scripts" / "start.ps1"), "-UserMode"],
            cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    services = read_state(state / "processes.json")
    port = services.get("web_port")
    if result.returncode or type(port) is not int or not 1 <= port <= 65535 or services.get("web_mode") != "bundled":
        raise RuntimeError(f"本地投研工作台未就绪。日志位置 {launch_log}")
    try:
        with closing(sqlite3.connect((state / "app.db").as_uri() + "?mode=ro", uri=True)) as database:
            database.execute("SELECT 1 FROM jobs LIMIT 1")
    except sqlite3.Error as error:
        stop_workbench(state, env)
        raise RuntimeError(f"工作台数据库尚未初始化。日志位置 {launch_log}") from error
    mcp_port = start_bridge(state, env)
    return {"url": f"http://127.0.0.1:{port}/", "mcp_url": f"http://127.0.0.1:{mcp_port}/mcp"}


def stop_workbench(state: Path, env: dict[str, str]) -> None:
    stop_bridge(state / "desktop-bridge.json")
    subprocess.run([str(PYTHON), "-B", str(ROOT / "scripts" / "service_processes.py"), "stop"],
                   cwd=ROOT, env=env, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    (state / "processes.json").unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("open", "connect", "stop"))
    action = parser.parse_args().action
    try:
        state = desktop_state()
        env = child_environment(state)
        with lifecycle_lock(state):
            if action == "stop":
                stop_workbench(state, env)
                return 0
            connection = start_workbench(state, env)
        if action == "open":
            os.startfile(connection["url"])
        else:
            print(json.dumps(connection))
        return 0
    except (OSError, RuntimeError, psutil.Error, subprocess.SubprocessError) as error:
        if action == "open" or sys.stderr is None:
            from ctypes import windll

            windll.user32.MessageBoxW(None, str(error), "投研工作台", 0x10)
        else:
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
            print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
