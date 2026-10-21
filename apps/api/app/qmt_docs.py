"""Versioned, offline QMT reference library and bounded model-facing retrieval."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import unicodedata

from pydantic import Field

from .db import connect, json_load
from .models import StrictModel


REFERENCE_ROOT = Path(__file__).parent / "assets" / "qmt"


class QmtReferenceError(ValueError):
    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status


class SearchQmtDocsArgs(StrictModel):
    query: str = Field(default="", max_length=300)
    kind: str = Field(default="all", pattern=r"^(all|official_reference|manual|example)$")
    offset: int = Field(default=0, ge=0, le=10000)
    limit: int = Field(default=6, ge=1, le=12)


class ReadQmtDocArgs(StrictModel):
    doc_id: str = Field(pattern=r"^[a-z][a-z0-9-]{0,79}$")
    offset: int = Field(default=0, ge=0, le=100000)
    limit: int = Field(default=6000, ge=1, le=8000)
    expected_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


def _file(relative: str) -> Path:
    parts = relative.split("/")
    if (not parts or any(not part or part.startswith(".") or "\\" in part or ":" in part for part in parts)
            or Path(relative).suffix not in {".json", ".md", ".py"}):
        raise QmtReferenceError("QMT 资料路径无效。")
    target = REFERENCE_ROOT.joinpath(*parts)
    if REFERENCE_ROOT.is_symlink() or getattr(REFERENCE_ROOT, "is_junction", lambda: False)():
        raise QmtReferenceError("QMT 资料不能使用目录链接。")
    current = REFERENCE_ROOT
    for part in parts:
        current = current / part
        if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
            raise QmtReferenceError("QMT 资料不能使用链接。")
    if not target.resolve().is_relative_to(REFERENCE_ROOT.resolve()) or not target.is_file():
        raise QmtReferenceError("找不到 QMT 资料文件。")
    if target.stat().st_nlink != 1 or target.stat().st_size > 128 * 1024:
        raise QmtReferenceError("QMT 资料文件不可用。")
    return target


def library() -> dict:
    try:
        catalog = json.loads(_file("catalog.json").read_text(encoding="utf-8"))
        documents, identities = [], set()
        for entry in catalog["documents"]:
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,79}", entry["id"]) or entry["id"] in identities:
                raise QmtReferenceError("QMT 资料目录含无效或重复标识。")
            identities.add(entry["id"])
            data = _file(entry["path"]).read_bytes()
            # Git/Windows may use CRLF. Hash the same UTF-8/LF text we return.
            content = data.decode("utf-8").replace("\r\n", "\n")
            digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
            if digest != entry["sha256"]:
                raise QmtReferenceError("QMT 资料内容与版本目录不符，请更新目录哈希。")
            documents.append({**entry, "content": content, "characters": len(content),
                              "url": "/api/v1/qmt-docs/" + entry["id"]})
        bundle = hashlib.sha256(json.dumps(catalog, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        return {**catalog, "bundle_sha256": bundle, "documents": documents}
    except (OSError, KeyError, TypeError, UnicodeError, json.JSONDecodeError) as exc:
        raise QmtReferenceError("QMT 资料库读取失败，请检查本地资料包。") from exc


def _metadata(document: dict) -> dict:
    return {key: value for key, value in document.items() if key not in {"content", "path"}}


def _normalize(text: str) -> str:
    return re.sub(r"\b(?:c|contextinfo)\.", "", unicodedata.normalize("NFKC", text).lower())


def search_docs(args: SearchQmtDocsArgs, context=None) -> dict:
    corpus = library()
    query = _normalize(args.query.strip())
    terms = set(re.findall(r"[a-z_][a-z0-9_.]*|\d+", query))
    for segment in re.findall(r"[\u3400-\u9fff]+", query):
        terms.update(segment[i:i + 2] for i in range(max(1, len(segment) - 1)))
    matches = []
    for document in corpus["documents"]:
        if args.kind != "all" and document["kind"] != args.kind:
            continue
        title = _normalize(document["title"])
        symbols = _normalize(" ".join(document.get("symbols", []) + document.get("tags", [])))
        body = _normalize(document["content"])
        score = sum((20 if term in symbols else 0) + (8 if term in title else 0) + (1 if term in body else 0) for term in terms)
        if query and not score and query not in body:
            continue
        if query and query in symbols:
            score += 100
        position = next((document["content"].lower().find(term) for term in sorted(terms, key=len, reverse=True)
                         if term in document["content"].lower()), 0)
        begin = max(0, position - 100)
        matches.append({**_metadata(document), "score": score, "excerpt": document["content"][begin:begin + 450]})
    priorities = {"manual": 0, "official_reference": 1, "example": 2} if not query else {"official_reference": 0, "manual": 1, "example": 2}
    matches.sort(key=lambda item: (-item["score"], priorities.get(item["kind"], 3), item["id"]))
    end = args.offset + args.limit
    return {"version": corpus["version"], "bundle_sha256": corpus["bundle_sha256"],
            "target": corpus["target"], "verified_at": corpus["verified_at"], "compatibility": corpus["compatibility"],
            "items": matches[args.offset:end], "total": len(matches), "next_offset": end if end < len(matches) else None,
            "note": "搜索摘要用于定位；使用 read_qmt_doc 读取正文。接口参考据官方资料整理；手册和示例为项目编写。"}


def read_doc(args: ReadQmtDocArgs, context=None) -> dict:
    corpus = library()
    document = next((item for item in corpus["documents"] if item["id"] == args.doc_id), None)
    if document is None:
        raise QmtReferenceError("找不到这个 QMT 资料条目。", 404)
    if args.expected_sha256 and args.expected_sha256 != document["sha256"]:
        raise QmtReferenceError("QMT 资料版本已改变，请重新搜索后读取。", 409)
    if args.offset > document["characters"]:
        raise QmtReferenceError("读取位置超出 QMT 资料正文。", 422)
    end = min(document["characters"], args.offset + args.limit)
    return {"version": corpus["version"], "bundle_sha256": corpus["bundle_sha256"], "document": _metadata(document),
            "text": document["content"][args.offset:end], "char_start": args.offset, "char_end": end,
            "next_offset": end if end < document["characters"] else None, "runtime_verified": False}


def required_docs(code: str) -> set[str]:
    # This is a retrieval checklist, not a claim that all API use can be detected.
    required = {"strategy-handbook", "official-lifecycle"}
    if re.search(r"get_market_data|get_history_data|get_full_tick|subscribe_quote|download_history_data", code):
        required.add("official-market-data")
    if re.search(r"set_universe|get_bar_timetag|timetag_to_datetime|do_back_test|is_back_test", code):
        required.add("official-context")
    if re.search(r"passorder|\border_(?:shares|lots|value|percent|target_value|target_percent)\b|get_trade_detail_data|\bcancel\(", code):
        required.update({"official-trading", "official-enums"})
    if "get_trade_detail_data" in code:
        required.add("official-data-structures")
    if re.search(r"\b(?:order|deal|account|position|orderError)_callback\b", code):
        required.add("official-callbacks")
    return required


def consultation(context, code: str) -> dict:
    """Use persisted successful reads, not model-supplied claims of consultation."""
    corpus = library()
    by_id = {item["id"]: item for item in corpus["documents"]}
    spans: dict[str, list[tuple[int, int]]] = {}
    with connect() as connection:
        rows = connection.execute("SELECT result_json FROM tool_calls WHERE conversation_id=? AND turn_id=? AND tool_name='read_qmt_doc' AND state='succeeded' ORDER BY created_at,id",
                                  (context.conversation_id, context.turn_id)).fetchall()
    for row in rows:
        result = json_load(row["result_json"])
        value = result.get("result", {}) if result.get("ok") else {}
        document = value.get("document", {})
        current = by_id.get(document.get("id"))
        if not current or document.get("sha256") != current["sha256"] or value.get("bundle_sha256") != corpus["bundle_sha256"]:
            continue
        begin, end = value.get("char_start"), value.get("char_end")
        if isinstance(begin, int) and isinstance(end, int) and 0 <= begin <= end <= current["characters"]:
            spans.setdefault(current["id"], []).append((begin, end))
    complete = []
    for doc_id, intervals in spans.items():
        covered = 0
        for begin, end in sorted(intervals):
            if begin > covered:
                break
            covered = max(covered, end)
        if covered >= by_id[doc_id]["characters"]:
            complete.append(doc_id)
    required = required_docs(code)
    return {"version": corpus["version"], "bundle_sha256": corpus["bundle_sha256"],
            "references": [_metadata(by_id[key]) for key in sorted(complete)],
            "missing_doc_ids": sorted(required - set(complete)), "scope": "current_turn", "runtime_verified": False}


def _tool(handler):
    def invoke(args, context):
        from .screening_tools import ToolDispatchError
        try:
            return handler(args, context)
        except QmtReferenceError as exc:
            raise ToolDispatchError("qmt_reference_error", str(exc)) from exc
    return invoke


def register_tools(registry) -> None:
    registry.register("search_qmt_docs", "Search the offline QMT BUILT-IN Python official interface references, project strategy handbook and runnable-source examples. Returns provenance, hashes and bounded excerpts. Search is discovery, not a full read. Use read_qmt_doc before generating; no network or strategy execution.", SearchQmtDocsArgs, _tool(search_docs))
    registry.register("read_qmt_doc", "Read an exact QMT reference document or project example by catalog doc_id, with source links and content hash. Follow next_offset to finish the document. Supply expected_sha256 from search to detect updates. Read strategy-handbook, official-lifecycle and relevant interface pages before export_qmt_script. Never executes examples.", ReadQmtDocArgs, _tool(read_doc))
