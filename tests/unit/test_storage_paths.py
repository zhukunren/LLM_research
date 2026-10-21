from pathlib import Path

import pytest

from apps.api.app import settings, storage


@pytest.fixture(autouse=True)
def clean_paths(monkeypatch):
    for key in ("LLMR_STATE_ROOT", "LLMR_UPLOAD_ROOT", "LLMR_ARTIFACT_ROOT", "LLMR_SANDBOX_STATE_ROOT", "LLMR_DB_PATH", "LLMR_DATA_ROOT", "LLMR_PYTHON_DEPS", "LLMR_CODEX_HOME", "LLMR_REQUIRE_EXTERNAL_STORAGE", "LLMR_CONFIG_FILE"):
        monkeypatch.delenv(key, raising=False)


def test_legacy_paths_are_unchanged_and_resolution_has_no_write_side_effects(tmp_path):
    project = tmp_path / "code"
    paths = storage.storage_paths(project_root=project)
    assert paths.database == project / "runtime/app.db"
    assert paths.research_root == project / "runtime/research"
    assert paths.attachments_root == project / "runtime/research-attachments"
    assert paths.upload_root == project / "runtime/uploads"
    assert paths.execution_artifacts == project / "runtime/artifacts"
    assert paths.codex_home == project / "runtime/codex-home"
    assert not project.exists()
    # Existing LLMR_DB_PATH installations used a different evidence location.
    external_db = tmp_path / "external/app.db"
    paths = storage.storage_paths(project_root=project, database_path=external_db)
    assert paths.research_root == external_db.parent / "research"
    assert paths.report_originals == external_db.parent / "report-originals"
    assert paths.upload_root == project / "runtime/uploads"


def test_each_mutable_root_and_dependencies_can_be_outside_code(tmp_path, monkeypatch):
    for name in ("STATE", "UPLOAD", "ARTIFACT", "SANDBOX_STATE", "DATA"):
        monkeypatch.setenv(f"LLMR_{name}_ROOT", str(tmp_path / name.lower()))
    monkeypatch.setenv("LLMR_PYTHON_DEPS", str(tmp_path / "dependencies"))
    monkeypatch.setenv("LLMR_REQUIRE_EXTERNAL_STORAGE", "true")
    paths = storage.storage_paths(project_root=tmp_path / "code")
    storage.validate_external_storage(tmp_path / "code", paths)
    assert paths.database == tmp_path / "state/app.db"
    assert paths.research_root == tmp_path / "artifact/research"
    assert paths.attachments_root == tmp_path / "upload/research-attachments"
    assert paths.report_originals == tmp_path / "state/report-originals"
    assert paths.codex_home == tmp_path / "sandbox_state/codex-home"
    assert paths.python_deps == tmp_path / "dependencies"
    assert not paths.state_root.exists()


def test_read_only_deployment_rejects_a_mutable_path_under_code(tmp_path, monkeypatch):
    monkeypatch.setenv("LLMR_REQUIRE_EXTERNAL_STORAGE", "true")
    with pytest.raises(ValueError, match="outside"):
        storage.validate_external_storage(tmp_path, storage.storage_paths(project_root=tmp_path))


def test_external_config_is_read_without_modifying_or_copying_it(tmp_path, monkeypatch):
    code = tmp_path / "code"
    code.mkdir()
    config = tmp_path / "service.ini"
    config.write_text("[app]\nmodel=fixture-model\n[model_providers.OpenAI]\nbase_url=https://example.invalid\nwire_api=responses\n", encoding="utf-8")
    monkeypatch.setattr(settings, "PROJECT_ROOT", code)
    monkeypatch.setenv("LLMR_CONFIG_FILE", str(config))
    assert settings.llm_settings()["model"] == "fixture-model"
    assert list(code.iterdir()) == []
    assert config.read_text(encoding="utf-8").startswith("[app]")
