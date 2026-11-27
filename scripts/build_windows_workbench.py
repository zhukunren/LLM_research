"""Build a self-contained Windows installer and its companion Kairos Skill."""

from __future__ import annotations

import argparse
from base64 import b64encode
import gzip
from hashlib import sha256
from importlib.metadata import distributions
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import NamedTemporaryFile, TemporaryDirectory
import tomllib
from zipfile import ZIP_DEFLATED, ZipFile

from build_kairos_workbench_skill import panel_support_files


ROOT = Path(__file__).resolve().parents[1]
PYTHON_ZIP_SHA256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
LOCAL_SKILL = "llm-research-workbench-local"
LOCAL_SKILL_ZIP = "llm-research-workbench-kairos-local.zip"
BASE_SKILL = ROOT / "skills" / "kairos" / "llm-research-workbench"
SCRIPTS = ("desktop_workbench.py", "start.ps1", "python312.ps1", "storage.ps1", "processes.ps1", "service_processes.py")
CACHES = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache")


def distribution_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def verify_dependencies(dependencies: Path) -> None:
    installed = {
        distribution_name(dist.metadata["Name"]): dist.version
        for dist in distributions(path=[str(dependencies)])
    }
    missing = []
    for line in (ROOT / "requirements.lock").read_text(encoding="utf-8").splitlines():
        name, separator, version = line.partition("==")
        if separator and installed.get(distribution_name(name)) != version:
            missing.append(line)
    if missing:
        raise ValueError("Windows runtime dependencies do not match requirements.lock: " + ", ".join(missing))


def package_skill(output: Path, panel_assets: Path) -> None:
    source = ROOT / "skills" / "kairos" / LOCAL_SKILL
    css = (panel_assets / "workbench-panel.css").read_text(encoding="utf-8")
    script = (panel_assets / "workbench-panel.js").read_text(encoding="utf-8")
    # Keep the in-message HTML small enough to return in one response.
    resources = json.dumps([css, script], ensure_ascii=False).encode("utf-8")
    compressed = b64encode(gzip.compress(resources, mtime=0)).decode("ascii")
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.write(source / "SKILL.md", f"{LOCAL_SKILL}/SKILL.md")
        helper = "scripts/local-workbench.ps1"
        archive.writestr(f"{LOCAL_SKILL}/{helper}", (source / helper).read_text(encoding="utf-8-sig").encode("utf-8-sig"))
        for name in ("project-review.md", "screening.md", "client-service.md"):
            archive.write(BASE_SKILL / "references" / name, f"{LOCAL_SKILL}/references/{name}")
        for name, content in panel_support_files().items():
            archive.writestr(f"{LOCAL_SKILL}/{name}", content)
        archive.writestr(f"{LOCAL_SKILL}/assets/workspace-panel.html", f'''<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>投研工作台</title>
<div id="workbench-panel">正在加载投研工作台面板…</div>
<script type="application/json" id="workbench-panel-data">__LLMR_PANEL_DATA__</script>
<script>
(async () => {{
  const bytes = Uint8Array.from(atob('{compressed}'), char => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const [css, script] = await new Response(stream).json();
  const styles = document.createElement('style');
  styles.textContent = css;
  document.head.append(styles);
  const code = document.createElement('script');
  code.textContent = script;
  document.body.append(code);
}})().catch(() => {{
  document.getElementById('workbench-panel').textContent = '面板暂未加载，请刷新面板。';
}});
</script>
</html>
''')


