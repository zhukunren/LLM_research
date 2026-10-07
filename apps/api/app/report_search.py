"""Local, explainable report retrieval; search scores never verify a claim."""
from __future__ import annotations

from datetime import date
from functools import lru_cache
import re
from typing import Any
import unicodedata


COVERAGE_NOTE = "结果按文本相关性排列；扩展搜索包含分词和相关词线索，须阅读原文核实。检索排序不代表事实成立，未命中也不代表不存在相关资料。"
RELATED_TERMS = (
    ("营收", "营业收入"),
    ("扩产", "产能扩张", "新增产能", "产能建设"),
    ("投产", "投入生产", "建成投产"),
    ("研发", "研究开发"),
    ("资本开支", "资本支出"),
    ("现金流", "现金流量"),
)
STOP_WORDS = frozenset({"公司", "企业", "研报", "报告", "研究", "关于", "相关", "情况", "是否", "哪些", "以及", "其中", "进行", "最近", "近期", "帮我", "查找", "寻找", "搜索", "看看", "分析", "请", "的", "了", "和", "与", "在", "有", "是", "及"})
_HAN_GAP = re.compile(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])")


def normalize_search_text(text: str) -> str:
    """Normalize only the derived index, never stored source text or offsets."""
    return _HAN_GAP.sub("", unicodedata.normalize("NFKC", text).casefold())


@lru_cache(maxsize=1)
def _tokenizer():
    import jieba
    tokenizer = jieba.Tokenizer()
    for group in RELATED_TERMS:
        for word in group:
            tokenizer.add_word(word, freq=100000)
    return tokenizer


def query_plan(query: str, mode: str = "smart") -> dict[str, Any]:
    if mode not in {"smart", "exact"}:
        raise ValueError("搜索模式必须为 smart 或 exact")
    if not isinstance(query, str) or len(query) > 300:
        raise ValueError("搜索文字不能超过 300 个字符")
    # User whitespace separates independent keywords. PDF whitespace is handled
    # separately while indexing, so "订单 营业收入" remains a same-page AND query.
    normalized = unicodedata.normalize("NFKC", query).casefold().strip()
    phrases = [part for part in re.split(r"[\s,，;；、。!?！？]+", normalized) if part]
    if mode == "exact":
        terms = list(dict.fromkeys(phrases))
    else:
        terms = list(dict.fromkeys(
            word.strip() for word in _tokenizer().cut(normalized, HMM=False)
            if re.fullmatch(r"[\w.%+-]+", word.strip())
            and word.strip() not in STOP_WORDS
            and (len(word.strip()) >= 2 or word.strip().isascii())
        )) if normalized else []
        # A short query is still usable, even if it is a common single character.
        if not terms and normalized and len(phrases) == 1 and len(normalized) <= 4:
            terms = phrases
    expanded = []
    if mode == "smart":
        for group in RELATED_TERMS:
            if any(word in terms or word in normalized for word in group):
                expanded.extend(word for word in group if word not in terms)
    return {"normalized_query": normalized, "query_terms": terms,
            "expanded_terms": list(dict.fromkeys(expanded)), "mode": mode}


def _scope(as_of, stock_code, allowed_source_ids, stock_codes, confirmed_security_only, available_after):
    predicates = ["d.parse_status='indexed'"]
    params: list[Any] = []
    if as_of is not None:
        date.fromisoformat(as_of)
        predicates.append("d.available_at_status='confirmed' AND d.available_at IS NOT NULL AND d.available_at<=?")
        params.append(as_of)
    if available_after is not None:
        date.fromisoformat(available_after)
        predicates.append("d.available_at>=?")
        params.append(available_after)
    if stock_code:
        predicates.append("d.stock_code=?" if confirmed_security_only else "(d.stock_code=? OR d.stock_code IS NULL)")
        params.append(stock_code)
    if confirmed_security_only:
        predicates.append("d.stock_code_status='confirmed' AND d.stock_code IS NOT NULL")
    for column, values in (("d.id", allowed_source_ids), ("d.stock_code", stock_codes)):
        if values is not None:
            values = sorted(values)
            predicates.append(f"{column} IN ({','.join('?' for _ in values)})" if values else "0")
            params.extend(values)
    return " AND ".join(predicates), params


