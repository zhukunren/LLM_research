"""Recover answer-specific evidence from final text, linked reports and completed reads."""
from __future__ import annotations

import json
import re
from urllib.parse import unquote, urlsplit

import mistune

from . import research_files
from .db import connect, json_dump, json_load, utc_now

_markdown = mistune.create_markdown(renderer="ast", plugins=["url"])
_READ_TOOLS = {"read_research_source", "read_report_page", "read_news_chunk", "read_artifact_chunk",
               "read_evidence_chunk", "capture_research_page", "download_research_source"}


def markdown_links(content: str):
    def plain(nodes):
        return "".join(node.get("raw", "") + plain(node.get("children", [])) for node in nodes)
    def walk(nodes):
        for node in nodes:
            if node["type"] == "link":
                yield plain(node.get("children", [])), node.get("attrs", {}).get("url", "")
            elif node["type"] not in {"block_code", "codespan", "image"}:
                yield from walk(node.get("children", []))
    parsed = list(walk(_markdown(content)))
    # Some Mistune versions stop an inline destination at its first closing
    # parenthesis. Recover bounded balanced destinations before deduplicating.
    body = re.sub(r"```[\s\S]*?```|`[^`\n]*`", "", content)
    explicit = [(match[1], match[2]) for match in re.finditer(r"(?<!!)\[([^\]\n]+)\]\(\s*((?:[^\s()]|\([^()]*\))+)(?:\s+[\"'][^\"']*[\"'])?\s*\)", body)]
    return explicit + [(title, url) for title, url in parsed if not any(other_url == url or other_url.startswith(url + ')') for _, other_url in explicit)]


