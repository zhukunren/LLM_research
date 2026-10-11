"""Immutable answer versions and independent research conversation branches."""
from __future__ import annotations

import shutil
from uuid import uuid4

from . import conversation_store as store, research_attachments
from .db import connect, json_dump, json_load, utc_now


def visible_messages(messages):
    """Choose the newest answer version at its original position in the dialogue."""
    result, positions = [], {}
    for message in messages:
        root = message.get("regeneration_of")
        if root and message["role"] == "user":
            continue
        if root and root in positions:
            result[positions[root]] = message
        else:
            positions[message["id"]] = len(result)
            result.append(message)
    return result


def _insert(connection, table, values):
    # Column names come exclusively from our schema/rows, never request input.
    columns = list(values)
    connection.execute(f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
                       tuple(values[column] for column in columns))


def _copy_attachments(connection, origin, target, messages, owned):
    snapshots = [item for message in messages for item in json_load(message["attachments_json"])]
    replacements = {}
    for snapshot in snapshots:
        if snapshot["id"] in replacements:
            continue
        row = connection.execute("SELECT * FROM research_attachments WHERE conversation_id=? AND id=?",
                                 (origin, snapshot["id"])).fetchone()
        if not row or row["sha256"] != snapshot["sha256"]:
            raise store.ConversationConflict("来源附件校验失败，无法创建研究分支")
        copied = dict(row)
        copied.update(id=str(uuid4()), conversation_id=target, request_id="branch:" + row["id"])
        folder = research_attachments._directory(target, create=True)
        for name_key, digest_key in (("stored_name", "sha256"), ("preview_name", "preview_sha256"),
                                     ("model_image_name", "model_image_sha256")):
            if not row[name_key]:
                continue
            source = research_attachments._verified(row, name_key, digest_key)
            destination = folder / row[name_key]
            if destination not in owned:
                owned.append(destination)
                shutil.copyfile(source, destination)
        _insert(connection, "research_attachments", copied)
        replacements[row["id"]] = {**snapshot, **research_attachments.metadata(copied)}
    return replacements


def _turn_for_answer(connection, conversation_id, answer):
    key = answer["client_message_id"] or ""
    if not key.startswith("assistant:"):
        raise store.ConversationStoreError("此历史答复缺少研究回合，无法重新生成")
    turn = connection.execute("SELECT * FROM conversation_turns WHERE conversation_id=? AND id=?",
                              (conversation_id, key.removeprefix("assistant:"))).fetchone()
    if not turn or turn["workflow_type"] != "research":
        raise store.ConversationStoreError("此操作仅支持研究答复")
    return turn


def _result(row, replay):
    return {"conversation_id": row["target_conversation_id"], "turn_id": row["target_turn_id"],
            "kind": row["kind"], "idempotent_replay": replay}


