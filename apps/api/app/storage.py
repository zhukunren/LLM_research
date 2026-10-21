"""Mutable storage locations, separate from application code and dependencies.

Defaults retain the local workbench layout. No directories are created on import.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


def _path(name: str, default: Path) -> Path:
    return Path(os.environ.get(name) or default).expanduser().resolve()


@dataclass(frozen=True)
class StoragePaths:
    state_root: Path
    upload_root: Path
    artifact_root: Path
    sandbox_state_root: Path
    database: Path
    data_root: Path
    python_deps: Path
    evidence_root: Path
    attachments_root: Path
    execution_artifacts: Path
    codex_state: Path

    @property
    def research_root(self) -> Path:
        return self.artifact_root / "research"

    @property
    def report_originals(self) -> Path:
        return self.evidence_root / "report-originals"

    @property
    def codex_home(self) -> Path:
        return self.codex_state


def storage_paths(*, project_root: Path | None = None, database_path: Path | None = None) -> StoragePaths:
    project = (project_root or Path(__file__).resolve().parents[3]).resolve()
    state = _path("LLMR_STATE_ROOT", project / "runtime")
    database = (database_path or _path("LLMR_DB_PATH", state / "app.db")).resolve()
    # Historical research/attachment paths followed DB_PATH, while uploads and
    # execution artifacts followed the checkout. Preserve both legacy defaults.
    evidence = state if os.environ.get("LLMR_STATE_ROOT") else database.parent
    uploads = _path("LLMR_UPLOAD_ROOT", state / "uploads")
    artifacts = _path("LLMR_ARTIFACT_ROOT", evidence)
    return StoragePaths(
        state, uploads, artifacts, _path("LLMR_SANDBOX_STATE_ROOT", state), database,
        _path("LLMR_DATA_ROOT", project / "data"),
        _path("LLMR_PYTHON_DEPS", project / "runtime" / "python-deps"), evidence,
        uploads / "research-attachments" if os.environ.get("LLMR_UPLOAD_ROOT") else evidence / "research-attachments",
        artifacts / "artifacts" if os.environ.get("LLMR_ARTIFACT_ROOT") else state / "artifacts",
        _path("LLMR_CODEX_HOME", _path("LLMR_SANDBOX_STATE_ROOT", state) / "codex-home"),
    )


def application_paths() -> StoragePaths:
    # Honour an injected database in tests and the existing application DB path.
    from . import db, settings
    paths = storage_paths(project_root=settings.PROJECT_ROOT, database_path=db.database_path())
    from .security_context import current_actor
    from dataclasses import replace
    actor = current_actor()
    if actor.workspace is not None:
        return StoragePaths(**{key: Path(value) for key, value in actor.workspace.items()})
    if actor.legacy:
        return paths
    paths = storage_paths(project_root=settings.PROJECT_ROOT, database_path=db.DB_PATH)
    relative = Path("tenants") / actor.tenant_id / "users" / actor.user_id
    return replace(paths, database=db.database_path(), state_root=paths.state_root / relative,
        upload_root=paths.upload_root / relative, artifact_root=paths.artifact_root / relative,
        sandbox_state_root=paths.sandbox_state_root / relative, evidence_root=paths.state_root / relative,
        attachments_root=paths.upload_root / relative / "research-attachments",
        execution_artifacts=paths.artifact_root / relative / "artifacts",
        codex_state=paths.codex_state / relative)


def validate_external_storage(project_root: Path, paths: StoragePaths) -> None:
    """Deployment guard; OS read-only mounts still enforce code protection."""
    value = os.environ.get("LLMR_REQUIRE_EXTERNAL_STORAGE", "false").lower()
    if value not in {"true", "false", "1", "0"}:
        raise ValueError("LLMR_REQUIRE_EXTERNAL_STORAGE must be true or false")
    if value in {"false", "0"}:
        return
    for name in ("state_root", "upload_root", "artifact_root", "sandbox_state_root", "database", "data_root", "codex_home"):
        if getattr(paths, name).resolve().is_relative_to(project_root.resolve()):
            raise ValueError(f"{name} must be outside the read-only application directory")
