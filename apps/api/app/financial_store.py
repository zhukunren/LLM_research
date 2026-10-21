"""Workspace-scoped snapshots and immutable row versions used by bounded probes."""
from __future__ import annotations

import hashlib
import json
import os
from uuid import uuid4

from .db import connect, json_dump, utc_now
from .financial_contracts import canonical, select_version, timestamp
from .storage import application_paths


def save_response(body: bytes) -> str:
    sha = hashlib.sha256(body).hexdigest()
    root = application_paths().evidence_root / "financial-sources" / "responses"
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{sha}.json"
    if not target.exists():
        temp = root / f".{uuid4().hex}.tmp"
        try:
            with temp.open("xb") as output:
                output.write(body)
                output.flush()
                os.fsync(output.fileno())
            try:
                os.link(temp, target)
            except FileExistsError:
                pass
        finally:
            temp.unlink(missing_ok=True)
    if hashlib.sha256(target.read_bytes()).hexdigest() != sha:
        raise ValueError("财务原始响应完整性检查失败")
    return sha


def save_check(run: dict, sample_key: str, result: dict, records: list[dict], *, lease=None) -> bool:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if lease and not connection.execute(
            "SELECT 1 FROM jobs WHERE id=? AND state='running' AND lease_owner=? AND lease_expires_at>?",
            (lease.id, lease.owner, utc_now())
        ).fetchone():
            return False
        if connection.execute("SELECT 1 FROM financial_probe_checks WHERE run_id=? AND sample_key=?", (run["id"], sample_key)).fetchone():
            return True
        connection.execute("INSERT INTO financial_probe_checks VALUES(?,?,?,?,?,?)",
                           (run["id"], sample_key, result["endpoint"], result["stock_code"], json_dump(result), result["checked_at"]))
        for record in records:
            connection.execute("INSERT OR IGNORE INTO financial_source_records VALUES(?,?,?,?,?,?)",
                               (record["id"], record["logical_key"], record["schema_hash"], record["content_hash"],
                                canonical(record), record["first_observed_at"]))
            connection.execute("INSERT OR IGNORE INTO financial_source_observations VALUES(?,?,?,?,?)",
                               (run["id"], sample_key, record["id"], result["response_hash"], result["checked_at"]))
        if result["attempted"]:
            status = result["status"] if result["status"] in {"available", "denied", "rate_limited", "transient_error"} else "unknown"
            old = connection.execute("SELECT status FROM provider_capabilities WHERE credential_id=? AND endpoint=?",
                                     (run["credential_id"], result["endpoint"])).fetchone()
            # An empty scope cannot erase positive evidence in this credential's history.
            if not (result["status"] == "empty" and old and old["status"] == "available"):
                connection.execute("""INSERT INTO provider_capabilities VALUES(?,?,?,?,?,?)
                    ON CONFLICT(credential_id,endpoint) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,
                    evidence_run_id=excluded.evidence_run_id,evidence_sample_key=excluded.evidence_sample_key""",
                                   (run["credential_id"], result["endpoint"], status, result["checked_at"], run["id"], sample_key))
    return True


def read_versions(logical_key: str, schema_hash: str) -> list[dict]:
    with connect() as connection:
        return [json.loads(row[0]) for row in connection.execute(
            "SELECT record_json FROM financial_source_records WHERE logical_key=? AND schema_hash=? ORDER BY first_observed_at,id",
            (logical_key, schema_hash))]


def read_run(run_id: str) -> dict:
    with connect() as connection:
        row = connection.execute("""SELECT r.*,j.state,j.message,j.progress,j.updated_at FROM financial_probe_runs r
            JOIN jobs j ON j.id=r.job_id WHERE r.id=?""", (run_id,)).fetchone()
        if not row:
            raise LookupError("找不到此试点")
        result = dict(row)
        result["input"] = json.loads(result.pop("input_json"))
        result["checks"] = [json.loads(r[0]) for r in connection.execute(
            "SELECT result_json FROM financial_probe_checks WHERE run_id=? ORDER BY checked_at,sample_key", (run_id,))]
        records = [json.loads(r[0]) for r in connection.execute("""SELECT DISTINCT s.record_json
            FROM financial_source_records s JOIN financial_source_observations o ON o.record_id=s.id
            WHERE o.run_id=?""", (run_id,))]
    checks = result["checks"]
    checks.sort(key=lambda item: (timestamp(item["checked_at"]), item["key"]))
    result["summary"] = {
        "planned": len(result["input"]["samples"]), "checked": len(checks),
        "attempted": sum(c["attempted"] for c in checks),
        "available": sum(c["status"] == "available" for c in checks),
        "empty": sum(c["status"] == "empty" for c in checks),
        "denied": sum(c["status"] == "denied" for c in checks),
        "skipped": sum(c["status"] == "skipped" for c in checks),
        "source_versions": len({rid for c in checks for rid in c.get("record_ids", [])}),
        "companies_with_rows": len({c["stock_code"] for c in checks if c.get("record_ids")}),
    }
    groups = {}
    for record in records:
        groups.setdefault((record["logical_key"], record["schema_hash"]), []).append(record)
    resolutions = []
    for versions in groups.values():
        if len(versions) <= 1:
            continue
        chosen = select_version(versions, mode="latest")
        resolutions.append({"stock_code": versions[0]["stock_code"], "family": versions[0]["family"],
                            "report_type": versions[0]["report_type"], "version_count": len(versions),
                            "status": "equivalent" if chosen.get("equivalent_ids") else chosen["status"],
                            "record_ids": sorted(r["id"] for r in versions)})
    result["version_resolution"] = resolutions
    result["summary"]["equivalent_groups"] = sum(r["status"] == "equivalent" for r in resolutions)
    result["summary"]["conflict_groups"] = sum(r["status"] == "conflict" for r in resolutions)
    result["comparisons"] = []
    for vip in (c for c in checks if c["endpoint"].endswith("_vip")):
        ordinary = next((c for c in checks if c["endpoint"] == vip["endpoint"][:-4] and c["stock_code"] == vip["stock_code"]), None)
        comparable = ordinary and ordinary["status"] == "available" and vip["status"] == "available"
        result["comparisons"].append({"family": vip["endpoint"][:-4], "stock_code": vip["stock_code"],
                                      "status": ("equal" if set(ordinary["record_ids"]) == set(vip["record_ids"]) else "different") if comparable else "unverified"})
    result["note"] = "有界样本验证，不代表全市场或五年覆盖；原文数值和供应商历史修订尚未核验。"
    return result
