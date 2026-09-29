"""Inspect/stop only this checkout's services, even if its PID registry was lost."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import psutil

ROOT = Path(__file__).resolve().parents[1]


def service_kind(command: list[str], cwd: str, root: Path = ROOT) -> str | None:
    same_root = Path(cwd).resolve() == root.resolve()
    args = command[1:]
    if same_root and args[:2] == ["-m", "apps.api.app.worker"]:
        return "worker"
    if same_root and args[:3] == ["-m", "uvicorn", "apps.api.app.main:app"]:
        return "api"
    vite = root / "apps/web/node_modules/vite/bin/vite.js"
    if args and Path(args[0]).resolve() == vite.resolve() and Path(cwd).resolve() in {root.resolve(), (root / "apps/web").resolve()}:
        return "web"
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["list", "stop"])
    parser.add_argument("--keep", default="")
    args = parser.parse_args()
    keep = {int(value) for value in args.keep.split(",") if value}
    stopped = []
    for process in psutil.process_iter(["pid", "name"]):
        if process.pid == os.getpid() or process.pid in keep or (process.info["name"] or "").lower() not in {"python.exe", "pythonw.exe", "node.exe", "python", "python3", "node"}:
            continue
        try:
            kind = service_kind(process.cmdline(), process.cwd())
            if not kind:
                continue
            print(f"{args.action}: {kind} pid={process.pid}")
            if args.action == "stop":
                # psutil verifies process creation time before terminating, avoiding reused PIDs.
                process.terminate()
                stopped.append(process)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    _, alive = psutil.wait_procs(stopped, timeout=5)
    if alive:
        raise SystemExit("Some project services did not stop; check their process IDs before restarting.")


if __name__ == "__main__":
    main()