def apply(conversation_id: str, message_id: str, request_id: str, kind: str):
    store.recover_expired_turns()
    owned = []
    try:
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            conversation = connection.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
            if not conversation or conversation["deleted_at"]:
                raise store.ConversationNotFound(conversation_id)
            previous = connection.execute("SELECT * FROM research_answer_actions WHERE source_conversation_id=? AND request_id=?",
                                          (conversation_id, request_id)).fetchone()
            if previous:
                if previous["kind"] != kind or previous["source_message_id"] != message_id:
                    raise store.ConversationConflict("同一请求不能用于不同的答复操作")
                return _result(previous, True)
            if conversation["workflow_type"] != "research":
                raise store.ConversationStoreError("此操作仅支持研究对话")
            store._require_history_idle(connection, conversation_id)
            if kind == "regenerate" and conversation["state"] != "active":
                raise store.ConversationConflict("请先恢复已归档对话，再重新生成")
            rows = [dict(row) for row in connection.execute("SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY rowid", (conversation_id,))]
            answer = next((row for row in rows if row["id"] == message_id and row["role"] == "assistant"), None)
            if not answer:
                raise store.ConversationStoreError("请选择当前对话中的研究答复")
            history = visible_messages(rows)
            root_id = answer["regeneration_of"] or answer["id"]
            index = next((index for index, row in enumerate(history) if (row["regeneration_of"] or row["id"]) == root_id), None)
            if index is None:
                raise store.ConversationStoreError("找不到来源答复的历史位置")
            turn = _turn_for_answer(connection, conversation_id, answer) if kind == "regenerate" else None
            # Earlier answers regenerate in an independent prefix, preserving later research.
            same_conversation = kind == "regenerate" and not any(row["role"] == "user" for row in history[index + 1:])
            now, target = utc_now(), conversation_id if same_conversation else str(uuid4())
            new_turn_id = str(uuid4()) if kind == "regenerate" else None
            if same_conversation:
                question = next(row for row in rows if row["id"] == turn["user_message_id"])
                question_copy = {**question, "id": str(uuid4()), "client_message_id": "regenerate:" + request_id,
                                 "regeneration_of": question["regeneration_of"] or question["id"], "created_at": now}
                _insert(connection, "conversation_messages", question_copy)
                new_turn = {**dict(turn), "id": new_turn_id, "user_message_id": question_copy["id"], "state": "awaiting_agent",
                            "response_text": None, "result_json": "{}", "created_at": now, "updated_at": now}
                _insert(connection, "conversation_turns", new_turn)
                # Start a fresh Codex thread with the chosen dialogue, excluding obsolete answers.
                connection.execute("DELETE FROM codex_threads WHERE conversation_id=?", (target,))
                connection.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now, target))
            else:
                copied_conversation = dict(conversation)
                copied_conversation.update(id=target, state="active", title=((conversation["title"] or "研究对话")[:112] + " · 分支"),
                                           pinned=0, task_revision=0, active_run_id=None, pending_execute_message_id=None,
                                           created_at=now, updated_at=now)
                _insert(connection, "conversations", copied_conversation)
                prefix = history[:index] + ([answer] if kind == "branch" else [])
                replacements = _copy_attachments(connection, conversation_id, target, prefix, owned)
                mapping = {row["id"]: str(uuid4()) for row in prefix}
                copied_turns = {}
                for row_index, row in enumerate(prefix):
                    old_turn = connection.execute("SELECT * FROM conversation_turns WHERE conversation_id=? AND user_message_id=?",
                                                  (conversation_id, row["id"])).fetchone() if row["role"] == "user" else None
                    if row["role"] == "user" and row_index + 1 < len(prefix) and prefix[row_index + 1]["role"] == "assistant":
                        answer_key = prefix[row_index + 1]["client_message_id"] or ""
                        if answer_key.startswith("assistant:"):
                            old_turn = connection.execute("SELECT * FROM conversation_turns WHERE conversation_id=? AND id=?",
                                                          (conversation_id, answer_key[10:])).fetchone()
                    if old_turn:
                        copied_turns[old_turn["id"]] = str(uuid4())
                    key = row["client_message_id"] or ""
                    copied = {**row, "id": mapping[row["id"]], "conversation_id": target, "regeneration_of": None,
                              "client_message_id": "assistant:" + copied_turns[key[10:]] if key.startswith("assistant:") and key[10:] in copied_turns else "branch:" + row["id"],
                              "file_conversation_id": row["file_conversation_id"] or conversation_id,
                              "attachments_json": json_dump([replacements[item["id"]] for item in json_load(row["attachments_json"])])}
                    _insert(connection, "conversation_messages", copied)
                    if row["role"] == "assistant":
                        from .research_sources import collect
                        cached = connection.execute("SELECT evidence_json FROM research_message_evidence WHERE message_id=?", (row["id"],)).fetchone()
                        evidence_json = cached[0] if cached else json_dump(collect(connection, conversation_id,
                            key[10:] if key.startswith("assistant:") else None, row["content"], json_load(row["source_refs_json"]),
                            file_conversation_id=row["file_conversation_id"] or conversation_id))
                        connection.execute("INSERT INTO research_message_evidence(message_id,evidence_json,created_at) VALUES(?,?,?)", (copied["id"], evidence_json, now))
                    if old_turn:
                        _insert(connection, "conversation_turns", {**dict(old_turn), "id": copied_turns[old_turn["id"]], "conversation_id": target,
                                "user_message_id": copied["id"], "base_revision": 0,
                                "attachments_json": copied["attachments_json"]})
                if kind == "regenerate":
                    source_question = next(row for row in rows if row["id"] == turn["user_message_id"])
                    root_question = source_question["regeneration_of"] or source_question["id"]
                    question_id = mapping[root_question]
                    # The copied question's completed turn is replaced only in the new branch.
                    connection.execute("DELETE FROM conversation_turns WHERE conversation_id=? AND user_message_id=?", (target, question_id))
                    _insert(connection, "conversation_turns", {**dict(turn), "id": new_turn_id, "conversation_id": target,
                            "user_message_id": question_id, "base_revision": 0, "state": "awaiting_agent", "response_text": None,
                            "result_json": "{}", "created_at": now, "updated_at": now,
                            "attachments_json": json_dump([replacements[item["id"]] for item in json_load(turn["attachments_json"])])})
            action = {"source_conversation_id": conversation_id, "request_id": request_id, "kind": kind,
                      "source_message_id": message_id, "target_conversation_id": target, "target_turn_id": new_turn_id, "created_at": now}
            _insert(connection, "research_answer_actions", action)
            return _result(action, False)
    except Exception:
        for path in owned:
            path.unlink(missing_ok=True)
        raise
