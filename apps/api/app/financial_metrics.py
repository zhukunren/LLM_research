"""Deterministic financial series with explicit units, missingness and input lineage."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, localcontext
import json
from typing import Literal

from pydantic import Field, model_validator

from .db import connect, utc_now
from . import financial_facts, financial_sync
from .financial_contracts import canonical, decimal_text, digest, select_version, timestamp, ZONE
from .tushare_endpoints import FINANCIAL_FIELDS
from .screening_contracts import ContractModel
from .security_context import AccessDenied, can_write, current_actor

FORMULA_VERSION = "financial-series-v1"
FIELDS = {f.metric: f for f in FINANCIAL_FIELDS if f.endpoint in financial_facts.FAMILIES}
DERIVED = {
    "gross_margin": ("计算毛利率", "%", "industrial"),
    "net_margin": ("合并净利率", "%", "industrial"),
    "cash_conversion": ("经营现金流/合并净利润", "倍", "industrial"),
    "debt_ratio": ("资产负债率", "%", "all"),
    "cash_after_capex": ("经营现金流减购建长期资产现金", "元", "industrial"),
    "revenue_yoy": ("营业收入同比", "%", "all"),
    "parent_net_profit_yoy": ("归母净利润同比", "%", "all"),
    "operating_cashflow_yoy": ("经营现金流同比", "%", "all"),
}
DEFAULT_METRICS = ["revenue", "parent_net_profit", "deducted_net_profit", "operating_cashflow",
                   "receivables", "inventories", "cash", "assets", "liabilities", "parent_equity"]
REASONS = {
    "ok": "可用", "no_record": "未取得该期源记录", "no_primary_statement": "缺少同口径合并报表",
    "historical_evidence_missing": "缺少当时可得的版本证据", "not_announced_by_cutoff": "源记录公告日期晚于截止日",
    "conflict": "同日版本内容冲突，待核对", "scope_or_contract_conflict": "存在不同公司类型或字段合同，待核对",
    "source_null": "供应商字段为空", "field_absent": "供应商未返回字段",
    "dependency_missing": "计算所需期间或字段缺失", "incompatible_unit_or_scope": "单位、币种或报表口径不一致",
    "comparability_unverified": "存在不同的重述比较数据，需先核对可比口径",
    "unsupported_basis": "该比率不能由累计数差分或相加", "not_applicable": "通用指标不适用于该公司类型",
    "industry_unknown": "缺少公司类型依据", "zero_denominator": "分母为零",
    "nonpositive_denominator": "分母非正，不输出普通比率", "nonpositive_base": "基期非正，不输出普通同比百分比",
    "unit_unconfirmed": "源字段单位未确认",
    "currency_conversion_required": "币种不是 CNY，缺少经核验的换算口径",
}


def catalog() -> list[dict]:
    return ([{"code": f.metric, "label": f.label, "unit": f.unit, "temporal": f.temporal, "applicable": f.applicable}
             for f in FIELDS.values()] +
            [{"code": code, "label": value[0], "unit": value[1], "temporal": "derived", "applicable": value[2]}
             for code, value in DERIVED.items()])


class FinancialQuery(ContractModel):
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    as_of: date = Field(default_factory=lambda: datetime.now(ZONE).date())
    start_year: int | None = Field(None, ge=2000, le=2100)
    basis: Literal["annual", "cumulative", "quarter", "ttm"] = "annual"
    mode: Literal["latest", "as_of"] = "latest"
    metrics: list[str] = Field(default_factory=lambda: list(DEFAULT_METRICS), min_length=1, max_length=40)

    @model_validator(mode="after")
    def valid(self):
        self.start_year = self.start_year or self.as_of.year - 5
        if not 2001 <= self.as_of.year <= 2100 or not max(2000, self.as_of.year - 10) <= self.start_year <= self.as_of.year:
            raise ValueError("查询年度须在截至日前十年内")
        if len(set(self.metrics)) != len(self.metrics) or any(m not in FIELDS and m not in DERIVED for m in self.metrics):
            raise ValueError("指标重复或不在已验证的财务指标合同中")
        return self


def previous_quarter(period: str) -> str:
    value = date.fromisoformat(period)
    return {6: f"{value.year}-03-31", 9: f"{value.year}-06-30", 12: f"{value.year}-09-30"}[value.month]


class Calculator:
    def __init__(self, query: FinancialQuery, records: list[dict], facts: dict[str, dict]):
        self.query, self.records, self.facts = query, records, facts
        self.groups = {}
        for record in records:
            self.groups.setdefault((record["family"], record["report_period"], record["report_type"]), []).append(record)
        self.raw_cache, self.point_cache = {}, {}

    def missing(self, metric, period, status, **extra):
        unit = FIELDS[metric].unit if metric in FIELDS else DERIVED[metric][1]
        return {"metric": metric, "period": period, "value": None, "unit": unit, "currency": None,
                "status": status, "reason": REASONS.get(status, status), "input_fact_ids": [],
                "source_record_ids": [], "formula": None, **extra}

    def _select(self, family, period, report_type):
        records = self.groups.get((family, period, report_type), [])
        if not records:
            return {"status": "no_record", "record": None}
        if self.query.mode == "as_of":
            eligible = [r for r in records if timestamp(r["first_observed_at"]).astimezone(ZONE).date() <= self.query.as_of
                        and (not r["public_date"] or r["public_date"] <= self.query.as_of.isoformat())]
            if not eligible:
                return {"status": "historical_evidence_missing", "record": None}
        else:
            eligible = [r for r in records if r["public_date"] and r["public_date"] <= self.query.as_of.isoformat()]
            if not eligible:
                return {"status": "not_announced_by_cutoff", "record": None}
        if len({(r["logical_key"], r["schema_hash"]) for r in eligible}) != 1:
            return {"status": "scope_or_contract_conflict", "record": None}
        return select_version(eligible, mode=self.query.mode, as_of=self.query.as_of)

    def raw(self, metric: str, period: str) -> dict:
        key = metric, period
        if key in self.raw_cache:
            return self.raw_cache[key]
        field = FIELDS[metric]
        report_type = "" if field.endpoint == "fina_indicator" else "1"
        chosen = self._select(field.endpoint, period, report_type)
        record = chosen.get("record")
        if not record:
            result = self.missing(metric, period, chosen["status"], candidate_ids=chosen.get("candidate_ids", []))
        else:
            fact_id = digest([record["id"], metric, financial_facts.NORMALIZATION_VERSION])
            fact = self.facts.get(fact_id)
            if not fact:
                result = self.missing(metric, period, "field_absent")
            else:
                ids = chosen.get("equivalent_ids") or [record["id"]]
                inputs = sorted(digest([rid, metric, financial_facts.NORMALIZATION_VERSION]) for rid in ids)
                state = "ok" if fact["status"] == "reported" and fact["value"] is not None else "source_null" if fact["status"] == "null" else "field_absent"
                if state == "ok" and fact["unit"] == "元" and fact["currency"] != "CNY":
                    state = "currency_conversion_required"
                result = {"metric": metric, "period": period, "value": fact["value"] if state == "ok" else None,
                          "unit": fact["unit"], "currency": fact["currency"], "currency_basis": fact.get("currency_basis"),
                          "status": state, "reason": REASONS[state], "input_fact_ids": inputs,
                          "source_record_ids": ids, "formula": "reported", "actual_basis": fact["temporal"],
                          "scope": record["scope"], "company_type": record["company_type"],
                          "publication_date": record["public_date"], "first_observed_at": record["first_observed_at"],
                          "schema_hash": record["schema_hash"], "comparability": "provider_same_scope",
                          "original_verified": False}
                # Newer comparative restatements cannot be silently mixed into old current-period series.
                if field.endpoint != "fina_indicator" and state == "ok":
                    alternate = self._select(field.endpoint, period, "4")
                    alternative = alternate.get("record")
                    if alternative and (alternative["public_date"] or "") >= (record["public_date"] or ""):
                        alt_fact = self.facts.get(digest([alternative["id"], metric, financial_facts.NORMALIZATION_VERSION]))
                        if alt_fact and alt_fact["status"] == "reported" and alt_fact["value"] != fact["value"]:
                            result["comparability"] = "restatement_difference"
                            result["comparative_record_ids"] = alternate.get("equivalent_ids") or [alternative["id"]]
                    elif alternate["status"] in {"conflict", "scope_or_contract_conflict"}:
                        result["comparability"] = "restatement_conflict"
        self.raw_cache[key] = result
        return result

    def industrial(self, period: str) -> str | None:
        income = self._select("income", period, "1").get("record")
        if not income:
            return None
        return income["company_type"]

    def combine(self, metric, period, inputs, formula, operation, *, unit=None, check_comparability=True):
        input_ids = sorted({fid for point in inputs for fid in point["input_fact_ids"]})
        source_ids = sorted({rid for point in inputs for rid in point["source_record_ids"]})
        context = {"input_fact_ids": input_ids, "source_record_ids": source_ids, "formula": formula,
                   "dependencies": [{"metric": p["metric"], "period": p["period"], "status": p["status"], "reason": p["reason"]} for p in inputs]}
        if any(p["status"] != "ok" for p in inputs):
            return self.missing(metric, period, "dependency_missing", **context)
        signatures = {(p["unit"], p["currency"], p.get("scope"), p.get("company_type")) for p in inputs}
        if len(signatures) > 1:
            return self.missing(metric, period, "incompatible_unit_or_scope", **context)
        if check_comparability and any(p.get("comparability", "provider_same_scope") != "provider_same_scope" for p in inputs):
            return self.missing(metric, period, "comparability_unverified", **context)
        with localcontext() as ctx:
            ctx.prec = 80
            value = operation([Decimal(p["value"]) for p in inputs])
        return {"metric": metric, "period": period, "value": decimal_text(value), "status": "ok", "reason": REASONS["ok"],
                "unit": unit or inputs[0]["unit"], "currency": inputs[0]["currency"] if (unit or inputs[0]["unit"]) == "元" else None,
                "scope": inputs[0].get("scope"), "company_type": inputs[0].get("company_type"),
                "actual_basis": self.query.basis, "comparability": "provider_same_scope",
                "original_verified": False, **context}

    def point(self, metric: str, period: str) -> dict:
        key = metric, period
        if key in self.point_cache:
            return self.point_cache[key]
        value = self._point(metric, period)
        self.point_cache[key] = value
        return value

    def _point(self, metric, period):
        basis = self.query.basis
        year, month = int(period[:4]), int(period[5:7])
        applicable = FIELDS[metric].applicable if metric in FIELDS else DERIVED[metric][2]
        if applicable == "industrial":
            company_type = self.industrial(period)
            if company_type != "1":
                return self.missing(metric, period, "industry_unknown" if company_type is None else "not_applicable")
        if metric in FIELDS:
            raw = self.raw(metric, period)
            if raw["status"] != "ok":
                return raw
            temporal = FIELDS[metric].temporal
            if temporal == "instant":
                return {**raw, "actual_basis": "period_start" if metric == "beginning_cash_equivalents" else "period_end"}
            if temporal == "ratio":
                if basis in {"quarter", "ttm"}:
                    return self.missing(metric, period, "unsupported_basis")
                return {**raw, "actual_basis": "reported_ratio"}
            if basis in {"annual", "cumulative"} or (basis == "quarter" and month == 3) or (basis == "ttm" and month == 12):
                return {**raw, "actual_basis": "annual" if month == 12 and basis != "cumulative" else basis}
            if basis == "quarter":
                return self.combine(metric, period, [raw, self.raw(metric, previous_quarter(period))],
                                    "current_ytd - previous_same_year_ytd", lambda v: v[0] - v[1])
            prior_annual, prior_same = f"{year - 1}-12-31", str(year - 1) + period[4:]
            return self.combine(metric, period, [self.raw(metric, prior_annual), raw, self.raw(metric, prior_same)],
                                "previous_annual + current_ytd - previous_same_period_ytd", lambda v: v[0] + v[1] - v[2])
        if metric.endswith("_yoy"):
            base_metric = metric[:-4]
            current, previous = self.point(base_metric, period), self.point(base_metric, str(year - 1) + period[4:])
            result = self.combine(metric, period, [current, previous], "(current - previous_year) / previous_year * 100",
                                  lambda v: (v[0] - v[1]) / v[1] * 100 if v[1] > 0 else Decimal(0), unit="%")
            if result["status"] == "ok":
                with localcontext() as ctx:
                    ctx.prec = 80
                    now, old = Decimal(current["value"]), Decimal(previous["value"])
                    result["absolute_change"] = decimal_text(now - old)
                result["change_unit"] = current["unit"]
                result["change_classification"] = ("turnaround" if old < 0 <= now else "turned_loss" if old >= 0 > now else
                                                   "loss_narrowed" if old < now < 0 else "loss_widened" if now < old < 0 else
                                                   "increase" if now > old else "decrease" if now < old else "unchanged")
                if old <= 0:
                    result.update(value=None, status="nonpositive_base", reason=REASONS["nonpositive_base"])
            return result
        if metric == "cash_after_capex":
            return self.combine(metric, period, [self.point("operating_cashflow", period), self.point("capital_expenditure", period)],
                                "operating_cashflow - capital_expenditure (cash proxy)", lambda v: v[0] - v[1])
        if metric == "debt_ratio":
            numerator, denominator = self.raw("liabilities", period), self.raw("assets", period)
            formula = "total_liabilities / total_assets * 100"
        elif metric == "gross_margin":
            revenue, cost = self.point("revenue", period), self.point("operating_cost", period)
            numerator = self.combine(metric, period, [revenue, cost], "revenue - operating_cost", lambda v: v[0] - v[1], unit="元")
            denominator, formula = revenue, "(revenue - operating_cost) / revenue * 100"
        elif metric == "net_margin":
            numerator, denominator = self.point("net_profit", period), self.point("revenue", period)
            formula = "consolidated_net_profit / revenue * 100"
        else:
            numerator, denominator = self.point("operating_cashflow", period), self.point("net_profit", period)
            formula = "operating_cashflow / consolidated_net_profit"
        factor = 1 if metric == "cash_conversion" else 100
        result = self.combine(metric, period, [numerator, denominator], formula,
                              lambda v: v[0] / v[1] * factor if v[1] > 0 else Decimal(0), unit="倍" if factor == 1 else "%")
        if result["status"] == "ok":
            value = Decimal(denominator["value"])
            if value <= 0:
                state = "zero_denominator" if value == 0 else "nonpositive_denominator"
                result.update(value=None, status=state, reason=REASONS[state])
            if metric == "debt_ratio":
                result["actual_basis"] = "period_end"
        return result

    def checks(self, period):
        definitions = (("balance_equation", ("assets", "liabilities", "total_equity")),
                       ("profit_attribution", ("net_profit", "parent_net_profit", "minority_profit")),
                       ("cash_movement", ("ending_cash_equivalents", "beginning_cash_equivalents", "cash_equivalents_change")))
        results = []
        for name, metrics in definitions:
            points = [self.raw(metric, period) for metric in metrics]
            difference = self.combine(metrics[0], period, points, "first - second - third", lambda v: v[0] - v[1] - v[2])
            status = "missing"
            if difference["status"] == "ok":
                status = "pass" if abs(Decimal(difference["value"])) <= Decimal("1") else "mismatch"
            results.append({"check": name, "status": status, "difference": difference["value"], "unit": "元",
                            "tolerance": "1", "reason": "差异在 1 元容差内" if status == "pass" else
                            "勾稽差异超过 1 元，待核对原文和口径" if status == "mismatch" else difference["reason"],
                            "input_fact_ids": difference["input_fact_ids"]})
        return results


def calculate(query: FinancialQuery, *, records=None, facts=None) -> dict:
    if records is None or facts is None:
        records, facts = financial_facts.read_company(query.stock_code)
    calculator = Calculator(query, records, facts)
    dates = financial_sync.periods(query.start_year, query.as_of)
    if query.basis == "annual":
        dates = [period for period in dates if period.endswith("-12-31")]
    rows = [{"period": period, "values": {metric: calculator.point(metric, period) for metric in query.metrics},
             "checks": calculator.checks(period)} for period in dates]
    reasons = {}
    for row in rows:
        for value in row["values"].values():
            reasons[value["status"]] = reasons.get(value["status"], 0) + 1
    result = {"request": query.model_dump(mode="json"), "formula_version": FORMULA_VERSION,
              "normalization_version": financial_facts.NORMALIZATION_VERSION,
              "metrics": [item for item in catalog() if item["code"] in query.metrics],
              "rows": rows, "coverage": {"periods": len(dates), "cells": len(dates) * len(query.metrics), "statuses": reasons},
              "source_record_ids": sorted({rid for row in rows for p in row["values"].values() for rid in p["source_record_ids"]}),
              "notes": ["金额统一为 CNY 元，使用 Decimal 计算；比率保持百分比或倍数。",
                        "空值、缺字段、缺期间、版本冲突和历史证据不足分别保留，不补零。",
                        "最新口径按供应商公告日期过滤，仍可能包含后来修订；当时可验证口径还要求平台在截止日前观察到该版本。",
                        "当前统一使用 report_type=1 的合并报表；调整比较表与调整前表单独保留。不同的重述比较数据会阻止相关派生计算。",
                        "勾稽检查使用 1 元容差，仅用于发现差异，不代表原始财报已核验。"]}
    result["calculation_id"] = digest(result)
    return result


class CalculationChanged(ValueError):
    pass


def freeze(query: FinancialQuery, *, expected_id: str | None = None) -> dict:
    if not can_write(current_actor()):
        raise AccessDenied("当前账户只有查看权限")
    result = calculate(query)
    if expected_id and expected_id != result["calculation_id"]:
        raise CalculationChanged("财务来源已变化，请重新读取结果后保存")
    return store_result(result)


def store_result(result: dict) -> dict:
    """Persist a server-calculated result, including results from a frozen turn."""
    with connect() as connection:
        connection.execute("INSERT OR IGNORE INTO financial_calculations VALUES(?,?,?,?,?)",
                           (result["calculation_id"], result["formula_version"], canonical(result["request"]), canonical({k: v for k, v in result.items() if k != "saved"}), utc_now()))
    return {**result, "saved": True}


def read_calculation(calculation_id: str) -> dict:
    with connect() as connection:
        row = connection.execute("SELECT result_json FROM financial_calculations WHERE id=?", (calculation_id,)).fetchone()
    if not row:
        raise LookupError("找不到此计算快照")
    return {**json.loads(row[0]), "saved": True}
