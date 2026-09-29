"""Local Python child-process execution. This is not an OS security sandbox."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Callable

import psutil

from .program_conditions import payload_json

RUNNER = Path(__file__).with_name("screening_runner.py")
WORK_ROOT = RUNNER.parents[3] / "runtime" / "program-runs"
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_BYTES = 20 * 1024 * 1024
MAX_MEMORY_BYTES = 1024 * 1024 * 1024
MAX_PROCESSES = 64
WALL_CLOCK_SECONDS = 60


class RuntimeUnavailable(RuntimeError):
    pass


class ProgramExecutionError(RuntimeError):
    pass


class RuntimeCancelled(RuntimeError):
    pass


def _environment(work_dir: str | None = None) -> dict[str, str]:
    # Do not propagate API credentials or application configuration to generated programs.
    env = {key: value for key, value in os.environ.items()
           if key.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "LANG", "LC_ALL"}}
    if work_dir:
        env.update(TEMP=work_dir, TMP=work_dir, TMPDIR=work_dir)
    env.update(PYTHONIOENCODING="utf-8", OPENBLAS_NUM_THREADS="2", OMP_NUM_THREADS="2")
    return env


def _command() -> list[str]:
    return [sys.executable, "-I", "-u", str(RUNNER)]


def readiness() -> dict[str, Any]:
    if not RUNNER.is_file():
        return {"ready": False, "backend": "local_python", "reason": "本地 Python runner 文件缺失"}
    try:
        probe = subprocess.run(
            [*_command(), "--probe"], capture_output=True, timeout=5, check=False,
            env=_environment(), creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        result = json.loads(probe.stdout.decode("utf-8")) if probe.returncode == 0 else {}
    except (OSError, subprocess.TimeoutExpired, ValueError, UnicodeDecodeError):
        result = {}
    ready = result.get("backend") == "local_python" and result.get("ready") is True
    return {"ready": ready, "backend": "local_python",
            "reason": None if ready else "本地 Python 或 NumPy 依赖不可用，请运行项目 bootstrap 脚本"}


def _decode_result(raw: bytes) -> dict[str, Any]:
    def unique_object(pairs):
        output = {}
        for key, value in pairs:
            if key in output:
                raise ValueError("duplicate JSON key")
            output[key] = value
        return output

    def reject_constant(value):
        raise ValueError(f"nonfinite JSON value: {value}")

    try:
        wrapper = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (UnicodeDecodeError, ValueError) as exc:
        raise ProgramExecutionError("本地计算程序未返回有效且无重复字段的 JSON") from exc
    if not isinstance(wrapper, dict) or wrapper.get("ok") is not True:
        error = wrapper.get("error", {}) if isinstance(wrapper, dict) else {}
        message = error.get("message") if isinstance(error, dict) else None
        raise ProgramExecutionError(str(message or "自定义程序执行失败")[:500])
    result = wrapper.get("result")
    if not isinstance(result, dict):
        raise ProgramExecutionError("自定义程序结果必须是对象")
    return result


def _stop_processes(process: subprocess.Popen, descendants: dict[int, psutil.Process]) -> None:
    try:
        root = psutil.Process(process.pid)
        descendants.update({item.pid: item for item in root.children(recursive=True)})
    except psutil.Error:
        pass
    for child in reversed(list(descendants.values())):
        try:
            child.kill()
        except psutil.Error:
            pass
    if process.poll() is None:
        process.kill()
    process.wait(timeout=5)
    psutil.wait_procs(list(descendants.values()), timeout=3)


def execute_program(
    *, source_code: str, context: dict[str, Any],
    frames: dict[str, list[dict[str, Any]]], params: dict[str, int | float],
    is_active: Callable[[], bool] = lambda: True,
) -> dict[str, Any]:
    if not is_active():
        raise RuntimeCancelled("筛选运行已取消")
    runtime = readiness()
    if not runtime["ready"]:
        raise RuntimeUnavailable(runtime["reason"])
    payload = payload_json(dict(source_code=source_code, context=context, frames=frames, params=params))
    if len(payload) > MAX_INPUT_BYTES:
        raise ProgramExecutionError("自定义程序输入超过64 MiB运行上限")
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="screen-", dir=WORK_ROOT, ignore_cleanup_errors=True) as work_dir:
        try:
            process = subprocess.Popen(
                _command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                cwd=work_dir, env=_environment(work_dir),
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except OSError as exc:
            raise RuntimeUnavailable("无法启动本地 Python 计算子进程") from exc
        output: list[bytes] = []
        output_exceeded = threading.Event()
        io_errors: list[Exception] = []
        descendants: dict[int, psutil.Process] = {}

        def read_output():
            total = 0
            try:
                while chunk := process.stdout.read(64 * 1024):
                    total += len(chunk)
                    if total > MAX_OUTPUT_BYTES:
                        output_exceeded.set()
                        return
                    output.append(chunk)
            except (OSError, ValueError) as exc:
                io_errors.append(exc)

        def send_input():
            try:
                process.stdin.write(payload)
                process.stdin.close()
            except (OSError, ValueError) as exc:
                io_errors.append(exc)

        reader = threading.Thread(target=read_output, daemon=True)
        writer = threading.Thread(target=send_input, daemon=True)
        deadline = time.monotonic() + WALL_CLOCK_SECONDS
        reader.start()
        writer.start()
        try:
            root = psutil.Process(process.pid)
            while process.poll() is None:
                if not is_active():
                    raise RuntimeCancelled("筛选运行已取消")
                if time.monotonic() >= deadline:
                    raise ProgramExecutionError(f"自定义程序超过{WALL_CLOCK_SECONDS}秒运行时限")
                if output_exceeded.is_set():
                    raise ProgramExecutionError("自定义程序输出超过运行上限")
                try:
                    descendants.update({item.pid: item for item in root.children(recursive=True)})
                    alive = [root, *[item for item in descendants.values() if item.is_running()]]
                    if len(alive) > MAX_PROCESSES:
                        raise ProgramExecutionError("自定义程序创建的进程数量超过运行上限")
                    if sum(item.memory_info().rss for item in alive) > MAX_MEMORY_BYTES:
                        raise ProgramExecutionError("自定义程序内存使用超过运行上限")
                except psutil.Error:
                    pass
                time.sleep(0.05)
            return_code = process.returncode
        finally:
            _stop_processes(process, descendants)
            writer.join(timeout=5)
            reader.join(timeout=5)
            for pipe in (process.stdin, process.stdout):
                if pipe and not pipe.closed:
                    pipe.close()
        if not is_active():
            raise RuntimeCancelled("筛选运行已取消")
        if output_exceeded.is_set():
            raise ProgramExecutionError("自定义程序输出超过运行上限")
        if reader.is_alive() or writer.is_alive() or io_errors:
            raise ProgramExecutionError("本地程序输入或输出传输失败")
        if return_code != 0:
            raise ProgramExecutionError("本地计算子进程异常退出")
        return _decode_result(b"".join(output))
