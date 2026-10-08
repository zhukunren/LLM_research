from io import BytesIO
import os
from pathlib import Path
from urllib.parse import quote, unquote
from zipfile import ZipFile

from fastapi.testclient import TestClient
import pytest

from apps.api.app import conversation_store, db, main, research_files, research_models, research_workspace


@pytest.fixture
def generated(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "files.db")
    monkeypatch.setattr(research_models, "llm_settings", lambda: {"configured": False, "model": "gpt-6-luna", "reasoning_effort": "high"})
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "free", "allowed_models": [], "reasoning_efforts": {}})
    db.init_db()
    cid = conversation_store.create_conversation("screening", workflow_type="research")["id"]
    root = research_workspace.directory(cid) / "outputs"
    root.mkdir(parents=True)
    with TestClient(main.app) as client:
        yield client, cid, root


def office_bytes(part: str) -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr(part, '<?xml version="1.0"?><document>生成成果内容</document>')
    return buffer.getvalue()


@pytest.mark.parametrize("name,data,mime", [
    ("数据表/公司 比较.xlsx", office_bytes("xl/workbook.xml"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ("研究结论.docx", office_bytes("word/document.xml"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ("行业简报.pptx", office_bytes("ppt/presentation.xml"), "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ("增长20%.csv", "公司,收入\r\n示例,120\r\n".encode("utf-8-sig"), "text/csv"),
    ("evidence.json", '{"来源":"原文"}'.encode("utf-8"), "application/json"),
    ("说明.txt", "研究记录\n原始正文".encode("utf-8"), "text/plain"),
    ("notes.md", "# 分析\n\n保留正文".encode("utf-8"), "text/markdown"),
    ("report.pdf", b"%PDF-1.4\noriginal-pdf-bytes\n%%EOF", "application/pdf"),
    ("chart.png", b"\x89PNG\r\n\x1a\noriginal-image-bytes", "image/png"),
], ids=["xlsx", "docx", "pptx", "csv", "json", "txt", "markdown", "pdf", "png"])
def test_original_download_preserves_bytes_mime_and_unicode_filename(generated, name, data, mime):
    client, cid, root = generated
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    listing = client.get(f"/api/v1/conversations/{cid}/generated-files")
    assert listing.status_code == 200
    item, = listing.json()["items"]
    assert listing.json()["format"] == "original"
    assert item["name"] == name and item["bytes"] == len(data)
    assert item["file_type"] == target.suffix[1:] and item["media_type"] == mime
    assert item["conversation_id"] == cid and "turn_id" not in item
    assert item["url"].endswith(quote(name, safe="/"))
    assert str(root) not in str(item)
    downloaded = client.get(item["url"])
    assert downloaded.status_code == 200
    assert downloaded.content == data
    assert downloaded.headers["content-type"].split(";")[0] == mime
    assert downloaded.headers["content-disposition"].startswith("attachment;")
    assert target.name in unquote(downloaded.headers["content-disposition"])
    assert downloaded.headers["x-content-type-options"] == "nosniff"
    assert downloaded.headers["cache-control"] == "no-store"
    # Reads never create a PDF rendering job or alter the original deliverable.
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert target.read_bytes() == data


def test_lists_only_safe_outputs_and_keeps_other_conversations_private(generated):
    client, cid, root = generated
    (root / "download.csv").write_text("number\n1\n", encoding="utf-8")
    excluded = ["page.html", "script.js", "chart.svg", "private.sqlite", "app.db", "config.ini",
                "credentials.json", "config.json", "auth.txt", "api_key.txt", "research-inputs.json", "RESEARCH.md",
                ".hidden.txt", ".assistant-skills/export.txt", "sources/original.pdf", "tmp/debug.txt"]
    for relative in excluded:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("PRIVATE", encoding="utf-8")
    for relative in excluded:
        assert client.get(f"/api/v1/conversations/{cid}/generated-files/{quote(relative, safe='/')}").status_code == 404
    assert [item["name"] for item in client.get(f"/api/v1/conversations/{cid}/generated-files").json()["items"]] == ["download.csv"]
    other = conversation_store.create_conversation("screening", workflow_type="research")["id"]
    assert client.get(f"/api/v1/conversations/{other}/generated-files").json()["items"] == []
    assert client.get(f"/api/v1/conversations/{other}/generated-files/download.csv").status_code == 404
    assert client.get("/api/v1/conversations/missing/generated-files").status_code == 404
    assert client.get("/api/v1/conversations/missing/generated-files/download.csv").status_code == 404


@pytest.mark.parametrize("relative", ["../secret.txt", "../../files.db", "a/../data.csv", "/tmp/data.csv", "C:/data.csv",
                                     "folder\\secret.txt", "data.txt:private", "a//data.csv", "bad\nname.csv", "data.csv."])
def test_rejects_traversal_absolute_paths_alternate_streams_and_control_characters(generated, relative):
    _, cid, _ = generated
    with pytest.raises(research_files.GeneratedFileError):
        research_files.generated_file_path(cid, relative)


def test_api_rejects_encoded_traversal_and_oversize_outputs(generated, monkeypatch):
    client, cid, root = generated
    monkeypatch.setenv("LLMR_RESEARCH_MAX_OUTPUT_FILE_BYTES", "1024")
    (root / "too-big.csv").write_bytes(b"x" * 2048)
    assert client.get(f"/api/v1/conversations/{cid}/generated-files/too-big.csv").status_code == 404
    assert client.get(f"/api/v1/conversations/{cid}/generated-files/%2e%2e/research-inputs.json").status_code == 404
    assert client.get(f"/api/v1/conversations/{cid}/generated-files/..%5csecret.txt").status_code == 404
    assert client.get(f"/api/v1/conversations/{cid}/generated-files").json()["items"] == []


def test_rejects_hardlinks_without_listing_private_bytes(generated, tmp_path):
    client, cid, root = generated
    private = tmp_path / "private.txt"
    private.write_text("PRIVATE", encoding="utf-8")
    try:
        os.link(private, root / "linked.txt")
    except OSError as error:
        pytest.skip(f"hardlinks are unavailable: {error}")
    assert client.get(f"/api/v1/conversations/{cid}/generated-files/linked.txt").status_code == 404
    assert client.get(f"/api/v1/conversations/{cid}/generated-files").json()["items"] == []


@pytest.mark.parametrize("location", ["file", "nested", "outputs", "work", "conversation"])
def test_rejects_symlinks_at_every_workspace_boundary(generated, tmp_path, location):
    client, cid, root = generated
    outside = tmp_path / "other-conversation"
    destination = outside / "work" / "outputs"
    destination.mkdir(parents=True)
    (destination / "private.txt").write_text("PRIVATE", encoding="utf-8")
    if location == "file":
        link, target, relative = root / "linked.txt", destination / "private.txt", "linked.txt"
    elif location == "nested":
        link, target, relative = root / "nested", destination, "nested/private.txt"
    elif location == "outputs":
        link, target, relative = root, destination, "private.txt"
    elif location == "work":
        root.rmdir()
        link, target, relative = root.parent, outside / "work", "private.txt"
    else:
        root.rmdir()
        root.parent.rmdir()
        link, target, relative = root.parent.parent, outside, "private.txt"
    if link.exists():
        link.rmdir()
    try:
        link.symlink_to(target, target_is_directory=location != "file")
    except OSError as error:
        if os.name == "nt" and location != "file":
            import _winapi
            _winapi.CreateJunction(str(target), str(link))
        else:
            pytest.skip(f"symlinks are unavailable: {error}")
    response = client.get(f"/api/v1/conversations/{cid}/generated-files/{relative}")
    assert response.status_code == 404 and b"PRIVATE" not in response.content
    listing = client.get(f"/api/v1/conversations/{cid}/generated-files")
    assert listing.status_code == 404 or listing.json()["items"] == []
