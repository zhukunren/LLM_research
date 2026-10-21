"""Versioned, endpoint-specific contracts for financial research ingestion."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime
import re

CONTRACT_VERSION = "tushare-financial-v1"
DOCUMENTATION_CHECKED_AT = "2026-10-20"
CODE = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")


def parse_date(value: object) -> date:
    text = str(value)
    if not re.fullmatch(r"\d{8}", text):
        raise ValueError("日期必须使用 YYYYMMDD")
    return datetime.strptime(text, "%Y%m%d").date()


@dataclass(frozen=True)
class FinancialField:
    endpoint: str
    field: str
    metric: str
    label: str
    unit: str
    temporal: str
    factor: str = "1"
    currency: str | None = "CNY"
    applicable: str = "all"


# Only these fields are normalized in v1; other returned fields remain in raw rows.
FINANCIAL_FIELDS = tuple(FinancialField(*item) for item in (
    ("income", "revenue", "revenue", "营业收入", "元", "flow"),
    ("income", "total_revenue", "total_revenue", "营业总收入", "元", "flow"),
    ("income", "oper_cost", "operating_cost", "营业成本", "元", "flow"),
    ("income", "operate_profit", "operating_profit", "营业利润", "元", "flow"),
    ("income", "total_profit", "profit_before_tax", "利润总额", "元", "flow"),
    ("income", "n_income", "net_profit", "合并净利润", "元", "flow"),
    ("income", "n_income_attr_p", "parent_net_profit", "归母净利润", "元", "flow"),
    ("income", "minority_gain", "minority_profit", "少数股东损益", "元", "flow"),
    ("income", "sell_exp", "selling_expense", "销售费用", "元", "flow"),
    ("income", "admin_exp", "administrative_expense", "管理费用", "元", "flow"),
    ("income", "fin_exp", "financial_expense", "财务费用", "元", "flow"),
    ("income", "rd_exp", "research_expense", "研发费用", "元", "flow"),
    ("balancesheet", "money_cap", "cash", "货币资金", "元", "instant"),
    ("balancesheet", "accounts_receiv", "receivables", "应收账款", "元", "instant"),
    ("balancesheet", "inventories", "inventories", "存货", "元", "instant"),
    ("balancesheet", "total_assets", "assets", "总资产", "元", "instant"),
    ("balancesheet", "total_liab", "liabilities", "总负债", "元", "instant"),
    ("balancesheet", "total_hldr_eqy_exc_min_int", "parent_equity", "归母权益", "元", "instant"),
    ("balancesheet", "total_hldr_eqy_inc_min_int", "total_equity", "全部股东权益", "元", "instant"),
    ("balancesheet", "st_borr", "short_borrowings", "短期借款", "元", "instant"),
    ("balancesheet", "lt_borr", "long_borrowings", "长期借款", "元", "instant"),
    ("cashflow", "n_cashflow_act", "operating_cashflow", "经营现金流净额", "元", "flow"),
    ("cashflow", "n_cashflow_inv_act", "investing_cashflow", "投资现金流净额", "元", "flow"),
    ("cashflow", "n_cash_flows_fnc_act", "financing_cashflow", "筹资现金流净额", "元", "flow"),
    ("cashflow", "c_pay_acq_const_fiolta", "capital_expenditure", "购建长期资产支付现金", "元", "flow"),
    ("cashflow", "c_cash_equ_beg_period", "beginning_cash_equivalents", "期初现金等价物", "元", "instant"),
    ("cashflow", "c_cash_equ_end_period", "ending_cash_equivalents", "期末现金等价物", "元", "instant"),
    ("cashflow", "n_incr_cash_cash_equ", "cash_equivalents_change", "现金等价物净增加额", "元", "flow"),
    ("fina_indicator", "profit_dedt", "deducted_net_profit", "扣非净利润", "元", "cumulative"),
    ("fina_indicator", "roe", "provider_roe", "供应商净资产收益率", "%", "ratio", "1", None),
    ("fina_indicator", "grossprofit_margin", "provider_gross_margin", "供应商销售毛利率", "%", "ratio", "1", None, "industrial"),
    ("forecast", "net_profit_min", "forecast_net_profit_min", "预告利润下限", "万元", "forecast", "10000"),
    ("forecast", "net_profit_max", "forecast_net_profit_max", "预告利润上限", "万元", "forecast", "10000"),
    ("express", "n_income", "express_net_profit", "快报净利润", "元", "preliminary"),
    ("fina_mainbz", "bz_sales", "segment_revenue", "分部收入", "元", "segment"),
))


@dataclass(frozen=True)
class Endpoint:
    name: str
    family: str
    label: str
    doc_id: int
    params: tuple[str, ...]
    date_semantics: tuple[tuple[str, str], ...]
    required_fields: tuple[str, ...]
    metadata_fields: tuple[str, ...]
    row_limit: int | None
    split_by: str
    permission: str
    batch: bool = False
    phase: int = 1

    @property
    def fields(self) -> tuple[str, ...]:
        numeric = tuple(f.field for f in FINANCIAL_FIELDS if f.endpoint == self.family)
        return tuple(dict.fromkeys(self.required_fields + self.metadata_fields + numeric))

    @property
    def doc_url(self) -> str:
        return f"https://tushare.pro/document/2?doc_id={self.doc_id}"

    def validate(self, params: dict) -> dict:
        if set(params) - set(self.params):
            raise ValueError(f"{self.name} 不支持参数：{', '.join(sorted(set(params) - set(self.params)))}")
        if any(isinstance(v, bool) or not isinstance(v, (str, int)) or len(str(v)) > 200 for v in params.values()):
            raise ValueError("接口参数必须是有界字符串或整数")
        if params.get("ts_code") and not CODE.fullmatch(str(params["ts_code"])):
            raise ValueError("请指定一只有效的 A 股证券")
        dates = dict(self.date_semantics)
        for key in dates:
            if params.get(key):
                parsed = parse_date(params[key])
                if dates[key] == "report_period" and key in {"period", "end_date"} and self.family == "disclosure_date":
                    if (parsed.month, parsed.day) not in {(3, 31), (6, 30), (9, 30), (12, 31)}:
                        raise ValueError("披露计划的 end_date 必须为报告期末")
        if params.get("period"):
            parsed = parse_date(params["period"])
            if (parsed.month, parsed.day) not in {(3, 31), (6, 30), (9, 30), (12, 31)}:
                raise ValueError("period 必须为报告期末")
        if params.get("start_date") and params.get("end_date") and parse_date(params["start_date"]) > parse_date(params["end_date"]):
            raise ValueError("开始日期不能晚于结束日期")
        if not self.batch and self.family not in {"anns_d", "disclosure_date"} and not params.get("ts_code"):
            raise ValueError("普通财务接口必须限定证券")
        if not params.get("ts_code") and not any(params.get(key) for key in dates):
            raise ValueError("必须限定证券或日期范围")
        if self.family == "fina_mainbz" and params.get("type") not in {None, "P", "D", "I", "S"}:
            raise ValueError("主营构成 type 必须为 P/D/I/S")
        if params.get("report_type") and str(params["report_type"]) not in {str(i) for i in range(1, 13)}:
            raise ValueError("未知报表类型")
        if params.get("comp_type") and str(params["comp_type"]) not in {"1", "2", "3", "4", "7"}:
            raise ValueError("未知公司类型")
        if params.get("is_calc") is not None and str(params["is_calc"]) not in {"0", "1"}:
            raise ValueError("is_calc 必须为 0/1")
        return dict(params)


_ANN = (("ann_date", "announcement"), ("start_date", "announcement"), ("end_date", "announcement"), ("period", "report_period"))
_PERIOD = (("ann_date", "announcement"), ("start_date", "report_period"), ("end_date", "report_period"), ("period", "report_period"))
_STM_REQ = ("ts_code", "end_date", "report_type", "comp_type")
_STM_META = ("ann_date", "f_ann_date", "end_type", "update_flag")
_BASE = (
    Endpoint("income", "income", "利润表", 33, ("ts_code", "ann_date", "f_ann_date", "start_date", "end_date", "period", "report_type", "comp_type"),
             _ANN + (("f_ann_date", "announcement"),), _STM_REQ, _STM_META, None, "company_period", "普通财务权限"),
    Endpoint("balancesheet", "balancesheet", "资产负债表", 36, ("ts_code", "ann_date", "start_date", "end_date", "period", "report_type", "comp_type"),
             _ANN, _STM_REQ, _STM_META, None, "company_period", "普通财务权限"),
    Endpoint("cashflow", "cashflow", "现金流量表", 44, ("ts_code", "ann_date", "f_ann_date", "start_date", "end_date", "period", "report_type", "comp_type", "is_calc"),
             _ANN + (("f_ann_date", "announcement"),), _STM_REQ, _STM_META, None, "company_period", "普通财务权限"),
    Endpoint("fina_indicator", "fina_indicator", "财务指标", 79, ("ts_code", "ann_date", "start_date", "end_date", "period"),
             _PERIOD, ("ts_code", "end_date", "ann_date"), ("update_flag",), 100, "company_period", "普通财务权限"),
    Endpoint("fina_audit", "fina_audit", "审计意见", 80, ("ts_code", "ann_date", "start_date", "end_date", "period"),
             _ANN, ("ts_code", "end_date", "ann_date"), ("audit_result", "audit_agency", "audit_sign", "audit_fees"), None, "company_period", "普通财务权限"),
    Endpoint("disclosure_date", "disclosure_date", "披露日程", 162, ("ts_code", "end_date", "pre_date", "ann_date", "actual_date"),
             (("end_date", "report_period"), ("pre_date", "planned_disclosure"), ("ann_date", "announcement"), ("actual_date", "actual_disclosure")),
             ("ts_code", "end_date"), ("ann_date", "pre_date", "actual_date", "modify_date"), 6000, "company_period", "披露日程权限"),
    Endpoint("anns_d", "anns_d", "公告原文索引", 176, ("ts_code", "ann_date", "start_date", "end_date"),
             _ANN[:-1], ("ts_code", "ann_date", "title", "url"), ("name", "rec_time"), 2000, "company_announcement_day", "公告数据需单独开通"),
    Endpoint("forecast", "forecast", "业绩预告", 45, ("ts_code", "ann_date", "start_date", "end_date", "period", "type"),
             _ANN, ("ts_code", "end_date", "ann_date"), ("type", "first_ann_date", "summary", "change_reason"), 3500, "company_period", "普通财务权限", phase=2),
    Endpoint("express", "express", "业绩快报", 46, ("ts_code", "ann_date", "start_date", "end_date", "period"),
             _ANN, ("ts_code", "end_date", "ann_date"), ("revenue", "total_assets"), None, "company_period", "普通财务权限", phase=2),
    Endpoint("fina_mainbz", "fina_mainbz", "主营构成", 81, ("ts_code", "period", "type", "start_date", "end_date"),
             _PERIOD[1:], ("ts_code", "end_date", "bz_item"), ("bz_code", "bz_profit", "bz_cost", "curr_type", "update_flag"),
             100, "company_period_dimension", "普通财务权限", phase=2),
)
ENDPOINTS = {endpoint.name: endpoint for endpoint in _BASE}
for _endpoint in _BASE:
    if _endpoint.family in {"income", "balancesheet", "cashflow", "fina_indicator", "forecast", "express", "fina_mainbz"}:
        _vip = Endpoint(**{**asdict(_endpoint), "name": _endpoint.name + "_vip", "label": _endpoint.label + "（VIP）",
                          "batch": True, "split_by": "period_then_company", "permission": "VIP 批量权限"})
        ENDPOINTS[_vip.name] = _vip


def manifest() -> dict:
    return {"version": CONTRACT_VERSION, "documentation_checked_at": DOCUMENTATION_CHECKED_AT,
            "endpoints": [{**asdict(endpoint), "fields": list(endpoint.fields), "doc_url": endpoint.doc_url,
                           "date_semantics": dict(endpoint.date_semantics)} for endpoint in ENDPOINTS.values()],
            "fields": [asdict(field) for field in FINANCIAL_FIELDS],
            "notes": ["接口权限以实际请求为准；空结果不证明无披露。",
                      "金额币种由 A 股接口合同标注为 CNY；原文币种与单位核验尚属下一阶段。",
                      "phase=2 的接口合同已登记，本轮试点不调用。"]}
