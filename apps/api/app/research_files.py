"""Original user deliverables, kept separate from branded PDF rendering."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import conversation_store, db, research_workspace


MEDIA_TYPES = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json",
    ".txt": "text/plain", ".md": "text/markdown", ".pdf": "application/pdf",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp",
}
PRIVATE_NAMES = {
    "research-inputs.json", "research.md", "config.json", "credentials.json", "secrets.json", "auth.json",
    "package.json", "package-lock.json", "node_modules", "inputs", "sources", "tmp", "__pycache__",
}
PRIVATE_STEMS = {"config", "credentials", "credential", "secrets", "secret", "auth", "api_key", "api-key",
                 "apikey", "access_token", "refresh_token", "token", "stdout", "stderr"}


class GeneratedFileError(ValueError):
    pass


def _linked(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def _parts(relative: str) -> list[str]:
    parts = relative.split("/")
    if (not relative or "\\" in relative or ":" in relative
            or any(ord(char) < 32 or ord(char) == 127 for char in relative)
            or any(not part or part in {".", ".."} or part.startswith(".")
                   or part.lower() in PRIVATE_NAMES or Path(part).stem.lower() in PRIVATE_STEMS
                   or part.endswith((".", " ")) for part in parts)
            or Path(parts[-1]).suffix.lower() not in MEDIA_TYPES):
        raise GeneratedFileError("此文件不能下载")
    return parts


def _outputs_root(conversation_id: str) -> Path:
    # directory() validates the identifier. Check every workspace component as
    # well: a conversation/work link to a sibling conversation is still a leak.
    research_workspace.directory(conversation_id)
    research_root = db.DB_PATH.parent.resolve() / "research"
    root = research_root / conversation_id / "work" / "outputs"
    for path in (research_root, research_root / conversation_id, root.parent, root):
        if _linked(path):
            raise GeneratedFileError("成果目录不可用")
    return root


def generated_file_path(conversation_id: str, relative: str) -> Path:
    parts = _parts(relative)
    root = _outputs_root(conversation_id)
    candidate = root.joinpath(*parts)
    current = root
    for part in parts:
        current = current / part
        if _linked(current):
            raise GeneratedFileError("成果文件不能使用链接")
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise GeneratedFileError("成果路径越界")
    # Reuse the existing hard-link, regular-file and configured size checks.
    target = research_workspace.output_path(conversation_id, relative)
    if target != candidate.resolve():
        raise GeneratedFileError("成果路径越界")
    return target


def list_generated_files(conversation_id: str) -> list[dict[str, Any]]:
    conversation_store.get_conversation(conversation_id, message_limit=1)
    root = _outputs_root(conversation_id)
    if not root.is_dir():
        return []
    items = []
    for current, directories, filenames in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories if not name.startswith(".")
                          and name.lower() not in PRIVATE_NAMES and not _linked(Path(current) / name)]
        for name in filenames:
            relative = (Path(current) / name).relative_to(root).as_posix()
            try:
                path = generated_file_path(conversation_id, relative)
                stat = path.stat()
            except (GeneratedFileError, research_workspace.WorkspaceError, OSError, ValueError):
                continue
            items.append({
                "name": relative, "bytes": stat.st_size, "modified_at": stat.st_mtime,
                "file_type": path.suffix.lower().lstrip("."), "media_type": MEDIA_TYPES[path.suffix.lower()],
                "conversation_id": conversation_id,
                "url": f"/api/v1/conversations/{quote(conversation_id, safe='')}/generated-files/{quote(relative, safe='/')}",
            })
    return sorted(items, key=lambda item: (-item["modified_at"], item["name"]))
