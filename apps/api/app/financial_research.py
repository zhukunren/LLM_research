"""Aligned financial comparison snapshots, independent of model-generated conclusions."""
from __future__ import annotations

from datetime import date
from typing import Literal
from pydantic import Field, model_validator

from . import financial_metrics, financial_evidence, research_projects
from .db import connect, utc_now
from .financial_contracts import canonical, digest
from .screening_contracts import ContractModel


class ComparisonRequest(ContractModel):
    stock_codes: list[str] = Field(min_length=3, max_length=5)
    as_of: date
    start_year: int | None = None
    basis: Literal["annual", "cumulative", "quarter", "ttm"] = "annual"
    mode: Literal["latest", "as_of"] = "as_of"
    metrics: list[str] = Field(default_factory=lambda: ["revenue", "parent_net_profit", "operating_cashflow", "assets"], min_length=1, max_length=10)
    project_id: str | None = Field(None, max_length=100)

    @model_validator(mode="after")
    def validate_scope(self):
        if len(set(self.stock_codes)) != len(self.stock_codes):
            raise ValueError("比较公司不能重复")
        for code in self.stock_codes:
            financial_metrics.FinancialQuery(stock_code=code, as_of=self.as_of, start_year=self.start_year,
                basis=self.basis, mode=self.mode, metrics=self.metrics)
        return self


def compare(request: ComparisonRequest, *, results=None) -> dict:
    if request.project_id:
        from .company_research import _require_company
        with connect() as connection:
            for code in request.stock_codes:
                _require_company(connection, request.project_id, code)
    calculations = results or [financial_metrics.calculate(financial_metrics.FinancialQuery(
        stock_code=code, as_of=request.as_of, start_year=request.start_year, basis=request.basis, mode=request.mode, metrics=request.metrics)) for code in request.stock_codes]
    with connect() as connection:
        names = {row["stock_code"]: row["name"] for row in connection.execute("SELECT stock_code,name FROM security_catalog")}
    result = {"request": request.model_dump(mode="json"), "companies": [{"stock_code": code, "name": names.get(code, code)} for code in request.stock_codes],
              "metrics": calculations[0]["metrics"], "calculations": calculations,
              "note": "各公司使用相同截止日、期间口径与单位；行业不适用、历史证据缺口及重述冲突保留为空，不自动排名。"}
    result["id"] = digest(result)
    return result


def save_comparison(request: ComparisonRequest, expected_id: str | None = None) -> dict:
    financial_evidence.writable()
    if request.project_id:
        with connect() as connection:
            research_projects._require_project(connection, request.project_id, writable=True)
    result = compare(request)
    if expected_id and expected_id != result["id"]:
        raise financial_evidence.EvidenceError("比较来源已变化，请重新读取后保存", 409)
    return store_comparison(result)


def store_comparison(result: dict) -> dict:
    for calculation in result["calculations"]:
        financial_metrics.store_result(calculation)
    with connect() as connection:
        connection.execute("INSERT OR IGNORE INTO financial_comparisons VALUES(?,?,?,?,?)",
                           (result["id"], result["request"].get("project_id"), canonical(result["request"]), canonical(result), utc_now()))
    return {**result, "saved": True}


def read_comparison(comparison_id: str) -> dict:
    import json
    with connect() as connection:
        row = connection.execute("SELECT result_json,project_id FROM financial_comparisons WHERE id=?", (comparison_id,)).fetchone()
        if not row:
            raise financial_evidence.EvidenceError("找不到保存的财务比较", 404)
        if row["project_id"]:
            research_projects._require_project(connection, row["project_id"])
    return {**json.loads(row["result_json"]), "saved": True}
