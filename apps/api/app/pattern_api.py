from __future__ import annotations

import math
import re
from datetime import date
from uuid import uuid4

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse

from . import market
from .api_responses import bad_request
from .db import connect, json_dump, json_load, utc_now
from .models import PatternExtractionInput, PatternInput, PatternMarketWindowInput, PatternPreviewInput
from .pattern_research import save_search
from .patterns import extract_path, score_window, store_source_image, upload_directory, validate_candles

router = APIRouter(prefix="/api/v1/patterns")


@router.get("")
def list_patterns(include_history: bool = False):
    with connect() as connection:
        rows = connection.execute(
            "SELECT * FROM patterns ORDER BY created_at DESC,version DESC" if include_history else
            """SELECT p.* FROM patterns p JOIN (SELECT id,MAX(version) version FROM patterns GROUP BY id) latest
               ON latest.id=p.id AND latest.version=p.version ORDER BY p.created_at DESC"""
        ).fetchall()
    return {"items": [
        {"id": row[0], "name": row[2], "version": row[3], **json_load(row[4]), "created_at": row[5]}
        for row in rows
    ]}


@router.post("/extract")
def pattern_extract(payload: PatternExtractionInput):
    try:
        return extract_path(payload.image_base64, payload.mime_type, payload.crop)
    except ValueError as exc:
        bad_request(str(exc), 422, "pattern_extraction_failed")


@router.post("/market-window")
def pattern_market_window(payload: PatternMarketWindowInput):
    if payload.start_date > payload.end_date:
        bad_request("开始日期不能晚于结束日期")
    if payload.end_date > date.today():
        bad_request("结束日期不能晚于今天")
    fingerprint = market.source_fingerprint()
    bars = market.get_bar_window(payload.stock_code, payload.start_date.isoformat(), payload.end_date.isoformat())
    if len(bars) < 10:
        bad_request(f"所选区间只有 {len(bars)} 根日线，请选择含 10–250 根日线的区间")
    if len(bars) > 250:
        bad_request("所选区间超过 250 根日线，请缩短时间范围")
    if any(bar.get("quality_valid") is False for bar in bars):
        bad_request("所选区间包含无效行情，请调整日期范围")
    if len({bar["trade_date"] for bar in bars}) != len(bars):
        bad_request("所选区间存在重复交易日，请先修复行情数据")
    candles = [{key: bar[key] for key in ("open", "high", "low", "close")} for bar in bars]
    try:
        validate_candles(candles)
    except ValueError as exc:
        bad_request(str(exc))
    if market.source_fingerprint() != fingerprint:
        bad_request("行情更新中，请重新载入区间", 409, "pattern_market_changed")
    snapshot_id, now = str(uuid4()), utc_now()
    source = {"snapshot_id": snapshot_id, "stock_code": payload.stock_code,
              "requested_start_date": payload.start_date.isoformat(), "requested_end_date": payload.end_date.isoformat(),
              "start_date": bars[0]["trade_date"], "end_date": bars[-1]["trade_date"],
              "price_basis": market.PRICE_BASIS, "bars": bars, "created_at": now}
    with connect() as connection:
        connection.execute("INSERT INTO pattern_market_windows VALUES(?,?,?)", (snapshot_id, json_dump(source), now))
    return {**source, "points": [bar["close"] for bar in bars], "candlesticks": candles, "target_bars": len(bars)}


def _pattern_market_source(payload: PatternInput) -> dict | None:
    if payload.input_type != "market_window":
        return None
    with connect() as connection:
        row = connection.execute("SELECT window_json FROM pattern_market_windows WHERE id=?", (payload.source_window_id,)).fetchone()
    if not row:
        bad_request("请先载入股票的 K 线区间，再保存或匹配")
    source = json_load(row[0])
    bars = source["bars"]
    candles = [{key: bar[key] for key in ("open", "high", "low", "close")} for bar in bars]
    if (payload.target_bars != len(bars) or payload.points != [bar["close"] for bar in bars]
            or (payload.representation == "ohlc_sequence" and payload.candlesticks != candles)):
        bad_request("走势与载入的行情快照不一致，请重新载入区间")
    return source


