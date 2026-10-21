"""Bounded, immutable research inputs shared by comparison and change tracking."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import hashlib
import re

from . import company_research, report_search, documents
from .db import connect, utc_now

MAX_CHUNKS = 12
MAX_TEXT = 5000
MAX_INVENTORY = 2000
_ANCHORS = ("营业收入", "营业总收入", "归属于上市公司股东的净利润", "净利润", "经营活动产生的现金流量净额",
    "现金流量净额", "现金流", "毛利率", "酒类", "客户集中度", "客户", "订单", "负债", "存货", "应收", "产能",
    "经营风险", "可能面对的风险", "经营计划", "经营目标", "发展目标", "风险", "资本开支", "研发", "利润", "EPS", "ROE", "EBITDA")
_QUERY_BOILERPLATE = {"年度", "年报", "原文", "引用", "注明", "保留", "币种", "单位", "报告期", "人民币", "亿元", "万元", "是多少", "多少", "什么", "给出", "说明", "区分", "不要", "不能", "而非", "是否", "本期", "数据", "口径"}
_NORMALIZED_ANCHORS = {report_search.normalize_search_text(term) for term in _ANCHORS}


def _term_weight(term):
    return 30 + min(12, len(term)) if term in _NORMALIZED_ANCHORS and len(term) >= 3 else min(3, len(term))


def _question_terms(query: str) -> list[str]:
    expanded = query
    if "归母" in query:
        expanded += " 归属于上市公司股东的净利润"
    if "现金流" in query:
        expanded += " 经营活动产生的现金流量净额"
    if "目标" in query:
        expanded += " 经营计划 经营目标 发展目标"
    if "风险" in query:
        expanded += " 可能面对的风险 经营风险"
    known = [term for term in _ANCHORS if term.casefold() in expanded.casefold()]
    plan = report_search.query_plan(query[:300])
    words = [term for term in plan["query_terms"] + plan["expanded_terms"] if term not in _QUERY_BOILERPLATE]
    return list(dict.fromkeys(report_search.normalize_search_text(term) for term in known + words))[:24]


def _score_sql(terms):
    return "+".join(f"CASE WHEN instr(llmr_search_text(text),?)>0 THEN {_term_weight(term)} ELSE 0 END" for term in terms) or "0"


def _text_score(text, terms):
    value = report_search.normalize_search_text(text)
    return sum(_term_weight(term) for term in terms if term in value)


def _select_candidates(candidates, groups):
    selected, seen = [], set()
    def add(item):
        key = (item["source_type"], item["source_id"], item["page_number"])
        if key not in seen and len(selected) < MAX_CHUNKS:
            selected.append(item); seen.add(key)
    primary_seen = set()
    for item in sorted((item for item in candidates if item["source_type"] == "disclosure" and item["_rank"] > 0),
                       key=lambda item: (item["_rank"], item["available_at"]), reverse=True):
        if item["source_id"] not in primary_seen and len(primary_seen) < 6:
            add(item); primary_seen.add(item["source_id"])
    # Reserve the strongest evidence for each question before filling spare
    # slots. A long first question must not crowd out another question's pages.
    rankings = []
    for index, group in enumerate(groups):
        ranking = sorted((item for item in candidates if item["_scores"][index] > 0),
            key=lambda item: (item["_scores"][index], item["available_at"], len(item["text"]), -item["page_number"], item["source_id"]), reverse=True)
        if len(ranking) > 1:
            covered = report_search.normalize_search_text(ranking[0]["text"])
            def complement(item):
                text = report_search.normalize_search_text(item["text"])
                novelty = sum(_term_weight(term) for term in group if term in text and term not in covered)
                return (item["_scores"][index] + novelty, item["_scores"][index], item["available_at"], len(item["text"]))
            second = max(ranking[1:], key=complement)
            ranking = [ranking[0], second]
        rankings.append(ranking)
    for depth in range(2):
        for ranking in rankings:
            if len(ranking) > depth:
                add(ranking[depth])
    for item in sorted(candidates, key=lambda item: (item["_rank"], item["page_number"] == 1, item["available_at"], item["source_id"]), reverse=True):
        add(item)
    return selected


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def snapshot(project_id: str, codes: list[str], as_of: str, *, questions: list[str] | None = None) -> dict:
    cutoff = date.fromisoformat(as_of)
    cutoff_end = datetime.combine(cutoff + timedelta(days=1), time(), timezone(timedelta(hours=8))).astimezone(timezone.utc).isoformat()
    companies = {}
    groups = [_question_terms(question) for question in (questions or [])[:6]]
    terms = list(dict.fromkeys(term for group in groups for term in group))[:40]
    with connect() as connection:
        connection.execute("BEGIN")
        for code in codes:
            company_research._require_company(connection, project_id, code)
            reports = connection.execute("""SELECT id,title,available_at,publication_date,pages,sha256 FROM documents
                WHERE material_kind='report' AND stock_code=? AND stock_code_status='confirmed' AND available_at_status='confirmed'
                  AND available_at IS NOT NULL AND available_at<=? AND parse_status='indexed'
                ORDER BY available_at DESC,id LIMIT ?""", (code, as_of, MAX_INVENTORY + 1)).fetchall()
            news = connection.execute("""SELECT n.id,n.root_id,n.version,n.title,n.available_at,n.published_at FROM news_records n WHERE n.available_at IS NOT NULL AND n.available_at<?
                AND EXISTS(SELECT 1 FROM json_each(n.stock_codes_json) WHERE value=?)
                AND n.version=(SELECT MAX(v.version) FROM news_records v WHERE v.root_id=n.root_id AND v.available_at<?)
                AND NOT EXISTS(SELECT 1 FROM news_records v WHERE v.root_id=n.root_id AND v.version>n.version AND v.available_at IS NULL)
                ORDER BY n.available_at DESC,n.id LIMIT ?""", (cutoff_end, code, cutoff_end, MAX_INVENTORY + 1)).fetchall()
            complete = len(reports) <= MAX_INVENTORY and len(news) <= MAX_INVENTORY
            reports, news = reports[:MAX_INVENTORY], news[:MAX_INVENTORY]
            primary = connection.execute("""SELECT v.id,v.disclosure_id,v.document_id,v.sha256,v.version,m.revision,m.metadata_json,d.pages,d.source_path
                FROM disclosure_versions v JOIN disclosure_metadata m ON m.version_id=v.id
                AND m.revision=(SELECT MAX(n.revision) FROM disclosure_metadata n WHERE n.version_id=v.id)
                JOIN documents d ON d.id=v.document_id WHERE json_extract(m.metadata_json,'$.stock_code')=?
                AND json_extract(m.metadata_json,'$.confirmed')=1 AND json_extract(m.metadata_json,'$.publication_date') IS NOT NULL
                AND json_extract(m.metadata_json,'$.publication_date')<=? AND date(v.created_at,'+8 hours')<=?
                ORDER BY json_extract(m.metadata_json,'$.report_period') DESC,v.version DESC LIMIT ?""", (code, as_of, as_of, MAX_INVENTORY + 1)).fetchall()
            complete = complete and len(primary) <= MAX_INVENTORY
            primary = primary[:MAX_INVENTORY]
            inventory, chunks = {}, []
            for row in reports:
                inventory["report:" + row["id"]] = {"source_type": "report", "source_id": row["id"], "title": row["title"],
                    "available_at": row["available_at"], "page_count": row["pages"], "fingerprint": row["sha256"]}
            for row in news:
                inventory["news:" + row["root_id"]] = {"source_type": "news", "source_id": row["id"], "title": row["title"],
                    "available_at": row["available_at"], "fingerprint": fingerprint(f"{row['id']}:{row['version']}"), "source_version": row["version"]}
            from .db import json_load
            for row in primary:
                meta = json_load(row["metadata_json"])
                inventory["disclosure:" + row["id"]] = {"source_type": "disclosure", "source_id": row["id"],
                    "title": meta["title"], "available_at": meta["publication_date"], "page_count": row["pages"],
                    "report_period": meta["report_period"], "source_version": row["version"],
                    "fingerprint": fingerprint(row["sha256"] + row["metadata_json"]), "metadata_revision": row["revision"],
                    "source_sha256": row["sha256"], "document_id": row["document_id"], "metadata_snapshot": meta, "disclosure_id": row["disclosure_id"]}
            # Balance source types instead of allowing one long report to consume every slot.
            candidates = []
            requested_years = {year for question in questions or [] for year in re.findall(r"20\d{2}", question)}
            chosen_primary = [row for row in primary if json_load(row["metadata_json"])["report_period"][:4] in requested_years]
            annual = [row for row in primary if json_load(row["metadata_json"])["document_type"] == "annual"][:12]
            chosen_primary = list({row["id"]: row for row in [*chosen_primary, *annual, *primary[:8]]}.values())[:50]
            for row in chosen_primary:
                try:
                    documents.original_snapshot(row["source_path"], row["sha256"])
                except (ValueError, OSError):
                    inventory["disclosure:" + row["id"]]["original_available"] = False
                    inventory["disclosure:" + row["id"]]["fingerprint"] += ":original_missing"
                    continue
                meta = json_load(row["metadata_json"])
                pages = {}
                for group in groups or [terms]:
                    for page in connection.execute(f"SELECT page_number,text,({_score_sql(group)}) relevance FROM document_pages WHERE document_id=? ORDER BY relevance DESC,length(text) DESC,page_number LIMIT 4", (*group, row["document_id"])):
                        pages[page["page_number"]] = page
                for page in pages.values():
                    candidates.append({"source_type": "disclosure", "source_id": row["id"], "title": meta["title"],
                        "available_at": meta["publication_date"], "publication_at": meta["publication_date"], "page_count": row["pages"],
                        "page_number": page["page_number"], "source_sha256": row["sha256"], "source_version": row["version"],
                        "metadata_revision": row["revision"], "text": page["text"],
                        "_scores": [_text_score(page["text"], group) for group in groups], "_rank": _text_score(page["text"], terms)})
            for row in reports[:6]:
                pages = {}
                for group in groups or [terms]:
                    for page in connection.execute(f"SELECT page_number,text,({_score_sql(group)}) relevance FROM document_pages WHERE document_id=? ORDER BY relevance DESC,length(text) DESC,page_number LIMIT ?", (*group, row["id"], 4 if groups else 3)):
                        pages[page["page_number"]] = page
                for page in pages.values():
                    candidates.append({"source_type": "report", "source_id": row["id"], "title": row["title"],
                        "available_at": row["available_at"], "publication_at": row["publication_date"], "page_count": row["pages"],
                        "page_number": page["page_number"], "source_sha256": row["sha256"], "source_version": None, "text": page["text"],
                        "_scores": [_text_score(page["text"], group) for group in groups], "_rank": _text_score(page["text"], terms)})
            for row in news[:8]:
                body = connection.execute("SELECT body FROM news_records WHERE id=?", (row["id"],)).fetchone()[0]
                candidates.append({"source_type": "news", "source_id": row["id"], "title": row["title"], "available_at": row["available_at"],
                    "publication_at": row["published_at"], "page_count": 1, "page_number": 1, "source_sha256": fingerprint(body),
                    "source_version": row["version"], "text": body, "_scores": [_text_score(body, group) for group in groups], "_rank": _text_score(body, terms)})
            for item in _select_candidates(candidates, groups):
                original = len(item["text"])
                positions = [item["text"].lower().find(term.lower()) for term in terms if term.lower() in item["text"].lower()]
                offset = max(0, min(positions) - 600) if positions else 0
                chunk_end = min(original, offset + MAX_TEXT)
                chunks.append({key: value for key, value in item.items() if not key.startswith("_")} | {"key": "S" + str(len(chunks)), "text": item["text"][offset:chunk_end], "stock_code": code,
                    "char_start": offset, "char_end": chunk_end, "original_characters": original,
                    "next_offset": chunk_end if chunk_end < original else None, "as_of": as_of})
            name = connection.execute("SELECT name FROM security_catalog WHERE stock_code=?", (code,)).fetchone()
            companies[code] = {"name": name[0] if name else "", "inventory": inventory, "chunks": chunks,
                "coverage": {"reports": len(reports), "news": len(news), "disclosures": len(primary), "read_chunks": len(chunks), "inventory_complete": complete, "corpus_read_complete": False,
                             "selection": "per_question_terms" if terms else "recent_materials", "max_chunks": MAX_CHUNKS, "characters_per_chunk": MAX_TEXT,
                             "note": "每家公司在最多6份研报、8份资讯和50份按年度/报告期选择的披露中逐题检索；相关原始披露优先保留，最多12个有界摘录。缺失原件不冒充已读，未找到证据不等于公司未披露。"}}
    return {"as_of": as_of, "captured_at": utc_now(), "companies": companies}
