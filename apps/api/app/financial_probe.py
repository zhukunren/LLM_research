"""A resumable, at-most-74-request pilot; no bulk financial ingestion or PDF download."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from uuid import uuid4

from pydantic import Field, model_validator

from .db import connect, json_dump, utc_now
from .financial_contracts import ZONE, digest, normalize_record, rows_from_payload, validate_scope
from . import financial_store
from .screening_contracts import ContractModel
from .settings import tushare_settings
from .tushare_client import TushareClient, TushareError
from .tushare_endpoints import CONTRACT_VERSION, ENDPOINTS, manifest

PILOT_COMPANIES = (
    {"code": "600519.SH", "name": "贵州茅台", "category": "一般工商业", "reason": "消费品"},
    {"code": "000333.SZ", "name": "美的集团", "category": "一般工商业", "reason": "家电制造"},
    {"code": "300750.SZ", "name": "宁德时代", "category": "一般工商业", "reason": "电池制造"},
    {"code": "002594.SZ", "name": "比亚迪", "category": "一般工商业", "reason": "汽车制造"},
    {"code": "688981.SH", "name": "中芯国际", "category": "一般工商业", "reason": "半导体制造及单位核对"},
    {"code": "600031.SH", "name": "三一重工", "category": "一般工商业", "reason": "工程机械"},
    {"code": "000002.SZ", "name": "万科A", "category": "一般工商业", "reason": "房地产及利润符号边界"},
    {"code": "600036.SH", "name": "招商银行", "category": "银行", "reason": "银行口径"},
    {"code": "601318.SH", "name": "中国平安", "category": "保险", "reason": "保险口径"},
    {"code": "600030.SH", "name": "中信证券", "category": "证券", "reason": "证券口径"},
)
PILOT_ENDPOINTS = ("income", "balancesheet", "cashflow", "fina_indicator", "fina_audit", "disclosure_date", "anns_d",
                   "income_vip", "balancesheet_vip", "cashflow_vip", "fina_indicator_vip")


class ProbeRequest(ContractModel):
    request_id: str = Field(min_length=1, max_length=100)
    as_of: date = Field(default_factory=lambda: datetime.now(ZONE).date())
    period: date | None = None

    @model_validator(mode="after")
    def valid_period(self):
        self.period = self.period or date(self.as_of.year - 1, 12, 31)
        if self.period > self.as_of or (self.period.month, self.period.day) not in {(3, 31), (6, 30), (9, 30), (12, 31)}:
            raise ValueError("试点报告期必须为截止日前的季度末")
        return self


def credential_id() -> str:
    token = str(tushare_settings()["token"])
    return hashlib.sha256(("tushare:" + token).encode()).hexdigest() if token else "unconfigured"


def create_probe_client() -> TushareClient:
    from .tushare_limits import configured_limiter
    settings = tushare_settings()
    return TushareClient(str(settings["token"]), timeout=min(float(settings["timeout"]), 15), retries=0,
                         limiter=configured_limiter())


def samples(request: ProbeRequest) -> list[dict]:
    output = []
    for name in PILOT_ENDPOINTS:
        endpoint = ENDPOINTS[name]
        companies = PILOT_COMPANIES[:1] if endpoint.batch else PILOT_COMPANIES
        for company in companies:
            params = {"ts_code": company["code"]}
            if name == "anns_d":
                params.update(start_date=(request.as_of - timedelta(days=29)).strftime("%Y%m%d"), end_date=request.as_of.strftime("%Y%m%d"))
            else:
                params["end_date" if name == "disclosure_date" else "period"] = request.period.strftime("%Y%m%d")
            endpoint.validate(params)
            output.append({"key": digest([name, params]), "endpoint": name, "stock_code": company["code"],
                           "params": params, "fields": list(endpoint.fields)})
    return output


def start(request: ProbeRequest) -> dict:
    from .security_context import current_actor
    if not current_actor().platform_admin:
        from .security_context import AccessDenied
        raise AccessDenied("接口试点仅限平台维护者")
    parameters = request.model_dump(mode="json", exclude={"request_id"})
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        old = connection.execute("SELECT id,input_json FROM financial_probe_runs WHERE request_id=?", (request.request_id,)).fetchone()
        if old:
            if json.loads(old["input_json"])["parameters"] != parameters:
                raise ValueError("相同请求不能改变试点范围")
            return {"run_id": old["id"]}
        active = connection.execute("""SELECT r.id,r.input_json FROM financial_probe_runs r JOIN jobs j ON j.id=r.job_id
            WHERE j.state IN ('queued','running') ORDER BY r.created_at DESC LIMIT 1""").fetchone()
        if active:
            if json.loads(active["input_json"])["parameters"] != parameters:
                raise ValueError("已有不同范围的财务检查正在进行，请等待或停止后重试")
            return {"run_id": active["id"]}
        run_id, job_id, now = str(uuid4()), str(uuid4()), utc_now()
        frozen = {"parameters": parameters, "companies": list(PILOT_COMPANIES), "samples": samples(request),
                  "contract_version": CONTRACT_VERSION, "contract_hash": digest(manifest()), "contract": manifest()}
        connection.execute("""INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,required_protocol)
            VALUES(?,'financial_probe',?,'queued','等待检查财务接口与十家公司样本',?,?,'financial-probe-v1')""",
                           (job_id, json_dump({"probe_id": run_id}), now, now))
        connection.execute("INSERT INTO financial_probe_runs VALUES(?,?,?,?,?,?)",
                           (run_id, job_id, request.request_id, credential_id(), json_dump(frozen), now))
    return {"run_id": run_id}


def probe(sample: dict, as_of: date, client) -> tuple[dict, list[dict]]:
    now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    result = {**sample, "checked_at": now, "attempted": False, "status": "unknown", "record_ids": [],
              "received": 0, "coverage": "sample_only", "historical_revision_verified": False}
    records = []
    try:
        result["attempted"] = True
        snapshot = client.query_snapshot(sample["endpoint"], fields=",".join(sample["fields"]), **sample["params"])
        now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        result["checked_at"] = now
        result["response_hash"] = financial_store.save_response(snapshot.body)
        rows = rows_from_payload(snapshot.payload, sample["endpoint"])
        result["received"] = len(rows)
        issues = []
        for index, row in enumerate(rows):
            try:
                validate_scope(row, sample["endpoint"], sample["params"], as_of)
                records.append(normalize_record(sample["endpoint"], row, observed_at=now, params=sample["params"]))
            except (ValueError, TypeError, KeyError) as exc:
                issues.append({"row_index": index, "reason": str(exc)[:200]})
        endpoint = ENDPOINTS[sample["endpoint"]]
        result["possible_truncation"] = endpoint.row_limit is not None and len(rows) >= endpoint.row_limit
        result["issues"] = issues[:20]
        result["invalid_rows"] = len(issues)
        result["missing_fields"] = sorted(set(sample["fields"]) - set(snapshot.payload["data"]["fields"]))
        result["status"] = "contract_error" if issues or result["possible_truncation"] else "available" if records else "empty"
        result["message"] = {"available": "取得样本，源记录合同通过；尚未核对原文。",
                             "empty": "请求成功但样本为空，不能推断完整权限或没有披露。",
                             "contract_error": "部分样本口径、范围或完整性待核对。"}[result["status"]]
        result["record_ids"] = list(dict.fromkeys(record["id"] for record in records))
        result["sample_facts"] = [{"stock_code": r["stock_code"], "report_period": r["report_period"],
                                  "report_type": r["report_type"], "facts": r["facts"][:8]} for r in records[:2]]
    except TushareError as exc:
        result.update(status=exc.kind, message=str(exc), provider_code=exc.provider_code)
    except (ValueError, TypeError, KeyError) as exc:
        result.update(status="contract_error", message=str(exc)[:240])
    return result, records


def execute(lease) -> None:
    run = financial_store.read_run(lease.payload["probe_id"])
    if run["credential_id"] != credential_id() or run["input"]["contract_hash"] != digest(manifest()):
        lease.finish("partial", "凭据或接口合同已变化，请发起新检查；旧结果保留。")
        return
    finished = {c["key"]: c for c in run["checks"]}
    disabled = {c["endpoint"]: c for c in run["checks"] if c["status"] in {"denied", "rate_limited", "transient_error", "not_configured"}}
    try:
        client = create_probe_client()
        configuration_error = None
    except TushareError as exc:
        client, configuration_error = None, exc
    for index, sample in enumerate(run["input"]["samples"]):
        if not lease.active():
            return
        if sample["key"] in finished:
            continue
        if configuration_error:
            result = {**sample, "checked_at": utc_now(), "attempted": False, "status": configuration_error.kind,
                      "message": str(configuration_error), "record_ids": [], "coverage": "not_checked"}
            records = []
        elif sample["endpoint"] in disabled:
            previous = disabled[sample["endpoint"]]
            result = {**sample, "checked_at": utc_now(), "attempted": False, "status": "skipped",
                      "reason_status": previous["status"], "evidence_sample_key": previous["key"],
                      "message": "该接口本轮已拒绝或暂不可用，未重复请求；此公司未取得样本。",
                      "record_ids": [], "coverage": "not_checked"}
            records = []
        else:
            result, records = probe(sample, date.fromisoformat(run["input"]["parameters"]["as_of"]), client)
            if result["status"] in {"denied", "rate_limited", "transient_error", "not_configured"}:
                disabled[sample["endpoint"]] = result
        if not financial_store.save_check(run, sample["key"], result, records, lease=lease):
            return
        lease.progress((index + 1) / len(run["input"]["samples"]),
                       f"已检查 {index + 1}/{len(run['input']['samples'])} 项：{sample['endpoint']} {sample['stock_code']}")
    actual = financial_store.read_run(run["id"])
    incomplete = any(c["status"] not in {"available", "empty", "denied", "skipped"} for c in actual["checks"])
    lease.finish("partial" if incomplete else "succeeded",
                 f"接口检查完成：{actual['summary']['companies_with_rows']}/10 家取得样本；请查看权限与覆盖详情。")


def status() -> dict:
    from .security_context import current_actor
    cred = credential_id()
    with connect() as connection:
        capabilities = {r["endpoint"]: dict(r) for r in connection.execute(
            "SELECT endpoint,status,checked_at,evidence_run_id,evidence_sample_key FROM provider_capabilities WHERE credential_id=?", (cred,))}
        latest = connection.execute("SELECT id FROM financial_probe_runs ORDER BY created_at DESC,rowid DESC LIMIT 1").fetchone()
    run = financial_store.read_run(latest[0]) if latest else None
    if run:
        run["credential_matches"] = run.pop("credential_id") == cred
    return {"configured": cred != "unconfigured", "can_probe": current_actor().platform_admin, "contract_version": CONTRACT_VERSION,
            "companies": list(PILOT_COMPANIES),
            "capabilities": [{"endpoint": name, "label": ENDPOINTS[name].label,
                              **capabilities.get(name, {"status": "unknown", "checked_at": None})} for name in PILOT_ENDPOINTS],
            "latest": run}
