"""Recover answer-specific evidence from final text, linked reports and completed reads."""
from __future__ import annotations

import json
import re
from urllib.parse import quote, unquote, urlsplit

import mistune

from . import research_files
from .db import connect, json_dump, json_load, utc_now

_markdown = mistune.create_markdown(renderer="ast", plugins=["url"])
_READ_TOOLS = {"read_research_source", "read_report_page", "read_news_chunk", "read_artifact_chunk",
               "read_evidence_chunk", "capture_research_page", "download_research_source", "read_financial_evidence", "read_disclosure"}


def rewrite_local_citations(content: str, references: list[dict]) -> str:
    """Resolve bare source IDs only from the answer's recorded report-page evidence."""
    pages = {}
    for reference in references:
        if reference.get("kind") == "report_page" and reference.get("source_id") and type(reference.get("page_number")) is int and reference["page_number"] > 0:
            pages.setdefault(str(reference["source_id"]), set()).add(reference["page_number"])
    def replace(match):
        source_id = match.group("source")
        if source_id not in pages:
            return match[0]
        requested = match.group("page") or (re.search(r"第\s*(\d+)", match.group("title")) or [None, None])[1]
        page = int(requested) if requested and int(requested) in pages[source_id] else min(pages[source_id])
        return f'[{match.group("title")}](/api/v1/documents/{quote(source_id, safe="")}/pdf#page={page})'
    pattern = re.compile(r'```[\s\S]*?```|`[^`\n]*`|(?<!!)\[(?P<title>[^\]\n]+)\]\((?P<source>[A-Za-z0-9_-]{1,100})(?:#page=(?P<page>\d+))?\)')
    return pattern.sub(lambda match: replace(match) if match.group("source") else match[0], content)


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


def _source_type(kind, url):
    if url:
        return "public_web"
    return {
        "report_page": "local_report",
        "news_item": "local_news",
        "financial": "financial_record",
        "disclosure": "disclosure_record",
        "security": "security_reference",
    }.get(kind, "local_source")


def _evidence_status(reference):
    excerpt_kind = reference.get("excerpt_kind")
    if excerpt_kind in {"original_text", "frozen_financial"}:
        return excerpt_kind
    if excerpt_kind == "search_snippet":
        return "search_snippet"
    if reference.get("excerpt"):
        return "excerpt"
    return "citation_only"


def _public_reference(value, relation="cited", recorded_at=None):
    if not isinstance(value, dict):
        return None
    url = _web_url(value.get("url") or value.get("source_url"))
    kind = value.get("kind")
    if kind in {"financial", "disclosure"} and value.get("source_id"):
        from . import financial_evidence
        try:
            ref = {**financial_evidence.public_reference(value["source_id"]), "relation": relation}
            ref["source_type"] = "financial_record" if kind == "financial" else "disclosure_record"
            ref["recorded_at"] = recorded_at or utc_now()
            ref["evidence_status"] = _evidence_status(ref)
            return ref
        except financial_evidence.EvidenceError:
            return None
    if not url and (kind not in {"report_page", "news_item", "security"} or not value.get("source_id")):
        return None
    ref = {key: value[key] for key in ("kind", "source_id", "page_number", "title", "stock_code", "stock_codes",
            "published_at", "publication_date", "published_date", "publisher_declared_date", "available_at",
            "retrieved_at", "publisher", "requested_url", "original_source_id", "sha256", "source_version",
            "security_binding_status", "research_as_of", "historical_availability_verified", "start_index",
            "end_index", "ref_id", "locator") if key in value}
    if type(ref.get("start_index")) is int and type(ref.get("end_index")) is int:
        ref["citation_span"] = {"start": ref["start_index"], "end": ref["end_index"]}
    ref.update(relation=relation)
    if url:
        ref.update(kind="web", url=url, title=str(value.get("title") or urlsplit(url).hostname), domain=urlsplit(url).hostname)
    if not ref.get("published_at"):
        ref["published_at"] = value.get("publication_date") or value.get("published_date") or value.get("publisher_declared_date")
    excerpt = value.get("excerpt") or value.get("text") or value.get("body") or value.get("text_preview") or value.get("snippet")
    if isinstance(excerpt, str):
        if not re.fullmatch(r"Total lines:\s*\d+", excerpt.strip()):
            ref["excerpt"] = excerpt[:20000]
            ref["excerpt_kind"] = value.get("excerpt_kind") or ("search_snippet" if excerpt == value.get("snippet") else "original_text")
    ref["source_type"] = _source_type(kind, url)
    ref["recorded_at"] = value.get("recorded_at") or recorded_at or utc_now()
    ref["evidence_status"] = _evidence_status(ref)
    return ref


def collect(connection, conversation_id: str, turn_id: str | None, content: str, references=None, *, file_conversation_id=None):
    origin = file_conversation_id or conversation_id
    sources, files, seen = [], [], {}
    def add(value, relation="cited"):
        ref = _public_reference(value, relation)
        if not ref:
            return
        key = ref.get("url") or f"{ref.get('kind')}:{ref.get('source_id')}:{ref.get('page_number', '')}"
        if key in seen:
            existing = sources[seen[key]]
            if relation == "cited":
                existing["relation"] = "cited"
            elif existing.get("relation") != "cited":
                existing["relation"] = "consulted"
            rank = {"citation_only": 0, "search_snippet": 1, "excerpt": 2, "original_text": 3, "frozen_financial": 3}
            if rank.get(ref.get("evidence_status"), 0) > rank.get(existing.get("evidence_status"), 0):
                for name in ("excerpt", "excerpt_kind", "evidence_status"):
                    if name in ref:
                        existing[name] = ref[name]
            for name, item in ref.items():
                if existing.get(name) in (None, "") and item not in (None, ""):
                    existing[name] = item
            return
        seen[key] = len(sources)
        sources.append(ref)
    for ref in references or []:
        add(ref)
    texts = [content]
    for title, url in markdown_links(content):
        numeric = re.fullmatch(r"/api/v1/research-evidence/([a-f0-9]{64})(?:/view)?", url)
        if numeric:
            from . import financial_evidence
            try:
                add(financial_evidence.public_reference(numeric[1]))
            except financial_evidence.EvidenceError:
                pass
            continue
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
            elif (numeric := re.fullmatch(r"/api/v1/research-evidence/([a-f0-9]{64})(?:/view)?", url)):
                from . import financial_evidence
                try:
                    add(financial_evidence.public_reference(numeric[1]))
                except financial_evidence.EvidenceError:
                    pass
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
                if item.get("tool") in {"read_financial_evidence", "read_disclosure"}:
                    add(value.get("reference", {}), "consulted")
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
    return {"schema_version": 2, "items": sources[:100], "files": files}


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
            cached = json_load(previous[0])
            if isinstance(cached, dict) and cached.get("schema_version") == 2:
                return cached
        origin = message["file_conversation_id"] or conversation_id
        key = message["client_message_id"] or ""
        turn_id = key[10:] if key.startswith("assistant:") else None
        evidence = collect(connection, conversation_id, turn_id, message["content"], json_load(message["source_refs_json"]), file_conversation_id=origin)
        connection.execute("INSERT INTO research_message_evidence(message_id,evidence_json,created_at) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET evidence_json=excluded.evidence_json,created_at=excluded.created_at", (message_id, json_dump(evidence), utc_now()))
        return evidence