def _matching_sql(plan):
    """Use quoted FTS phrases; query text cannot supply MATCH operators."""
    terms = plan["query_terms"]
    words = list(dict.fromkeys(terms + plan["expanded_terms"]))
    long_words = [word for word in words if len(word) >= 3]
    short_words = [word for word in words if len(word) < 3]
    branches, params = [], []
    if long_words:
        operator = " AND " if plan["mode"] == "exact" else " OR "
        expression = operator.join('"' + word.replace('"', '""') + '"' for word in long_words)
        branches.append("SELECT rowid, -bm25(document_pages_search) AS text_rank FROM document_pages_search WHERE document_pages_search MATCH ?")
        params.append(expression)
    if short_words and (plan["mode"] == "smart" or not long_words):
        operator = " AND " if plan["mode"] == "exact" else " OR "
        branches.append("SELECT rowid, 0.0 AS text_rank FROM document_pages_search WHERE " + operator.join("instr(text,?)>0" for _ in short_words))
        params.extend(short_words)
    if not branches:
        branches = ["SELECT rowid,0.0 AS text_rank FROM document_pages_search WHERE 0"]
    guards, guard_params = [], []
    if plan["mode"] == "exact":
        guards = ["instr(s.text,?)>0" for _ in terms]
        guard_params = terms
    direct = " + ".join("CASE WHEN instr(s.text,?)>0 THEN 1 ELSE 0 END" for _ in terms) or "0"
    related = " + ".join("CASE WHEN instr(s.text,?)>0 THEN 1 ELSE 0 END" for _ in plan["expanded_terms"]) or "0"
    sql = "WITH candidates AS MATERIALIZED (" + " UNION ALL ".join(branches) + "), ranks AS (SELECT rowid,MAX(text_rank) AS text_rank FROM candidates GROUP BY rowid) "
    projection = f"({direct}) AS direct_matches, ({related}) AS related_matches, CASE WHEN instr(s.text,?)>0 THEN 1 ELSE 0 END AS exact_query_match"
    return sql, projection, params, [*terms, *plan["expanded_terms"], plan["normalized_query"]], guards, guard_params


