from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from threading import RLock
from typing import Literal
from uuid import uuid4

from .db import connect, utc_now
from .settings import PROJECT_ROOT


ArtifactKind = Literal["tool_output", "condition_program", "input_manifest"]
MAX_ARTIFACT_BYTES = 20 * 1024 * 1024
ARTIFACT_ROOT = PROJECT_ROOT / "runtime" / "artifacts"
_ARTIFACT_LOCK = RLock()


class ArtifactError(ValueError):
    pass


def _relative_key(digest: str) -> str:
    return f"screening/{digest[:2]}/{digest}.artifact"


def _resolved_path(root: Path, storage_key: str) -> Path:
    root_resolved = root.resolve()
    target = (root_resolved / Path(storage_key)).resolve()
    if not target.is_relative_to(root_resolved):
        raise ArtifactError("产物存储键越出允许目录")
    return target


def store_artifact(
    conversation_id: str,
    turn_id: str,
    kind: ArtifactKind,
    payload: bytes,
    *,
    root: Path | None = None,
) -> dict[str, object]:
    if not isinstance(payload, bytes) or len(payload) > MAX_ARTIFACT_BYTES:
        raise ArtifactError("产物必须是字节内容且不超过20 MB")
    digest = hashlib.sha256(payload).hexdigest()
    storage_key = _relative_key(digest)
    artifact_root = (root or ARTIFACT_ROOT).resolve()
    target = _resolved_path(artifact_root, storage_key)
    media_type = "text/plain" if kind == "condition_program" else "application/json"

    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        owner = connection.execute(
            """SELECT t.id FROM conversation_turns t
               JOIN conversations c ON c.id=t.conversation_id
               WHERE t.id=? AND t.conversation_id=? AND t.state IN ('awaiting_agent','running')
                 AND c.state='active'""",
            (turn_id, conversation_id),
        ).fetchone()
        if not owner:
            raise ArtifactError("产物只能归属当前活动对话回合")
        existing = connection.execute(
            """SELECT id FROM execution_artifacts
               WHERE conversation_id=? AND turn_id=? AND kind=? AND sha256=?""",
            (conversation_id, turn_id, kind, digest),
        ).fetchone()
        if existing:
            artifact_id = existing[0]
        else:
            with _ARTIFACT_LOCK:
                if target.exists():
                    if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                        raise ArtifactError("已有产物与内容哈希不匹配")
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    temporary: Path | None = None
                    try:
                        with tempfile.NamedTemporaryFile(
                            dir=target.parent, prefix=f"{digest}.", suffix=".tmp", delete=False
                        ) as stream:
                            temporary = Path(stream.name)
                            stream.write(payload)
                            stream.flush()
                            os.fsync(stream.fileno())
                        os.replace(temporary, target)
                        temporary = None
                    finally:
                        if temporary is not None:
                            temporary.unlink(missing_ok=True)
            artifact_id = str(uuid4())
            connection.execute(
                """INSERT INTO execution_artifacts(
                       id,conversation_id,turn_id,kind,sha256,storage_key,media_type,byte_length,created_at
                   ) VALUES(?,?,?,?,?,?,?,?,?)""",
                (
                    artifact_id,
                    conversation_id,
                    turn_id,
                    kind,
                    digest,
                    storage_key,
                    media_type,
                    len(payload),
                    utc_now(),
                ),
            )
    return {
        "artifact_id": artifact_id,
        "kind": kind,
        "sha256": digest,
        "byte_length": len(payload),
        "media_type": media_type,
    }


def read_artifact(
    artifact_id: str,
    conversation_id: str,
    *,
    root: Path | None = None,
) -> tuple[dict[str, object], bytes]:
    with connect() as connection:
        row = connection.execute(
            """SELECT id,conversation_id,turn_id,kind,sha256,storage_key,media_type,byte_length
               FROM execution_artifacts WHERE id=? AND conversation_id=?""",
            (artifact_id, conversation_id),
        ).fetchone()
    if not row:
        raise ArtifactError("找不到当前对话内的产物")
    target = _resolved_path((root or ARTIFACT_ROOT).resolve(), row["storage_key"])
    try:
        payload = target.read_bytes()
    except OSError:
        raise ArtifactError("产物文件不可读取") from None
    if len(payload) != row["byte_length"] or hashlib.sha256(payload).hexdigest() != row["sha256"]:
        raise ArtifactError("产物长度或内容哈希与记录不一致")
    return dict(row), payload


def read_artifact_chunk(
    artifact_id: str,
    conversation_id: str,
    offset: int,
    limit: int = 6000,
    *,
    root: Path | None = None,
) -> dict[str, object]:
    if offset < 0 or not 1 <= limit <= 12000:
        raise ArtifactError("产物分页范围无效")
    metadata, payload = read_artifact(artifact_id, conversation_id, root=root)
    if metadata["media_type"] != "application/json":
        raise ArtifactError("此产物类型不支持JSON分页读取")
    content = payload.decode("utf-8")
    if offset > len(content):
        raise ArtifactError("产物分页偏移超出范围")
    next_offset = min(len(content), offset + limit)
    return {
        "artifact_id": artifact_id,
        "sha256": metadata["sha256"],
        "offset": offset,
        "next_offset": next_offset if next_offset < len(content) else None,
        "complete": next_offset == len(content),
        "content": content[offset:next_offset],
    }
