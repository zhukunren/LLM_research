"""Publish only a deliberately selected, immutable conversation prefix."""
from __future__ import annotations

import json
import os
import secrets
from urllib.parse import unquote, urlsplit
from uuid import uuid4

import requests

from . import conversation_store as store, research_sources
from .db import connect, json_dump, json_load, utc_now
from .research_answer_actions import visible_messages
from .settings import PROJECT_ROOT


class ShareUnavailable(ValueError):
    pass


def service_settings():
    settings = {}
    config = PROJECT_ROOT / "runtime" / "share-service.json"
    if config.is_file():
        try:
            settings = json.loads(config.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            pass
    url = (os.environ.get("LLMR_SHARE_SERVICE_URL") or settings.get("public_url") or "").rstrip("/")
    key = os.environ.get("LLMR_SHARE_SERVICE_KEY") or settings.get("api_key") or ""
    parsed = urlsplit(url)
    if not url or not key or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise ShareUnavailable("公开分享服务尚未配置，暂时不能创建跨设备链接。")
    return url, key


def _snapshot(conversation_id, message_id):
    with connect() as connection:
        conversation = connection.execute("SELECT * FROM conversations WHERE id=? AND deleted_at IS NULL", (conversation_id,)).fetchone()
        if not conversation:
            raise store.ConversationNotFound(conversation_id)
        rows = [dict(row) for row in connection.execute("SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY rowid", (conversation_id,))]
    answer = next((row for row in rows if row["id"] == message_id and row["role"] == "assistant"), None)
    if not answer:
        raise store.ConversationStoreError("请选择要分享的研究答复")
    root = answer["regeneration_of"] or answer["id"]
    history = visible_messages(rows)
    index = next((index for index, row in enumerate(history) if (row["regeneration_of"] or row["id"]) == root), None)
    if index is None:
        raise store.ConversationStoreError("找不到所选答复的历史位置")
    prefix = history[:index] + [answer]
    messages, files = [], []
    for row in prefix:
        if row["role"] not in {"user", "assistant"}:
            continue
        evidence = research_sources.answer_evidence(conversation_id, row["id"]) if row["role"] == "assistant" else {"items": [], "files": []}
        # Freeze local excerpts, so recipients never call the owner's private API.
        sources = []
        with connect() as connection:
            for source in evidence["items"]:
                ref = dict(source)
                if ref.get("kind") == "report_page" and not ref.get("excerpt"):
                    page = connection.execute("SELECT text FROM document_pages WHERE document_id=? AND page_number=?", (ref.get("source_id"), ref.get("page_number", 1))).fetchone()
                    if page: ref["excerpt"] = page[0][:20000]
                elif ref.get("kind") == "news_item" and not ref.get("excerpt"):
                    news = connection.execute("SELECT body FROM news_records WHERE id=?", (ref.get("source_id"),)).fetchone()
                    if news: ref["excerpt"] = news[0][:20000]
                sources.append(ref)
        content = row["content"]
        for file in evidence["files"]:
            shared_id = f"file-{len(files)}"
            files.append({"id": shared_id, "title": file["title"], "content": file["content"]})
            for _, url in research_sources.markdown_links(content):
                if file["path"] in unquote(url):
                    content = content.replace(url, "#" + shared_id)
        messages.append({"id": row["id"], "role": row["role"], "content": content, "sources": sources, "created_at": row["created_at"]})
    title = conversation["title"] or next((row["content"][:120] for row in prefix if row["role"] == "user"), "研究对话")
    return {"schema_version": 1, "title": title, "messages": messages, "files": files, "created_at": utc_now(), "cutoff_at": answer["created_at"]}


def share_info(conversation_id, message_id):
    store.get_conversation(conversation_id, message_limit=1)
    try:
        service_settings(); configured = True
    except ShareUnavailable:
        configured = False
    with connect() as connection:
        row = connection.execute("SELECT id,public_url,created_at FROM research_conversation_shares WHERE conversation_id=? AND message_id=? AND state='published' ORDER BY rowid DESC LIMIT 1", (conversation_id, message_id)).fetchone()
    return {"configured": configured, "share": {"id": row["id"], "url": row["public_url"], "created_at": row["created_at"]} if row else None}


def publish(conversation_id, message_id, request_id):
    service_url, api_key = service_settings()
    store.get_conversation(conversation_id, message_limit=1)
    with connect() as connection:
        previous = connection.execute("SELECT * FROM research_conversation_shares WHERE conversation_id=? AND request_id=?", (conversation_id, request_id)).fetchone()
    if previous and previous["message_id"] != message_id:
        raise store.ConversationConflict("同一分享请求不能用于不同的答复")
    if not previous:
        snapshot = _snapshot(conversation_id, message_id)
        if len(json_dump(snapshot).encode()) > 3 * 1024 * 1024:
            raise store.ConversationStoreError("对话及来源超过分享大小上限（3 MB），请选更早的答复分享。")
        with connect() as connection:
            connection.execute("INSERT INTO research_conversation_shares(id,conversation_id,message_id,request_id,token,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                (str(uuid4()), conversation_id, message_id, request_id, secrets.token_urlsafe(32), json_dump(snapshot), utc_now()))
            previous = connection.execute("SELECT * FROM research_conversation_shares WHERE conversation_id=? AND request_id=?", (conversation_id, request_id)).fetchone()
    if previous["message_id"] != message_id:
        raise store.ConversationConflict("同一分享请求不能用于不同的答复")
    if previous["state"] == "revoked":
        raise store.ConversationConflict("此分享已撤销，请重新创建链接")
    if previous["state"] != "published":
        try:
            response = requests.post(service_url + "/api/shares", headers={"Authorization": "Bearer " + api_key},
                json={"token": previous["token"], "snapshot": json_load(previous["snapshot_json"])}, timeout=(10, 45), allow_redirects=False)
            if response.status_code not in {200, 201}:
                raise ShareUnavailable("公开分享服务暂未接受快照，请重试。")
            url = response.json().get("url")
            expected = service_url + "/s/" + previous["token"]
            if url != expected:
                raise ShareUnavailable("分享服务返回的链接未通过校验，请重试。")
        except (requests.RequestException, ValueError) as exc:
            raise ShareUnavailable("暂时无法连接公开分享服务，快照已保留，可以重试。") from exc
        with connect() as connection:
            connection.execute("UPDATE research_conversation_shares SET state='published',public_url=? WHERE id=? AND state='pending'", (url, previous["id"]))
    return {"id": previous["id"], "url": previous["public_url"] or service_url + "/s/" + previous["token"], "created_at": previous["created_at"]}


def revoke(conversation_id, share_id):
    store.get_conversation(conversation_id, message_limit=1)
    service_url, api_key = service_settings()
    with connect() as connection:
        row = connection.execute("SELECT * FROM research_conversation_shares WHERE id=? AND conversation_id=?", (share_id, conversation_id)).fetchone()
    if not row:
        raise store.ConversationNotFound(share_id)
    if row["state"] != "revoked":
        try:
            response = requests.delete(service_url + "/api/shares/" + row["token"], headers={"Authorization": "Bearer " + api_key}, timeout=(10, 30), allow_redirects=False)
            if response.status_code not in {200, 204, 404}:
                raise ShareUnavailable("撤销分享暂未成功，请重试。")
        except requests.RequestException as exc:
            raise ShareUnavailable("暂时无法连接公开分享服务，请重试撤销。") from exc
        with connect() as connection:
            connection.execute("UPDATE research_conversation_shares SET state='revoked' WHERE id=?", (share_id,))
    return {"revoked": True}