def _pattern_draft_provenance(draft_id: str, *, confirmed: bool) -> dict:
    with connect() as connection:
        draft = connection.execute("SELECT prompt,draft_json,created_at FROM pattern_drafts WHERE id=?", (draft_id,)).fetchone()
    if not draft or json_load(draft[1])["status"] != "ready":
        bad_request("自然语言形态草稿不存在或尚未完成确认")
    plan = json_load(draft[1])
    provenance = {"draft_id": draft_id, "prompt": draft[0], "original_prompt": draft[0], "source_quote": draft[0],
            "source": plan["source"], "model": plan["model"], "compiler_version": plan["compiler_version"],
            "shape": plan["shape"], "original_points": plan["points"], "original_target_bars": plan["target_bars"],
            "original_min_similarity": plan["min_similarity"], "assumptions": plan["assumptions"], "draft_created_at": draft[2]}
    if confirmed:
        provenance["confirmed_at"] = utc_now()
    return provenance


def _pattern_lineage(payload: PatternInput, *, confirm_draft: bool = False) -> tuple[dict | None, dict | None, dict | None]:
    """Resolve workspace-owned origins, never trust client-supplied snapshot metadata."""
    derivation, provenance, source_image = None, None, None
    source_market = None
    origin = payload.derivation
    if origin is None and payload.id and payload.input_type == "drawing":
        with connect() as connection:
            row = connection.execute("SELECT pattern_json FROM patterns WHERE id=? ORDER BY version DESC LIMIT 1", (payload.id,)).fetchone()
        previous = json_load(row[0]) if row else {}
        if previous.get("derivation"):
            if payload.source_image_base64 or payload.source_draft_id or payload.source_window_id:
                bad_request("修改来源副本时请明确指定新的来源")
            # Match and save both retain known origins when an older client omits them.
            return previous["derivation"], previous.get("provenance"), previous.get("source_image")
    if origin:
        if payload.input_type != "drawing":
            bad_request("来源副本必须保存为自定义形态")
        if payload.source_window_id or payload.source_draft_id:
            bad_request("来源副本请仅通过 derivation 指定来源")
        if bool(origin.source_pattern_id) != (origin.source_pattern_version is not None):
            bad_request("来源形态必须同时指定 ID 与版本")
        routes = sum(bool(value) for value in (origin.source_pattern_id, origin.source_window_id, origin.source_draft_id))
        if routes > 1:
            bad_request("来源副本只能指定一个原始来源")
        derivation = origin.model_dump(exclude_none=True)
        if origin.source_pattern_id:
            with connect() as connection:
                row = connection.execute("SELECT pattern_json FROM patterns WHERE id=? AND version=?",
                                         (origin.source_pattern_id, origin.source_pattern_version)).fetchone()
            if not row:
                bad_request("找不到来源形态版本", 404, "pattern_version_not_found")
            original = json_load(row[0])
            inherited = original.get("derivation") or {}
            if origin.origin_type != inherited.get("origin_type", original["input_type"]):
                bad_request("来源类型与已保存的形态不一致")
            source_market = original.get("market_source") or inherited.get("market_source")
            provenance = original.get("provenance")
            source_image = original.get("source_image")
        elif origin.source_window_id:
            if origin.origin_type != "market_window":
                bad_request("行情快照只能作为行情来源")
            with connect() as connection:
                row = connection.execute("SELECT window_json FROM pattern_market_windows WHERE id=?", (origin.source_window_id,)).fetchone()
            if not row:
                bad_request("找不到来源行情快照", 404, "pattern_window_not_found")
            source_market = json_load(row[0])
        elif origin.source_draft_id:
            if origin.origin_type != "natural_language":
                bad_request("文字草稿只能作为文字来源")
            provenance = _pattern_draft_provenance(origin.source_draft_id, confirmed=confirm_draft)
        elif origin.origin_type != "screenshot" or not payload.source_image_base64:
            bad_request("自定义副本缺少可核验的原始来源")
        if payload.source_image_base64 and routes:
            bad_request("来源副本不能替换原始截图")
        if origin.origin_type == "market_window" and not source_market:
            bad_request("来源形态缺少行情快照")
        if origin.origin_type == "natural_language" and not provenance:
            bad_request("来源形态缺少文字草稿")
        if origin.origin_type == "screenshot" and routes and not source_image:
            bad_request("来源形态缺少原始截图")
    elif payload.source_draft_id:
        provenance = _pattern_draft_provenance(payload.source_draft_id, confirmed=confirm_draft)
    elif payload.input_type == "natural_language":
        bad_request("自然语言形态需要关联生成草稿")

    if payload.source_image_base64:
        if not payload.source_image_mime:
            bad_request("截图模板缺少图片类型")
        try:
            source_image = store_source_image(payload.source_image_base64, payload.source_image_mime, payload.source_image_filename)
        except ValueError as exc:
            bad_request(str(exc), 422, "invalid_pattern_image")
    if derivation:
        if source_market:
            derivation["market_source"] = source_market
        if provenance:
            derivation["provenance"] = provenance
        if source_image:
            derivation["source_image"] = source_image
    return derivation, provenance, source_image


