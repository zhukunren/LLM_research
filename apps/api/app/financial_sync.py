"""Ordinary-endpoint five-year ingestion with immutable checkpoints and bounded splits."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
from uuid import uuid4

from pydantic import Field, model_validator

from .db import connect, json_dump, utc_now
from .financial_contracts import canonical, digest, normalize_record, parse_date, rows_from_payload, timestamp, ZONE
from . import financial_facts, financial_probe, financial_store
from .tushare_endpoints import ENDPOINTS, manifest
from .tushare_client import TushareError
from .screening_contracts import ContractModel
from .security_context import AccessDenied, current_actor, can_write

ORDINARY_ENDPOINTS = financial_facts.FAMILIES
SUCCESS = {"completed", "empty", "split"}
MAX_PARTS = 2200


class SyncRequest(ContractModel):
    request_id: str = Field(min_length=1, max_length=100)
    as_of: date = Field(default_factory=lambda: datetime.now(ZONE).date())
    start_year: int | None = Field(None, ge=2000, le=2100)

    @model_validator(mode="after")
    def scope(self):
        self.start_year = self.start_year or self.as_of.year - 5
        if not 2001 <= self.as_of.year <= 2100 or not max(2001, self.as_of.year - 10) <= self.start_year <= self.as_of.year:
            raise ValueError("财务范围须在最近十年内")
        return self


def periods(first_year: int, cutoff: date) -> list[str]:
    return [day.isoformat() for year in range(first_year, cutoff.year + 1)
            for month, end in ((3, 31), (6, 30), (9, 30), (12, 31))
            if (day := date(year, month, end)) <= cutoff]


def _part(endpoint: str, code: str, params: dict, kind="range") -> dict:
    ENDPOINTS[endpoint].validate(params)
    return {"endpoint": endpoint, "stock_code": code, "params": params, "fields": list(ENDPOINTS[endpoint].fields),
            "kind": kind, "key": digest([endpoint, params])}


def plan(request: SyncRequest) -> list[dict]:
    parts = []
    first_year = request.start_year - 1
    for company in financial_probe.PILOT_COMPANIES:
        code = company["code"]
        for endpoint in ORDINARY_ENDPOINTS:
            # Annual slices keep the indicator's 100-row cap away from ordinary history.
            for year in range(first_year, request.as_of.year + 1):
                params = {"ts_code": code, "start_date": f"{year}0101",
                          "end_date": min(date(year, 12, 31), request.as_of).strftime("%Y%m%d")}
                if endpoint != "fina_indicator":
                    params["report_type"] = "1"
                parts.append(_part(endpoint, code, params))
            if endpoint != "fina_indicator":
                for report_type in ("4", "5"):
                    parts.append(_part(endpoint, code, {"ts_code": code, "start_date": f"{first_year}0101",
                                "end_date": request.as_of.strftime("%Y%m%d"), "report_type": report_type}, "comparative"))
    return parts


def _admin():
    if not current_actor().platform_admin:
        raise AccessDenied("批量财务采集仅限平台维护者")


def start(request: SyncRequest) -> dict:
    _admin()
    params = request.model_dump(mode="json", exclude={"request_id"})
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        old = connection.execute("SELECT id,input_json FROM financial_sync_runs WHERE request_id=?", (request.request_id,)).fetchone()
        if old:
            if json.loads(old["input_json"])["parameters"] != params:
                raise ValueError("相同请求不能更改采集范围")
            return {"run_id": old["id"]}
        active = connection.execute("""SELECT r.id,r.input_json FROM financial_sync_runs r JOIN jobs j ON j.id=r.job_id
            WHERE j.state IN ('queued','running') ORDER BY r.created_at DESC LIMIT 1""").fetchone()
        if active:
            if json.loads(active["input_json"])["parameters"] != params:
                raise ValueError("已有其他财务范围正在采集，请等待或停止后再试")
            return {"run_id": active["id"]}
        financial_facts.backfill_existing(connection)
        run_id, job, now = str(uuid4()), str(uuid4()), utc_now()
        frozen = {"parameters": params, "companies": list(financial_probe.PILOT_COMPANIES),
                  "support_year": request.start_year - 1, "contract": manifest(), "contract_hash": digest(manifest())}
        connection.execute("""INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,required_protocol)
            VALUES(?,'financial_sync',?,'queued','等待建立十家公司财务序列',?,?,'financial-sync-v1')""",
                           (job, json_dump({"financial_run_id": run_id}), now, now))
        connection.execute("INSERT INTO financial_sync_runs VALUES(?,?,?,?,?,0,?)",
                           (run_id, job, request.request_id, financial_probe.credential_id(), json_dump(frozen), now))
        for part in plan(request):
            connection.execute("INSERT INTO financial_sync_parts VALUES(?,?,?,NULL)", (run_id, part["key"], json_dump(part)))
    return {"run_id": run_id}


def read_run(run_id: str) -> dict:
    with connect() as connection:
        row = connection.execute("""SELECT r.*,j.state,j.message,j.progress,j.updated_at FROM financial_sync_runs r
            JOIN jobs j ON j.id=r.job_id WHERE r.id=?""", (run_id,)).fetchone()
        if not row:
            raise LookupError("找不到此财务采集")
        result = dict(row)
        result["input"] = json.loads(result.pop("input_json"))
        items = connection.execute("""SELECT p.request_json,a.attempt,a.result_json FROM financial_sync_parts p
            LEFT JOIN financial_sync_attempts a ON a.run_id=p.run_id AND a.part_key=p.part_key AND a.attempt=
            (SELECT MAX(x.attempt) FROM financial_sync_attempts x WHERE x.run_id=p.run_id AND x.part_key=p.part_key)
            WHERE p.run_id=? ORDER BY p.rowid""", (run_id,)).fetchall()
        result["parts"] = [{**json.loads(r["request_json"]), "attempt": r["attempt"] or 0,
                            "result": json.loads(r["result_json"]) if r["result_json"] else None} for r in items]
        observed = connection.execute("SELECT COUNT(DISTINCT record_id) FROM financial_sync_observations WHERE run_id=?", (run_id,)).fetchone()[0]
        attempts = connection.execute("SELECT COUNT(*) FROM financial_sync_attempts WHERE run_id=?", (run_id,)).fetchone()[0]
    counts = {}
    for part in result["parts"]:
        state = (part["result"] or {}).get("status", "pending")
        counts[state] = counts.get(state, 0) + 1
    result["summary"] = {"planned": len(items), "finished": len(items) - counts.get("pending", 0),
                         "attempts": attempts, "source_versions": observed, "states": counts}
    return result


def retry(run_id: str) -> dict:
    _admin()
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("""SELECT r.*,j.state FROM financial_sync_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=?""", (run_id,)).fetchone()
        if not row:
            raise LookupError("找不到此财务采集")
        if row["state"] in {"queued", "running"}:
            return {"run_id": run_id, "job_id": row["job_id"]}
        if row["credential_id"] != financial_probe.credential_id() or json.loads(row["input_json"])["contract_hash"] != digest(manifest()):
            raise ValueError("凭据或合同已变化，请新建采集以保留原运行证据")
        job, now = str(uuid4()), utc_now()
        connection.execute("""INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,retry_of,required_protocol)
            VALUES(?,'financial_sync',?,'queued','等待继续财务采集',?,?,?,'financial-sync-v1')""",
                           (job, json_dump({"financial_run_id": run_id}), now, now, row["job_id"]))
        connection.execute("UPDATE financial_sync_runs SET job_id=?,fallback_planned=0 WHERE id=?", (job, run_id))
    return {"run_id": run_id, "job_id": job}


def _owned(connection, lease) -> bool:
    return connection.execute("SELECT 1 FROM jobs WHERE id=? AND state='running' AND lease_owner=? AND lease_expires_at>?",
                              (lease.id, lease.owner, utc_now())).fetchone() is not None


def collect(part: dict, frozen: dict, client) -> tuple[dict, list[dict], list[dict]]:
    endpoint, params = part["endpoint"], part["params"]
    cutoff = date.fromisoformat(frozen["parameters"]["as_of"])
    record_start = f"{frozen['support_year']}-01-01"
    result = {"status": "unknown", "attempted": True, "received": 0, "accepted": 0, "issues": [], "excluded": {},
              "revision_history_complete": False}
    try:
        snapshot = client.query_snapshot(endpoint, fields=",".join(part["fields"]), **params)
        now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        result.update(observed_at=now, response_hash=financial_store.save_response(snapshot.body))
        rows = rows_from_payload(snapshot.payload, endpoint)
        result["received"] = len(rows)
        # A conservative guard also applies where the vendor does not publish a stable cap.
        ceiling = ENDPOINTS[endpoint].row_limit or 100
        if len(rows) >= ceiling:
            if params.get("start_date") and params.get("end_date"):
                left, right = parse_date(params["start_date"]), parse_date(params["end_date"])
                if left < right:
                    middle = left + (right - left) // 2
                    children = [_part(endpoint, part["stock_code"], {**params, "start_date": a.strftime("%Y%m%d"), "end_date": b.strftime("%Y%m%d")}, part["kind"])
                                for a, b in ((left, middle), (middle + timedelta(days=1), right))]
                    result["status"] = "split"
                    return result, [], children
            result.update(status="truncated", message="最小分片仍触及返回条数边界，未宣称完整")
            return result, [], []
        records = []
        for index, row in enumerate(rows):
            try:
                if row.get("ts_code") != part["stock_code"]:
                    raise ValueError("证券不符合请求范围")
                period = parse_date(row.get("end_date")).isoformat()
                if period < record_start or period > cutoff.isoformat():
                    result["excluded"]["report_window"] = result["excluded"].get("report_window", 0) + 1
                    continue
                if params.get("period") and row.get("end_date") != params["period"]:
                    raise ValueError("报告期不符合请求范围")
                if params.get("report_type") and str(row.get("report_type")) != params["report_type"]:
                    raise ValueError("供应商返回了其他报表类型")
                for field in ("ann_date", "f_ann_date"):
                    if row.get(field) and parse_date(row[field]) > cutoff:
                        raise ValueError("公告日期晚于采集截止日")
                if not row.get("ann_date"):
                    raise ValueError("缺少公告日期")
                range_field = "end_date" if endpoint == "fina_indicator" else "ann_date"
                if params.get("start_date") and not params["start_date"] <= str(row.get(range_field)) <= params["end_date"]:
                    raise ValueError("返回日期不符合该接口的筛选语义")
                if (parse_date(row["end_date"]).month, parse_date(row["end_date"]).day) not in {(3, 31), (6, 30), (9, 30), (12, 31)}:
                    raise ValueError("报告期不是季度末")
                records.append(normalize_record(endpoint, row, observed_at=now, params=params))
            except (ValueError, TypeError, KeyError) as exc:
                result["issues"].append({"row": index, "reason": str(exc)[:180]})
        result.update(status="contract_error" if result["issues"] else "completed" if records else "empty",
                      accepted=len(records), record_ids=sorted({r["id"] for r in records}),
                      missing_fields=sorted(set(part["fields"]) - set(snapshot.payload["data"]["fields"])))
        return result, records, []
    except TushareError as exc:
        result.update(status=exc.kind, message=str(exc), provider_code=exc.provider_code)
    except (ValueError, TypeError, KeyError) as exc:
        result.update(status="contract_error", message=str(exc)[:240])
    result["observed_at"] = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    return result, [], []


def _save(lease, run_id: str, part: dict, result: dict, records: list[dict], children: list[dict]) -> bool:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if not _owned(connection, lease):
            return False
        count = connection.execute("SELECT COUNT(*) FROM financial_sync_parts WHERE run_id=?", (run_id,)).fetchone()[0]
        if count + len(children) > MAX_PARTS:
            result["status"], children = "truncated", []
            result["message"] = "分片达到本轮预算，需缩小范围重试"
        attempt = connection.execute("SELECT COALESCE(MAX(attempt),0)+1 FROM financial_sync_attempts WHERE run_id=? AND part_key=?", (run_id, part["key"])).fetchone()[0]
        connection.execute("INSERT INTO financial_sync_attempts VALUES(?,?,?,?,?)",
                           (run_id, part["key"], attempt, canonical(result), result["observed_at"]))
        for record in records:
            financial_facts.materialize(connection, record)
            connection.execute("INSERT OR IGNORE INTO financial_sync_observations VALUES(?,?,?,?,?,?)",
                               (run_id, part["key"], attempt, record["id"], result["response_hash"], result["observed_at"]))
        for child in children:
            connection.execute("INSERT OR IGNORE INTO financial_sync_parts VALUES(?,?,?,?)",
                               (run_id, child["key"], json_dump(child), part["key"]))
    return True


def _fallbacks(lease, run: dict, disabled: set[str]) -> bool:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if not _owned(connection, lease):
            return False
        if connection.execute("SELECT fallback_planned FROM financial_sync_runs WHERE id=?", (run["id"],)).fetchone()[0]:
            return True
        seen = {(r["stock_code"], r["family"], r["report_period"]) for r in connection.execute("""SELECT DISTINCT f.stock_code,f.family,f.report_period
            FROM financial_facts f JOIN financial_sync_observations o ON o.record_id=f.record_id
            WHERE o.run_id=? AND (f.report_type='1' OR f.family='fina_indicator')""", (run["id"],))}
        for company in run["input"]["companies"]:
            for endpoint in ORDINARY_ENDPOINTS:
                if endpoint in disabled:
                    continue
                for period in periods(run["input"]["support_year"], date.fromisoformat(run["input"]["parameters"]["as_of"])):
                    if (company["code"], endpoint, period) in seen:
                        continue
                    params = {"ts_code": company["code"], "period": period.replace("-", "")}
                    if endpoint != "fina_indicator":
                        params["report_type"] = "1"
                    part = _part(endpoint, company["code"], params, "missing_period")
                    connection.execute("INSERT OR IGNORE INTO financial_sync_parts VALUES(?,?,?,NULL)", (run["id"], part["key"], json_dump(part)))
        connection.execute("UPDATE financial_sync_runs SET fallback_planned=1 WHERE id=?", (run["id"],))
    return True


def execute(lease):
    run = read_run(lease.payload["financial_run_id"])
    if run["job_id"] != lease.id:
        lease.finish("cancelled", "已有新的财务采集任务")
        return
    if run["credential_id"] != financial_probe.credential_id() or run["input"]["contract_hash"] != digest(manifest()):
        lease.finish("partial", "凭据或接口合同已变化，请重新建立采集")
        return
    try:
        client = financial_probe.create_probe_client()
    except TushareError as exc:
        lease.finish("partial", str(exc))
        return
    visited, disabled = set(), {}
    while lease.active():
        run = read_run(run["id"])
        pending = [p for p in run["parts"] if p["key"] not in visited and (not p["result"] or p["result"]["status"] not in SUCCESS)]
        if not pending:
            if not run["fallback_planned"]:
                if not _fallbacks(lease, run, set(disabled)):
                    return
                continue
            break
        part = pending[0]
        visited.add(part["key"])
        if part["endpoint"] in disabled:
            result = {"status": "deferred", "attempted": False, "message": "该接口本轮已受限或失败，保留分片供重试",
                      "reason": disabled[part["endpoint"]], "observed_at": utc_now(), "received": 0, "accepted": 0}
            records, children = [], []
        else:
            result, records, children = collect(part, run["input"], client)
            if result["status"] in {"denied", "rate_limited", "transient_error", "not_configured"}:
                disabled[part["endpoint"]] = result["status"]
        if not _save(lease, run["id"], part, result, records, children):
            return
        lease.progress(min(.99, (run["summary"]["finished"] + (not part["result"])) / max(1, run["summary"]["planned"])),
                       f"{part['stock_code']} {part['endpoint']} · 已处理 {len(visited)} 个分片")
    if lease.active():
        completed = read_run(run["id"])
        failures = sum(n for state, n in completed["summary"]["states"].items() if state not in SUCCESS)
        lease.finish("partial" if failures else "succeeded",
                     f"财务采集{'部分完成' if failures else '完成'}，保存 {completed['summary']['source_versions']} 个源记录版本；覆盖以各报告期为准")


def status() -> dict:
    with connect() as connection:
        latest = connection.execute("SELECT id FROM financial_sync_runs ORDER BY created_at DESC,rowid DESC LIMIT 1").fetchone()
        counts = [dict(r) for r in connection.execute("""SELECT stock_code,COUNT(DISTINCT report_period) periods,
            COUNT(DISTINCT record_id) source_versions,COUNT(*) facts FROM financial_facts GROUP BY stock_code""")]
    run = read_run(latest[0]) if latest else None
    if run:
        run["credential_matches"] = run.pop("credential_id") == financial_probe.credential_id()
    return {"companies": list(financial_probe.PILOT_COMPANIES), "coverage": counts, "latest": run,
            "can_sync": current_actor().platform_admin, "can_save": can_write(current_actor()),
            "endpoints": list(ORDINARY_ENDPOINTS)}