def _snippet(text, matched_terms, length=360):
    # Map a normalized hit back to the original page, including PDF line breaks.
    pieces, offsets = [], []
    index = 0
    while index < len(text):
        end = index + 1
        # Normalization composes a base with its marks (e + acute -> é).
        # Normalize that cluster together so lookup and original offsets agree.
        while end < len(text) and unicodedata.category(text[end]).startswith("M"):
            end += 1
        piece = unicodedata.normalize("NFKC", text[index:end]).casefold()
        pieces.extend(piece)
        offsets.extend([index] * len(piece))
        index = end
    normalized = "".join(pieces)
    remove = set()
    for gap in _HAN_GAP.finditer(normalized):
        remove.update(range(gap.start(), gap.end()))
    if remove:
        offsets = [offset for index, offset in enumerate(offsets) if index not in remove]
        normalized = "".join(character for index, character in enumerate(normalized) if index not in remove)
    positions = [normalized.find(word) for word in matched_terms if word in normalized]
    center = offsets[min(positions)] if positions and offsets else 0
    start = max(0, center - length // 3)
    excerpt = text[start:start + length]
    return ("…" if start else "") + excerpt + ("…" if start + length < len(text) else "")


def search(query: str, as_of: str | None = None, stock_code: str | None = None, limit: int = 30, *,
           mode: str = "smart", offset: int = 0, allowed_source_ids=None, stock_codes=None,
           confirmed_security_only: bool = False, available_after: str | None = None) -> dict[str, Any]:
    from .db import connect
    if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or offset < 0:
        raise ValueError("搜索分页范围无效")
    plan = query_plan(query, mode)
    result = {**plan, "items": [], "total": 0, "offset": offset, "next_offset": None,
              "scope": "indexed_local_pages", "coverage_note": COVERAGE_NOTE}
    if not plan["query_terms"]:
        return result
    scope, scope_params = _scope(as_of, stock_code, allowed_source_ids, stock_codes, confirmed_security_only, available_after)
    cte, projection, candidate_params, projection_params, guards, guard_params = _matching_sql(plan)
    clause = scope + (" AND " + " AND ".join(guards) if guards else "")
    base = " FROM ranks r JOIN document_pages p ON p.rowid=r.rowid JOIN documents d ON d.id=p.document_id JOIN document_pages_search s ON s.rowid=p.rowid WHERE " + clause
    with connect() as connection:
        connection.execute("BEGIN")
        result["total"] = connection.execute(cte + "SELECT COUNT(*)" + base, [*candidate_params, *scope_params, *guard_params]).fetchone()[0]
        rows = connection.execute(
            cte + "SELECT d.id,d.filename,d.title,d.publication_date,d.market,d.stock_code,d.available_at,d.available_at_status,d.sha256,d.stock_code_status,p.page_number,p.text,s.text AS search_text,r.text_rank," + projection + base +
            " ORDER BY exact_query_match DESC,direct_matches DESC,related_matches DESC,r.text_rank DESC,d.available_at DESC,d.id,p.page_number LIMIT ? OFFSET ?",
            [*candidate_params, *projection_params, *scope_params, *guard_params, limit, offset],
        ).fetchall()
    for row in rows:
        matched = [word for word in plan["query_terms"] if word in row["search_text"]]
        related = [word for word in plan["expanded_terms"] if word in row["search_text"]]
        rank = max(0.0, row["text_rank"])
        result["items"].append({
            "document_id": row["id"], "filename": row["filename"], "title": row["title"],
            "publication_date": row["publication_date"], "market": row["market"], "stock_code": row["stock_code"],
            "page_number": row["page_number"], "snippet": _snippet(row["text"], matched + related),
            "available_at": row["available_at"], "availability_status": row["available_at_status"],
            "source_sha256": row["sha256"], "security_binding_status": row["stock_code_status"],
            "matched_terms": matched, "expanded_terms": related, "exact_query_match": bool(row["exact_query_match"]),
            "match_type": "normalized_same_page_keyword" if mode == "exact" else "expanded_text_match",
            "retrieval_method": "fts5_trigram" if any(len(word) >= 3 for word in matched + related) else "substring_fallback",
            "relevance_score": float(row["exact_query_match"] * 1000000 + row["direct_matches"] * 1000 + row["related_matches"] * 10 + rank / (1 + rank)),
            "relevance_note": "仅用于文本排序，不代表证据支持或收益概率。", "semantic_support_verified": False,
        })
    next_offset = offset + len(rows)
    result["next_offset"] = next_offset if next_offset < result["total"] else None
    return result


def search_source_catalog(query: str, as_of: str | None = None, stock_code: str | None = None, *, offset=0, limit=30, stock_codes=None, available_after=None):
    """Deduplicate and paginate at document level, including title-only matches."""
    from .db import connect
    plan = query_plan(query)
    if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or offset < 0:
        raise ValueError("资料列表分页范围无效")
    scope, params = _scope(as_of, stock_code, None, stock_codes, bool(stock_code and as_of), available_after)
    if stock_code and not as_of:
        scope += " AND d.stock_code=?"
        params.append(stock_code)
    words = list(dict.fromkeys(plan["query_terms"] + plan["expanded_terms"]))
    if not words:
        return {**plan, "items": [], "total": 0, "offset": offset, "next_offset": None, "coverage_note": COVERAGE_NOTE}
    cte, _, candidate_params, _, _, _ = _matching_sql(plan)
    title_checks = " OR ".join("instr(llmr_search_text(d.title || ' ' || d.filename),?)>0" for _ in words)
    clause = scope + f" AND (d.id IN (SELECT p.document_id FROM ranks r JOIN document_pages p ON p.rowid=r.rowid) OR {title_checks})"
    sql = cte + "SELECT d.id,d.title,d.filename,d.stock_code,d.stock_code_status,d.pages,d.publication_date,d.available_at,d.available_at_status FROM documents d WHERE " + clause
    with connect() as connection:
        connection.execute("BEGIN")
        total = connection.execute(cte + "SELECT COUNT(*) FROM documents d WHERE " + clause, [*candidate_params, *params, *words]).fetchone()[0]
        rows = connection.execute(sql + " ORDER BY d.available_at DESC,d.id LIMIT ? OFFSET ?", [*candidate_params, *params, *words, limit, offset]).fetchall()
    end = offset + len(rows)
    return {**plan, "items": [dict(row) for row in rows], "total": total, "offset": offset,
            "next_offset": end if end < total else None, "coverage_note": COVERAGE_NOTE}