@router.post("")
def save_pattern(payload: PatternInput):
    market_source = _pattern_market_source(payload)
    if len(payload.points) != payload.target_bars:
        bad_request("走势点数必须与目标交易日数一致")
    similarity = payload.params.get("min_similarity", 80)
    if type(similarity) not in (int, float) or not math.isfinite(similarity) or not 0 <= similarity <= 100:
        bad_request("最低相似度必须为0到100之间的数值")
    match_mode = payload.params.get("match_mode", "current")
    if match_mode not in {"current", "recent"}:
        bad_request("形态匹配模式只能为当前窗口或近期窗口")
    recent_bars = payload.params.get("recent_bars", 20)
    if type(recent_bars) is not int or isinstance(recent_bars, bool) or not 1 <= recent_bars <= 120:
        bad_request("近期形态回看交易日数必须为1到120的整数")
    if payload.representation == "ohlc_sequence":
        if len(payload.candlesticks) != payload.target_bars:
            bad_request("蜡烛数必须与目标 bar 数一致")
        try:
            validate_candles(payload.candlesticks)
        except ValueError as exc:
            bad_request(str(exc))
    derivation, provenance, source_image = _pattern_lineage(payload, confirm_draft=True)
    pattern_id, now = payload.id or str(uuid4()), utc_now()
    content = {
        "input_type": payload.input_type, "representation": payload.representation, "note": payload.note,
        "target_bars": payload.target_bars, "points": payload.points,
        "candlesticks": payload.candlesticks, "params": payload.params,
        "algorithm_version": "candle-window-v2" if payload.representation == "ohlc_sequence" else "path-window-v2",
        "provenance": provenance,
        "market_source": market_source, "derivation": derivation,
    }
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("SELECT COALESCE(MAX(version),0)+1 FROM patterns WHERE id=?", (pattern_id,)).fetchone()[0]
        if version > 1:
            previous = connection.execute("SELECT pattern_json FROM patterns WHERE id=? AND version=?", (pattern_id, version - 1)).fetchone()
            previous_content = json_load(previous[0]) if previous else {}
            if source_image is None and payload.input_type == "screenshot":
                source_image = previous_content.get("source_image")
            if payload.derivation is None and payload.input_type == "drawing" and previous_content.get("derivation"):
                # Old clients updating a derived version must not silently discard its origin.
                if payload.source_image_base64 or payload.source_draft_id or payload.source_window_id:
                    bad_request("修改来源副本时请明确指定新的来源")
                content["derivation"] = previous_content["derivation"]
                content["provenance"] = previous_content.get("provenance")
                source_image = previous_content.get("source_image")
        content["source_image"] = source_image
        connection.execute("INSERT INTO patterns(id,name,version,pattern_json,created_at) VALUES(?,?,?,?,?)", (pattern_id, payload.name, version, json_dump(content), now))
        connection.execute("INSERT INTO audit_events(action,entity_type,entity_id,version,created_at) VALUES('save','pattern',?,?,?)", (pattern_id, version, now))
    return {"id": pattern_id, "name": payload.name, "version": version, **content, "created_at": now}


@router.get("/{pattern_id}/source-image")
def pattern_source_image(pattern_id: str, version: int):
    with connect() as connection:
        row = connection.execute("SELECT pattern_json FROM patterns WHERE id=? AND version=?", (pattern_id, version)).fetchone()
    if not row:
        bad_request("找不到形态版本", 404, "pattern_version_not_found")
    source = json_load(row[0]).get("source_image")
    if not source:
        bad_request("该模板没有来源截图", 404, "pattern_image_not_found")
    digest, extension = source.get("sha256", ""), source.get("extension", "")
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or extension not in {".png", ".jpg", ".webp"}:
        bad_request("截图索引无效", 422, "invalid_pattern_image_ref")
    path = upload_directory() / f"{digest}{extension}"
    if not path.is_file():
        bad_request("来源截图文件缺失", 404, "pattern_image_missing")
    return FileResponse(path, media_type=source["mime_type"], filename=source["filename"])


