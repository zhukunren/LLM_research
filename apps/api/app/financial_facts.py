"""Indexed, immutable normalized facts backed by exact source-row versions."""
from __future__ import annotations

import json
from .db import connect
from .financial_contracts import canonical, digest

NORMALIZATION_VERSION = "financial-facts-v1"
FAMILIES = ("income", "balancesheet", "cashflow", "fina_indicator")


def materialize(connection, record: dict) -> None:
    if record["family"] not in FAMILIES or not record.get("report_period"):
        return
    connection.execute("INSERT OR IGNORE INTO financial_source_records VALUES(?,?,?,?,?,?)",
                       (record["id"], record["logical_key"], record["schema_hash"], record["content_hash"],
                        canonical(record), record["first_observed_at"]))
    rows = []
    for original in record["facts"]:
        fact = dict(original)
        fact_id = digest([record["id"], fact["metric_code"], NORMALIZATION_VERSION])
        fact.update(id=fact_id, record_id=record["id"], normalization_version=NORMALIZATION_VERSION)
        rows.append((fact_id, record["id"], fact["metric_code"], record["stock_code"], record["report_period"],
                     record["family"], record["report_type"], record["scope"], record["company_type"],
                     fact["value"], fact["unit"], fact["currency"], fact["temporal"], fact["status"],
                     canonical(fact), NORMALIZATION_VERSION))
    connection.executemany("INSERT OR IGNORE INTO financial_facts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)


def backfill_existing(connection) -> None:
    rows = connection.execute("""SELECT record_json FROM financial_source_records s WHERE NOT EXISTS
        (SELECT 1 FROM financial_facts f WHERE f.record_id=s.id AND f.normalization_version=?)""", (NORMALIZATION_VERSION,)).fetchall()
    for row in rows:
        materialize(connection, json.loads(row[0]))


def read_company(code: str) -> tuple[list[dict], dict[str, dict]]:
    with connect() as connection:
        rows = connection.execute("""SELECT DISTINCT s.id,s.record_json FROM financial_source_records s
            JOIN financial_facts f ON f.record_id=s.id WHERE f.stock_code=? AND f.normalization_version=?""",
                                  (code, NORMALIZATION_VERSION)).fetchall()
        facts = {r["id"]: json.loads(r["fact_json"]) for r in connection.execute(
            "SELECT id,fact_json FROM financial_facts WHERE stock_code=? AND normalization_version=?", (code, NORMALIZATION_VERSION))}
    return [json.loads(r["record_json"]) for r in rows], facts


def provenance(fact_id: str) -> dict:
    with connect() as connection:
        row = connection.execute("""SELECT f.fact_json,s.record_json FROM financial_facts f
            JOIN financial_source_records s ON s.id=f.record_id WHERE f.id=?""", (fact_id,)).fetchone()
        if not row:
            raise LookupError("找不到此财务事实")
        fact, record = json.loads(row[0]), json.loads(row[1])
        observations = [dict(item) for item in connection.execute("""SELECT run_id,part_key,attempt,response_hash,observed_at
            FROM financial_sync_observations WHERE record_id=? ORDER BY observed_at""", (record["id"],))]
        probes = [dict(item) for item in connection.execute("""SELECT run_id,sample_key,response_hash,observed_at
            FROM financial_source_observations WHERE record_id=? ORDER BY observed_at""", (record["id"],))]
    from .financial_evidence import links
    originals = links(fact_id)
    return {"fact": fact, "record": record, "observations": observations, "pilot_observations": probes,
            "original_evidence": originals,
            "note": "单位来自接口合同；原文关联与数值核对分别展示，原文数值核对不自动证明供应商历史修订链。"}
