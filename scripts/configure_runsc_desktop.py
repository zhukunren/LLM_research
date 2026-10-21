"""Install verified gVisor in Docker Desktop's Linux VM and hot-reload runtimes.

Explicit administrative setup, never called by the web app or an agent tool.
"""
from __future__ import annotations

import argparse
from datetime import UTC, datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
INSTALL_ROOT = "/mnt/host/c/ProgramData/LLMResearch/gvisor"
LEGACY_PREFIX = "/var/lib/docker/llmr-tools/gvisor"


def command(argv, *, timeout=30):
    result = subprocess.run(argv, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace")[-1800:])
    return result.stdout.decode("utf-8", errors="replace").strip()


def desktop(argv, *, pid=None):
    prefix = ["wsl", "-d", "docker-desktop", "--"]
    if pid is not None:
        prefix += ["nsenter", "-t", str(pid), "-m", "--"]
    return command(prefix + argv)


def host_path(path: Path) -> str:
    path = path.resolve()
    return "/mnt/host/" + path.drive[0].lower() + path.as_posix()[2:]


def snapshot_containers():
    ids = command(["docker", "ps", "-q"]).split()
    if not ids:
        return {}
    data = json.loads(command(["docker", "inspect", *ids]))
    return {item["Id"]: item["State"]["StartedAt"] for item in data}


def configure(release: str, *, debug: bool = False, platform: str = "kvm") -> dict:
    if not re.fullmatch(r"latest|\d{8}(?:\.\d+)?", release):
        raise ValueError("Invalid release identifier")
    if platform not in {"systrap", "kvm"}:
        raise ValueError("Unsupported gVisor platform")
    info = json.loads(command(["docker", "info", "--format", "{{json .}}"] ))
    if command(["docker", "context", "show"]) != "desktop-linux" or info.get("OSType") != "linux":
        raise RuntimeError("This installer only configures the local Docker Desktop Linux engine")
    before = snapshot_containers()
    output = ROOT / "runtime/gvisor"
    output.mkdir(parents=True, exist_ok=True)
    base = f"https://storage.googleapis.com/gvisor/releases/release/{release}/x86_64/"
    archive = output / "gvisor.tar.bz2"
    checksum = urllib.request.urlopen(base + archive.name + ".sha512", timeout=30).read().decode().split()[0]
    def archive_digest():
        with archive.open("rb") as source:
            return hashlib.file_digest(source, "sha512").hexdigest()
    if not archive.exists() or archive_digest() != checksum:
        with urllib.request.urlopen(base + archive.name, timeout=60) as response, archive.open("wb") as destination:
            while chunk := response.read(1024 * 1024):
                destination.write(chunk)
    digest = archive_digest()
    if digest != checksum or not re.fullmatch(r"[0-9a-fA-F]{128}", checksum):
        raise RuntimeError("gVisor release checksum mismatch")
    package = output / "package"
    package.mkdir(exist_ok=True)
    with tarfile.open(archive, "r:bz2") as bundle:
        for member in bundle.getmembers():
            if not (member.isfile() or member.isdir()):
                raise RuntimeError("Unexpected link/device in runtime archive")
        bundle.extractall(package, filter="data")
    executable = next(package.rglob("runsc"), None)
    if executable is None:
        raise RuntimeError("Release archive does not contain runsc")
    package_root = executable.parent
    # runsc re-executes unprivileged sidecars. Docker's private data directory
    # is not traversable by those users, so keep the complete verified release
    # in a persistent, readable runtime installation outside the checkout.
    prefix = INSTALL_ROOT + "/" + digest[:24]
    processes = desktop(["ps", "-ef"])
    match = next((re.match(r"\s*(\d+)\s+.*\bdockerd\b.*--config-file\s+/run/config/docker/daemon.json", line) for line in processes.splitlines() if "dockerd" in line), None)
    if not match:
        raise RuntimeError("Could not identify the expected Docker Desktop daemon")
    pid = int(match.group(1))
    vm_config_path = "/run/config/docker/daemon.json"
    vm_config = json.loads(desktop(["cat", vm_config_path], pid=pid))
    user_config_path = Path.home() / ".docker/daemon.json"
    user_config = json.loads(user_config_path.read_text()) if user_config_path.is_file() else {}
    if platform == "kvm":
        desktop(["test", "-c", "/dev/kvm"], pid=pid)
    entry = {"path": prefix + "/runsc", "runtimeArgs": ["--platform=" + platform]}
    if debug:
        desktop(["mkdir", "-p", "/run/llmr-runsc-debug"], pid=pid)
        entry["runtimeArgs"] += ["--debug=true", "--debug-log=/run/llmr-runsc-debug/"]
    for config in (vm_config, user_config):
        existing = config.get("runtimes", {}).get("runsc")
        owned = existing and (existing.get("path", "").startswith(INSTALL_ROOT + "/") or existing.get("path") == LEGACY_PREFIX + "/runsc")
        if existing and existing != entry and not owned:
            raise RuntimeError("An unrelated runsc runtime is already registered; refusing to replace it")
    # Keep private config backups out of version control and tool output.
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    for name, config in (("vm", vm_config), ("desktop", user_config)):
        (output / f"{name}-config-before-{stamp}.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
        config.setdefault("runtimes", {})["runsc"] = entry
    staged = output / "daemon-merged.json"
    staged.write_text(json.dumps(vm_config, indent=2), encoding="utf-8")
    desktop(["mkdir", "-p", prefix], pid=pid)
    desktop(["cp", "-a", host_path(package_root) + "/.", prefix + "/"], pid=pid)
    desktop(["chmod", "-R", "a+rX", prefix], pid=pid)
    desktop(["chmod", "a+rx", prefix + "/runsc"], pid=pid)
    version = desktop(["setpriv", "--reuid", "65534", "--regid", "65534", "--clear-groups", prefix + "/runsc", "--version"], pid=pid)
    desktop(["/usr/local/bin/dockerd", "--validate", "--config-file", host_path(staged)], pid=pid)
    temporary = user_config_path.with_name("daemon.llmr-tmp.json")
    temporary.write_text(json.dumps(user_config, indent=2), encoding="utf-8")
    os.replace(temporary, user_config_path)
    # Copy the validated config in the daemon's mount namespace, then reload.
    desktop(["cp", host_path(staged), vm_config_path], pid=pid)
    desktop(["kill", "-HUP", str(pid)])
    info_after = json.loads(command(["docker", "info", "--format", "{{json .}}"] ))
    if info_after.get("Runtimes", {}).get("runsc", {}).get("path") != entry["path"]:
        raise RuntimeError("Daemon did not confirm the runsc registration")
    after = snapshot_containers()
    if any(after.get(identity) != started for identity, started in before.items()):
        raise RuntimeError("An existing container changed while configuring the runtime")
    report = {"status": "configured", "release_source": base, "sha512": digest, "runtime_version": version,
              "runtime_path": entry["path"], "default_runtime": info_after.get("DefaultRuntime"),
              "platform": platform,
              "existing_containers_preserved": len(before), "created_at": datetime.now(UTC).isoformat()}
    (output / "installation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", default="20261005.0")
    parser.add_argument("--debug", action="store_true", help="Temporary debugging for synthetic acceptance probes only")
    parser.add_argument("--platform", choices=("systrap", "kvm"), default="kvm", help="KVM is validated on this Desktop; requires /dev/kvm")
    args = parser.parse_args()
    print(json.dumps(configure(args.release, debug=args.debug, platform=args.platform)))