def prepare_payload(payload: Path, embed: Path, dependencies: Path, web: Path, panel_assets: Path) -> None:
    if sha256(embed.read_bytes()).hexdigest() != PYTHON_ZIP_SHA256:
        raise ValueError("Use the official Windows x64 embeddable ZIP for Python 3.12.10.")
    if not (web / "index.html").is_file():
        raise ValueError("Build apps/web before packaging the Windows installer.")
    verify_dependencies(dependencies)

    python = payload / "runtime" / "python"
    python.mkdir(parents=True)
    with ZipFile(embed) as archive:
        archive.extractall(python)
    (python / "python312._pth").write_text("python312.zip\n.\n..\\python-deps\n..\\..\n", encoding="ascii")

    def ignore_dependency_files(directory: str, names: list[str]) -> set[str]:
        ignored = CACHES(directory, names)
        if Path(directory) == dependencies:
            # pip's generated commands point to the Python installed on the build machine.
            ignored.update({"bin", "Scripts"})
        return ignored

    shutil.copytree(dependencies, payload / "runtime" / "python-deps", ignore=ignore_dependency_files)
    subprocess.run(
        [str(python / "python.exe"), "-B", "-c",
         "import struct; assert struct.calcsize('P') == 8; import fastapi, uvicorn, psutil, duckdb, pyarrow"],
        cwd=payload, check=True,
    )
    shutil.copytree(ROOT / "apps" / "api", payload / "apps" / "api", ignore=CACHES)
    if not (payload / "apps" / "api" / "migrations" / "001_initial.sql").is_file():
        raise ValueError("The Windows payload is missing the initial database migration.")
    shutil.copytree(web, payload / "apps" / "web" / "dist")
    shutil.copyfile(ROOT / "config.example.ini", payload / "config.example.ini")
    (payload / "start.cmd").write_text(
        '@echo off\nstart "" "%~dp0runtime\\python\\pythonw.exe" -B "%~dp0scripts\\desktop_workbench.py" open\n',
        encoding="ascii",
    )

    script_dir = payload / "scripts"
    script_dir.mkdir()
    for name in SCRIPTS:
        source = ROOT / "scripts" / name
        if source.suffix == ".ps1":
            (script_dir / name).write_text(source.read_text(encoding="utf-8-sig"), encoding="utf-8-sig")
        else:
            shutil.copyfile(source, script_dir / name)
    bridge = payload / BASE_SKILL.relative_to(ROOT) / "scripts" / "workbench.py"
    bridge.parent.mkdir(parents=True)
    shutil.copyfile(BASE_SKILL / "scripts" / "workbench.py", bridge)
    package_skill(payload / LOCAL_SKILL_ZIP, panel_assets)


def publish(source: Path, output: Path) -> None:
    with NamedTemporaryFile(dir=output.parent, suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
    try:
        shutil.copyfile(source, temporary)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-embed", type=Path, required=True)
    parser.add_argument("--python-deps", type=Path, required=True)
    parser.add_argument("--iscc", type=Path, required=True)
    parser.add_argument("--web-dist", type=Path, default=ROOT / "apps" / "web" / "dist")
    parser.add_argument("--panel-assets", type=Path, default=ROOT / "artifacts" / "windows-workbench" / "inline-panels")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "artifacts" / "windows-workbench")
    options = parser.parse_args()
    if sys.platform != "win32":
        parser.error("Build the Windows edition on Windows with the lockfile's x64 dependencies.")

    version = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    filename = f"llm-research-workbench-windows-x64-v{version}.exe"
    output = options.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="llmr-windows-setup-") as temporary:
        stage = Path(temporary)
        payload = stage / "payload"
        try:
            prepare_payload(payload, options.python_embed, options.python_deps, options.web_dist, options.panel_assets)
        except (OSError, ValueError, subprocess.CalledProcessError) as error:
            parser.error(str(error))
        instructions = stage / "windows-workbench.iss"
        instructions.write_text((ROOT / "deployment" / instructions.name).read_text(encoding="utf-8-sig"), encoding="utf-8-sig")
        subprocess.run([str(options.iscc.resolve()), "/Qp", f"/O{stage}", f"/DPayloadDir={payload}",
                        f"/DWorkbenchVersion={version}", str(instructions)], check=True)
        for source in (stage / filename, payload / LOCAL_SKILL_ZIP):
            result = output / source.name
            publish(source, result)
            print(result)


if __name__ == "__main__":
    main()
