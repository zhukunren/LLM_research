"""Lossless financial source versions; no implicit latest-row or historical claims."""
from __future__ import annotations

from datetime import date, datetime, time, timezone, timedelta
from decimal import Decimal, InvalidOperation
import hashlib
import json
from typing import Literal

from .tushare_endpoints import CODE, CONTRACT_VERSION, ENDPOINTS, FINANCIAL_FIELDS, parse_date

ZONE = timezone(timedelta(hours=8))
STATEMENTS = {"income", "balancesheet", "cashflow"}


def decimal_text(value: object) -> str:
    if isinstance(value, bool):
        raise ValueError("布尔值不能作为财务数字")
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise ValueError("无效的财务数字") from None
    if not number.is_finite():
        raise ValueError("财务数字必须有限")
    # normalize() rounds under Decimal's context; format directly instead.
    text = format(number, "f")
    return (text.rstrip("0").rstrip(".") if "." in text else text) if number else "0"


def json_safe(value):
    if isinstance(value, Decimal):
        return decimal_text(value)
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


def canonical(value) -> str:
    return json.dumps(json_safe(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("观察时间必须包含时区")
    return parsed.astimezone(timezone.utc)


def rows_from_payload(payload: dict, endpoint_name: str) -> list[dict]:
    endpoint = ENDPOINTS[endpoint_name]
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("缺少 data 对象")
    fields, items = data.get("fields"), data.get("items")
    if (not isinstance(fields, list) or not all(isinstance(f, str) for f in fields)
            or len(fields) != len(set(fields)) or not isinstance(items, list)):
        raise ValueError("响应字段或行格式无效")
    if items and not set(endpoint.required_fields) <= set(fields):
        raise ValueError("响应缺少标识、报告期或口径字段")
    rows = []
    for item in items:
        if not isinstance(item, list) or len(item) != len(fields):
            raise ValueError("响应行与字段数不符")
        rows.append(dict(zip(fields, item, strict=True)))
    return rows


def normalize_record(endpoint_name: str, row: dict, *, observed_at: str, params: dict | None = None) -> dict:
    endpoint = ENDPOINTS[endpoint_name]
    observed = timestamp(observed_at).isoformat(timespec="microseconds")
    if not set(endpoint.required_fields) <= set(row):
        raise ValueError("源记录缺少合同必需字段")
    code = str(row.get("ts_code") or "")
    if not CODE.fullmatch(code):
        raise ValueError("源记录证券代码无效")
    period = parse_date(row["end_date"]).isoformat() if row.get("end_date") else None
    if endpoint.family != "anns_d" and period is None:
        raise ValueError("源记录缺少报告期")
    published = [parse_date(row[key]) for key in ("ann_date", "f_ann_date") if row.get(key)]
    public_date = max(published).isoformat() if published else None
    report_type = str(row.get("report_type") or "")
    if endpoint.family in STATEMENTS and report_type not in {str(i) for i in range(1, 13)}:
        raise ValueError("源记录报表类型未知")
    company_type = str(row.get("comp_type") or "")
    if endpoint.family in STATEMENTS and company_type not in {"1", "2", "3", "4", "7"}:
        raise ValueError("源记录公司类型未知")
    scope = ("consolidated" if int(report_type) <= 5 else "parent") if report_type else "provider_defined"
    basis = ("quarter" if report_type in {"2", "3", "7", "8"} else "cumulative") if report_type else "provider_defined"
    if endpoint.family == "balancesheet":
        basis = "instant"
    dimensions = {k: json_safe(row[k]) for k in ("bz_item", "bz_code", "curr_type", "type") if k in row}
    if endpoint.family == "fina_mainbz":
        dimensions["requested_type"] = (params or {}).get("type")
    if endpoint.family == "anns_d":
        dimensions.update({k: row[k] for k in ("ann_date", "title", "url")})
    normalized_row = json_safe(row)
    facts = []
    for field in FINANCIAL_FIELDS:
        if field.endpoint != endpoint.family:
            continue
        raw_value = row.get(field.field)
        value = None if raw_value is None else decimal_text(raw_value)
        if field.field in normalized_row and value is not None:
            normalized_row[field.field] = value
        currency = str(row.get("curr_type") or field.currency or "") or None
        # Factors are powers of ten. Scaling with a sufficiently large context is exact.
        from decimal import localcontext
        with localcontext() as ctx:
            ctx.prec = max(50, len(value or "") + 20)
            scaled = None if value is None else decimal_text(Decimal(value) * Decimal(field.factor))
        facts.append({"metric_code": field.metric, "source_field": field.field, "raw_value": value,
                      "raw_unit": field.unit, "value": scaled, "unit": "元" if field.factor == "10000" else field.unit,
                      "currency": currency, "currency_basis": "source" if row.get("curr_type") else "contract" if currency else None,
                      "temporal": basis if field.temporal == "flow" else field.temporal,
                      "status": "absent" if field.field not in row else "null" if raw_value is None else "reported",
                      "applicable": field.applicable, "original_verified": False})
    logical = {"family": endpoint.family, "stock_code": code, "report_period": period,
               "report_type": report_type, "company_type": company_type, "scope": scope, "dimensions": dimensions}
    schema_hash = digest({"contract": CONTRACT_VERSION, "fields": sorted(row)})
    content_hash = digest(normalized_row)
    key = digest(logical)
    return {"id": digest([key, schema_hash, content_hash]), "logical_key": key, "schema_hash": schema_hash,
            "content_hash": content_hash, "contract_version": CONTRACT_VERSION, **logical,
            "period_basis": basis, "public_date": public_date, "public_date_basis": "provider_metadata" if public_date else "missing",
            "first_observed_at": observed, "historical_revision_verified": False,
            "raw_row": normalized_row, "facts": facts}


def validate_scope(row: dict, endpoint_name: str, params: dict, as_of: date) -> None:
    endpoint = ENDPOINTS[endpoint_name]
    if params.get("ts_code") and row.get("ts_code") != params["ts_code"]:
        raise ValueError("返回证券超出请求范围")
    period = params.get("period") or (params.get("end_date") if endpoint.family == "disclosure_date" else None)
    if period and row.get("end_date") != period:
        raise ValueError("返回报告期超出请求范围")
    for key in ("ann_date", "f_ann_date"):
        if row.get(key) and parse_date(row[key]) > as_of:
            raise ValueError("返回公告日期晚于研究截止日")
    if row.get("end_date") and endpoint.family not in {"disclosure_date", "forecast"} and parse_date(row["end_date"]) > as_of:
        raise ValueError("返回报告期晚于研究截止日")
    if endpoint.family == "anns_d":
        publication = parse_date(row["ann_date"])
        if params.get("start_date") and publication < parse_date(params["start_date"]):
            raise ValueError("公告早于请求窗口")
        if params.get("end_date") and publication > parse_date(params["end_date"]):
            raise ValueError("公告晚于请求窗口")


def select_version(records: list[dict], *, mode: Literal["latest", "as_of"], as_of: date | None = None) -> dict:
    """Resolve only a single logical key/schema; conflicting same-date rows stay unresolved."""
    if mode not in {"latest", "as_of"} or (mode == "as_of" and as_of is None):
        raise ValueError("历史查询必须指定截止日")
    if len({(r["logical_key"], r["schema_hash"]) for r in records}) > 1:
        raise ValueError("不能混合报表口径或字段合同选择版本")
    eligible = records
    if mode == "as_of":
        end = datetime.combine(as_of + timedelta(days=1), time(), ZONE)
        eligible = [r for r in records if timestamp(r["first_observed_at"]) < end
                    and (not r["public_date"] or date.fromisoformat(r["public_date"]) <= as_of)]
    if not eligible:
        return {"status": "historical_evidence_missing" if records else "missing", "record": None}
    latest_date = max(r["public_date"] or "" for r in eligible)
    candidates = {r["id"]: r for r in eligible if (r["public_date"] or "") == latest_date}
    if len(candidates) != 1:
        comparable = {digest({k: v for k, v in r["raw_row"].items() if k != "update_flag"}) for r in candidates.values()}
        if len(comparable) != 1:
            return {"status": "conflict", "record": None, "candidate_ids": sorted(candidates)}
    ids = sorted(candidates)
    return {"status": "selected", "record": candidates[ids[0]], "mode": mode,
            "equivalent_ids": ids if len(ids) > 1 else [],
            "availability_basis": "observed_snapshot" if mode == "as_of" else "provider_latest_date"}