@router.post("/preview")
def preview_pattern(payload: PatternPreviewInput):
    with connect() as connection:
        row = connection.execute("SELECT name,pattern_json FROM patterns WHERE id=? AND version=?", (payload.pattern_id, payload.pattern_version)).fetchone()
    if not row:
        bad_request("找不到形态版本", 404, "pattern_version_not_found")
    pattern = {"name": row[0], "id": payload.pattern_id, "version": payload.pattern_version, **json_load(row[1])}
    params = pattern.get("params", {}) if isinstance(pattern.get("params"), dict) else {}
    match_mode = payload.match_mode or params.get("match_mode", "current")
    match_mode = match_mode if match_mode in {"current", "recent"} else "current"
    recent_bars = payload.recent_bars if payload.recent_bars is not None else params.get("recent_bars", 20)
    if type(recent_bars) is not int or not 1 <= recent_bars <= 120:
        recent_bars = 20
    required_bars = pattern["target_bars"] if match_mode == "current" else pattern["target_bars"] + recent_bars - 1
    bars = market.get_bars(payload.stock_code, payload.as_of, min(500, required_bars))
    result = score_window(pattern, bars, match_mode=payload.match_mode, recent_bars=payload.recent_bars)
    return {
        **result, "stock_code": payload.stock_code, "mode": "exploratory",
        "warning": "当前为本地未复权行情的归一化路径对照，仅供探索。",
    }


@router.get("/{pattern_id}/best-match")
def pattern_best_match(pattern_id: str, version: int, limit: int = Query(default=1, ge=1, le=24), as_of: date | None = None):
    from .pattern_examples import find_example
    if as_of and as_of > date.today():
        bad_request("截止日不能晚于今天", 422, "invalid_pattern_cutoff")
    with connect() as connection:
        row = connection.execute("SELECT pattern_json,name FROM patterns WHERE id=? AND version=?", (pattern_id, version)).fetchone()
    if not row:
        bad_request("找不到形态版本", 404, "pattern_version_not_found")
    template = {**json_load(row[0]), "id": pattern_id, "version": version, "name": row[1]}
    try:
        result = find_example(template, limit=limit, as_of=as_of.isoformat() if as_of else None)
        return result
    except ValueError as exc:
        bad_request(str(exc), 409, "pattern_market_changed")


@router.post("/{pattern_id}/search")
def search_saved_pattern(pattern_id: str, version: int, limit: int = Query(default=1, ge=1, le=24), as_of: date | None = None):
    # Explicit POST preserves CSRF and write-role checks for persisted research.
    result = pattern_best_match(pattern_id, version, limit, as_of)
    with connect() as connection:
        row = connection.execute("SELECT pattern_json,name FROM patterns WHERE id=? AND version=?", (pattern_id, version)).fetchone()
    template = {**json_load(row[0]), "id": pattern_id, "version": version, "name": row[1]}
    return save_search(template, result, {"pattern_id": pattern_id, "version": version, "as_of": as_of.isoformat() if as_of else None, "limit": limit, "mode": "historical_examples"})


@router.post("/match")
def match_pattern_input(payload: PatternInput, limit: int = Query(default=1, ge=1, le=24), as_of: date | None = None):
    from .pattern_examples import find_example
    if as_of and as_of > date.today():
        bad_request("截止日不能晚于今天", 422, "invalid_pattern_cutoff")
    market_source = _pattern_market_source(payload)
    if len(payload.points) != payload.target_bars:
        bad_request("走势点数必须与目标交易日数一致", 422)
    if payload.representation == "ohlc_sequence":
        if len(payload.candlesticks) != payload.target_bars:
            bad_request("蜡烛数必须与目标交易日数一致", 422)
        try:
            validate_candles(payload.candlesticks)
        except ValueError as exc:
            bad_request(str(exc), 422)
    derivation, provenance, source_image = _pattern_lineage(payload)
    template = {"name": payload.name, "input_type": payload.input_type, "note": payload.note, "params": payload.params,
                "source_draft_id": payload.source_draft_id, "source_window_id": payload.source_window_id,
                "representation": payload.representation, "target_bars": payload.target_bars,
                "points": payload.points, "candlesticks": payload.candlesticks,
                "algorithm_version": "candle-window-v2" if payload.representation == "ohlc_sequence" else "path-window-v2",
                "market_source": market_source, "derivation": derivation, "provenance": provenance, "source_image": source_image}
    try:
        result = find_example(template, limit=limit, as_of=as_of.isoformat() if as_of else None)
        return save_search(template, result, {"as_of": as_of.isoformat() if as_of else None, "limit": limit, "mode": "historical_examples"})
    except ValueError as exc:
        bad_request(str(exc), 409, "pattern_market_changed")