def _web_url(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return None
        return value
    except ValueError:
        return None


def _result(item):
    result = item.get("result") or {}
    if not isinstance(result, dict):
        return {}
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        return structured.get("result", structured)
    for block in result.get("content", []):
        if block.get("type") != "text":
            continue
        try:
            value = json.loads(block["text"])
            if isinstance(value, dict) and value.get("ok") is not False:
                return value.get("result", value)
        except (ValueError, KeyError):
            pass
    return {}


def _public_reference(value, relation="cited"):
    if not isinstance(value, dict):
        return None
    url = _web_url(value.get("url") or value.get("source_url"))
    kind = value.get("kind")
    if not url and (kind not in {"report_page", "news_item", "security"} or not value.get("source_id")):
        return None
    ref = {key: value[key] for key in ("kind", "source_id", "page_number", "title", "stock_code", "stock_codes",
            "published_at", "available_at", "security_binding_status") if key in value}
    ref.update(relation=relation)
    if url:
        ref.update(kind="web", url=url, title=str(value.get("title") or urlsplit(url).hostname))
    excerpt = value.get("excerpt") or value.get("text") or value.get("body") or value.get("snippet")
    if isinstance(excerpt, str):
        if not re.fullmatch(r"Total lines:\s*\d+", excerpt.strip()):
            ref["excerpt"] = excerpt[:20000]
            ref["excerpt_kind"] = value.get("excerpt_kind") or ("search_snippet" if excerpt == value.get("snippet") else "original_text")
    return ref


def collect(connection, conversation_id: str, turn_id: str | None, content: str, references=None, *, file_conversation_id=None):
    origin = file_conversation_id or conversation_id
    sources, files, seen = [], [], set()
    def add(value, relation="cited"):
        ref = _public_reference(value, relation)
        if not ref:
            return
        key = ref.get("url") or f"{ref.get('kind')}:{ref.get('source_id')}:{ref.get('page_number', '')}"
        if key in seen:
            existing = next(entry for entry in sources if (entry.get("url") or f"{entry.get('kind')}:{entry.get('source_id')}:{entry.get('page_number', '')}") == key)
            if ref.get("excerpt") and (not existing.get("excerpt") or existing.get("excerpt_kind") == "search_snippet" and ref.get("excerpt_kind") == "original_text"):
                existing["excerpt"] = ref["excerpt"]
                existing["excerpt_kind"] = ref["excerpt_kind"]
            return
        seen.add(key); sources.append(ref)
    for ref in references or []:
        add(ref)
    texts = [content]
    for title, url in markdown_links(content):
        if _web_url(url):
            add({"url": url, "title": title})
            continue
        relative = None
        normalized = url.replace("\\", "/")
        for prefix in ("outputs/", "./outputs/", f"/api/v1/conversations/{origin}/generated-files/",
                       f"/api/v1/conversations/{origin}/research-files/"):
            if normalized.startswith(prefix):
                relative = unquote(normalized[len(prefix):]); break
        absolute_prefix = f"/research/{origin}/work/outputs/"
        if relative is None and absolute_prefix in normalized and (normalized.startswith(('/', 'file:', 'sandbox:')) or re.match(r"^[a-zA-Z]:/", normalized)):
            relative = unquote(normalized.split(absolute_prefix, 1)[1])
        if not relative or not relative.lower().endswith((".md", ".txt")) or len(files) >= 12:
            continue
        try:
            path = research_files.generated_file_path(origin, relative)
            if path.stat().st_size > 1024 * 1024:
                continue
            body = path.read_text(encoding="utf-8-sig")
        except (OSError, ValueError, UnicodeError):
            continue
        if any(file["path"] == relative for file in files):
            continue
        files.append({"id": f"report-{len(files)}", "title": title or path.name, "path": relative, "content": body})
        texts.append(body)
    for text in texts:
        for title, url in markdown_links(text):
            if _web_url(url):
                add({"title": title, "url": url})
    joined = "\n".join(texts)
    if turn_id:
        for row in connection.execute("SELECT payload_json FROM codex_turn_events WHERE conversation_id=? AND app_turn_id=? AND method='item/completed' ORDER BY sequence", (origin, turn_id)):
            item = json_load(row[0]).get("item") or {}
            item_type = re.sub(r"[^a-z]", "", str(item.get("type", "")).lower())
            if item_type in {"websearch", "websearchcall"}:
                action = item.get("action") or {}
                for value in item.get("results") or []:
                    if not isinstance(value, dict):
                        continue
                    ref_id = value.get("ref_id", "")
                    cited = bool(ref_id and ref_id in joined) or value.get("url") in seen
                    read = bool(re.search(r"turn\d+view\d+", ref_id)) or action.get("type") in {"openPage", "open_page", "findInPage", "find_in_page"}
                    if cited or read:
                        add(value, "cited" if cited else "consulted")
                if action.get("url"):
                    add({"url": action["url"], "title": action["url"]}, "consulted")
            elif item_type == "mcptoolcall" and item.get("tool") in _READ_TOOLS and item.get("status") not in {"failed", "cancelled"} and not item.get("error"):
                value = _result(item)
                if not isinstance(value, dict):
                    continue
                args = item.get("arguments") or {}
                if isinstance(args, str):
                    try: args = json.loads(args)
                    except ValueError: args = {}
                if item.get("tool") in {"read_research_source", "read_report_page", "read_news_chunk", "read_evidence_chunk"}:
                    kind = "news_item" if args.get("kind") == "news" or item.get("tool") == "read_news_chunk" else "report_page"
                    value = {**value, "kind": kind, "source_id": value.get("source_id") or args.get("source_id") or args.get("document_id")}
                add(value, "consulted")
            elif item_type == "agentmessage" and item.get("phase") == "final_answer":
                for annotation in item.get("annotations") or []:
                    if isinstance(annotation, dict):
                        add(annotation.get("url_citation", annotation))
    return {"items": sources[:100], "files": files}


def answer_evidence(conversation_id: str, message_id: str):
    from .conversation_store import ConversationNotFound, ConversationStoreError
    with connect() as connection:
        message = connection.execute("""SELECT m.* FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id
            WHERE m.id=? AND m.conversation_id=? AND c.deleted_at IS NULL""", (message_id, conversation_id)).fetchone()
        if not message:
            raise ConversationNotFound(message_id)
        if message["role"] != "assistant":
            raise ConversationStoreError("请选择研究答复查看来源")
        previous = connection.execute("SELECT evidence_json FROM research_message_evidence WHERE message_id=?", (message_id,)).fetchone()
        if previous:
            return json_load(previous[0])
        origin = message["file_conversation_id"] or conversation_id
        key = message["client_message_id"] or ""
        turn_id = key[10:] if key.startswith("assistant:") else None
        evidence = collect(connection, conversation_id, turn_id, message["content"], json_load(message["source_refs_json"]), file_conversation_id=origin)
        connection.execute("INSERT INTO research_message_evidence(message_id,evidence_json,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING", (message_id, json_dump(evidence), utc_now()))
        return evidence
