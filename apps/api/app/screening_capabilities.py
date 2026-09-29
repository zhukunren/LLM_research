from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from .screening_contracts import ContractModel


Availability = Literal["available", "partial", "unavailable"]


class Capability(ContractModel):
    id: str
    version: str
    domain: Literal["market", "report", "news", "pattern", "runtime", "securities", "fundamentals", "composition"]
    title: str
    availability: Availability
    reason: str | None = None
    agent_tool_registered: bool = False
    input_contract: dict[str, Any]
    output_contract: dict[str, Any]
    fields: list[dict[str, str]]
    coverage: dict[str, Any]
    side_effect: Literal["read_only", "persist_result"]
    resource_policy: dict[str, Any]


class CapabilityManifest(ContractModel):
    version: Literal["screening-capabilities-v1"] = "screening-capabilities-v1"
    capabilities: list[Capability]


def build_manifest(
    *,
    market_available: bool,
    indexed_reports: int,
    saved_patterns: int,
    builtin_indicators: list[dict[str, Any]],
    model_configured: bool,
    registered_tool_names: set[str] | None = None,
    runtime_ready: bool = False,
    indexed_news: int = 0,
) -> dict[str, Any]:
    """Describe service-backed abilities and unavailable domains without inferring data."""
    items = [
        Capability(
            id="market.daily_bars",
            version="1",
            domain="market",
            title="查询单只证券日线",
            availability="available" if market_available else "unavailable",
            reason=None if market_available else "行情文件尚未挂载",
            input_contract={
                "stock_code": "有效证券代码",
                "as_of": "服务端固定的 YYYY-MM-DD 截止日",
                "limit": {"minimum": 1, "maximum": 500},
            },
            output_contract={
                "ordering": "trade_date ascending",
                "fields": ["trade_date", "open", "high", "low", "close", "volume", "amount"],
                "quality": ["quality_valid", "quality_reason"],
            },
            fields=[
                {"name": name, "unit": "unknown"}
                for name in ("open", "high", "low", "close", "volume", "amount")
            ],
            coverage={
                "markets": ["SH", "SZ", "BJ"],
                "time_granularity": "1 trading day",
                "max_bars_per_security": 500,
                "price_basis": "unknown",
                "volume_unit": "unknown",
                "amount_unit": "unknown",
            },
            side_effect="read_only",
            resource_policy={"max_records": 500, "read_only": True},
        ),
        Capability(
            id="market.security_search",
            version="1",
            domain="market",
            title="在固定截止日搜索证券",
            availability="available" if market_available else "unavailable",
            reason=None if market_available else "行情文件尚未挂载",
            input_contract={"query": "代码前缀", "market": "SH/SZ/BJ", "as_of": "服务端固定的YYYY-MM-DD截止日"},
            output_contract={"items": "代码、市场、截至截止日的最后行情日期"},
            fields=[
                {"name": "stock_code", "unit": "exchange code"},
                {"name": "last_date", "unit": "date"},
                {"name": "close", "unit": "price; currency/unit unknown"},
            ],
            coverage={"markets": ["SH", "SZ", "BJ"], "results_limit": 50},
            side_effect="read_only",
            resource_policy={"max_records": 50, "read_only": True},
        ),
        Capability(
            id="market.builtin_indicators",
            version="1",
            domain="market",
            title="计算项目内置日线指标",
            availability="available" if market_available else "unavailable",
            reason=None if market_available else "行情文件尚未挂载",
            input_contract={
                "stock_code": "有效证券代码",
                "as_of": "服务端固定的 YYYY-MM-DD 截止日",
                "indicator": [item["id"] for item in builtin_indicators],
                "window": "必须遵循对应指标的周期范围",
            },
            output_contract={"values": "日期对齐的指标值；预热不足返回 unknown"},
            fields=[
                {"name": item["id"], "unit": "indicator-specific"}
                for item in builtin_indicators
            ],
            coverage={"time_granularity": "1 trading day"},
            side_effect="read_only",
            resource_policy={"read_only": True, "max_bars_per_security": 500},
        ),
        Capability(
            id="report.page_search",
            version="1",
            domain="report",
            title="检索和读取已索引研报原文页",
            availability="available" if indexed_reports else "unavailable",
            reason=None if indexed_reports else "尚无已索引研报",
            input_contract={"query": "关键词检索或按证券列举资料", "as_of": "首次可用日期不晚于筛选截止日",
                            "offset": "资料列表偏移或页内原文字符偏移"},
            output_contract={"items": "文档、证券、页码及匹配原文", "next_offset": "尚未读完时的续读位置",
                             "coverage": "仅报告实际列举或读取范围"},
            fields=[
                {"name": "source_sha256", "unit": "document identity"},
                {"name": "available_at", "unit": "date"},
                {"name": "page_number", "unit": "page"},
                {"name": "quote", "unit": "source text"},
            ],
            coverage={
                "indexed_reports": indexed_reports,
                "complete_corpus": False,
                "security_binding_requires_confirmation": True,
            },
            side_effect="read_only",
            resource_policy={"max_pages_per_read": 20, "read_only": True},
        ),
        Capability(
            id="report.evidence_evaluation",
            version="1",
            domain="report",
            title="按明确的研究口径评估已索引研报",
            availability=(
                "available" if indexed_reports and model_configured
                else "partial" if indexed_reports
                else "unavailable"
            ),
            reason=(
                None if indexed_reports and model_configured
                else "尚未配置评估所需的文本模型" if indexed_reports
                else "尚无可检索的研报原文页"
            ),
            input_contract={"criteria": "已确认的研究问题", "as_of": "固定截止日", "lookback_days": "自然日回溯范围"},
            output_contract={"state": "true/false/unknown", "evidence": "可回到原文页的引用", "coverage": "已处理范围"},
            fields=[
                {"name": "state", "unit": "true/false/unknown"},
                {"name": "page_number", "unit": "page"},
                {"name": "quote", "unit": "source text"},
            ],
            coverage={"indexed_reports": indexed_reports, "complete_corpus": False},
            side_effect="persist_result",
            resource_policy={"read_only_sources": True, "citations_required": True},
        ),
        Capability(
            id="news.local_search",
            version="1",
            domain="news",
            title="检索已接入的资讯",
            availability="available" if indexed_news else "unavailable",
            reason=None if indexed_news else "当前没有已导入的本地资讯",
            input_contract={"query": "检索范围、证券、事件及时间窗"},
            output_contract={"items": "资讯原文、来源、首次可用时间及证券关联"},
            fields=[
                {"name": "published_at", "unit": "timestamp"},
                {"name": "available_at", "unit": "timestamp"},
                {"name": "source", "unit": "source identifier"},
            ],
            coverage={"indexed_items": indexed_news, "external_sync": False},
            side_effect="read_only",
            resource_policy={"read_only": True},
        ),
        Capability(
            id="pattern.match_saved",
            version="1",
            domain="pattern",
            title="比较已保存走势形态",
            availability="available" if saved_patterns else "unavailable",
            reason=None if saved_patterns else "当前没有已保存形态",
            input_contract={"pattern_id": "已保存形态", "version": "固定版本", "as_of": "固定截止日"},
            output_contract={"similarity": "启发式相似度分数及逐项差异"},
            fields=[{"name": "similarity", "unit": "heuristic score"}],
            coverage={"saved_patterns": saved_patterns},
            side_effect="read_only",
            resource_policy={"read_only": True, "never_a_return_probability": True},
        ),
        Capability(
            id="portfolio.combine_saved_conditions",
            version="1",
            domain="composition",
            title="组合已保存的版本化筛选条件",
            availability="available",
            input_contract={
                "operators": ["all", "any", "not"],
                "references": "已保存的筛选或形态版本",
                "stock_universe": "全部A股、已保存观察池或明确证券名单",
            },
            output_contract={"state": "true/false/unknown", "trace": "逐项条件判断"},
            fields=[{"name": "operator", "unit": "all/any/not"}],
            coverage={"three_valued_logic": True},
            side_effect="persist_result",
            resource_policy={"execution": "background worker"},
        ),
        Capability(
            id="portfolio.inspect_saved_conditions",
            version="1",
            domain="composition",
            title="查看已保存的条件、组合与形态",
            availability="available",
            input_contract={"query": "名称或说明文本", "library": "资料库，可为空"},
            output_contract={"items": "已保存条件及固定版本"},
            fields=[{"name": "version", "unit": "immutable version"}],
            coverage={"history": "available on request"},
            side_effect="read_only",
            resource_policy={"max_records": 50, "read_only": True},
        ),
        Capability(
            id="runtime.artifact_read",
            version="1",
            domain="runtime",
            title="读取当前对话创建的较大产物",
            availability="available",
            input_contract={"artifact_id": "服务器签发的ID", "offset": "文本字符偏移", "limit": "1..12000"},
            output_contract={"content": "有来源哈希保护的产物分段"},
            fields=[{"name": "sha256", "unit": "content hash"}],
            coverage={"scope": "current conversation only"},
            side_effect="read_only",
            resource_policy={"max_chunk_chars": 12000, "read_only": True},
        ),
        Capability(
            id="runtime.generated_python",
            version="1",
            domain="runtime",
            title="本地执行自定义 Python 条件",
            availability="available" if runtime_ready else "unavailable",
            reason=None if runtime_ready else "本地 Python 或 NumPy 依赖不可用",
            input_contract={"entrypoint": "screen(context, frames, params)", "as_of": "固定截止日", "params": "已确认参数"},
            output_contract={"decisions": "每只证券的符合/不符合/unknown及解释数值"},
            fields=[{"name": "decision", "unit": "true/false/unknown"}],
            coverage={"max_bars_per_security": 500, "execution_backend": "local_python"},
            side_effect="persist_result",
            resource_policy={"wall_clock_seconds": 60, "max_output_bytes": 20 * 1024 * 1024,
                             "separate_process": True, "os_security_sandbox": False},
        ),
        Capability(
            id="fundamentals.market_cap",
            version="1",
            domain="fundamentals",
            title="查询市值及估值字段",
            availability="unavailable",
            reason="尚未接入经过验证的历史财务与估值数据",
            input_contract={"stock_code": "有效证券代码", "as_of": "历史数据时点"},
            output_contract={"state": "unknown when unavailable"},
            fields=[{"name": "market_cap", "unit": "unknown"}],
            coverage={"historical_provider": None},
            side_effect="read_only",
            resource_policy={"read_only": True},
        ),
        Capability(
            id="securities.historical_classification",
            version="1",
            domain="securities",
            title="查询历史行业、ST和证券状态",
            availability="unavailable",
            reason="尚未接入经过验证的历史证券主数据",
            input_contract={"stock_code": "有效证券代码", "as_of": "历史数据时点"},
            output_contract={"state": "unknown when unavailable"},
            fields=[
                {"name": "industry", "unit": "classification"},
                {"name": "st_status", "unit": "boolean"},
                {"name": "listing_status", "unit": "status"},
            ],
            coverage={"historical_provider": None},
            side_effect="read_only",
            resource_policy={"read_only": True},
        ),
        Capability(
            id="market.minute_bars",
            version="1",
            domain="market",
            title="查询分钟级行情",
            availability="unavailable",
            reason="当前只接入日线行情",
            input_contract={"stock_code": "有效证券代码", "interval": "minute", "as_of": "固定截止时间"},
            output_contract={"state": "unknown when unavailable"},
            fields=[{"name": "timestamp", "unit": "exchange-local time"}],
            coverage={"provider": None},
            side_effect="read_only",
            resource_policy={"read_only": True},
        ),
    ]
    # The conversational workflow exposes raw data and user-defined programs only.
    items = [item for item in items if item.id != "market.builtin_indicators"]
    registrations = registered_tool_names or set()
    capability_tools = {
        "market.daily_bars": {"read_market_window"},
        "market.security_search": {"search_securities"},
        "market.builtin_indicators": {"compute_builtin_indicator"},
        "report.page_search": {"search_report_pages", "read_report_page", "list_report_sources", "read_evidence_chunk"},
        "news.local_search": {"list_news_sources", "read_news_chunk"},
        "portfolio.inspect_saved_conditions": {"inspect_saved_conditions"},
        "runtime.artifact_read": {"read_artifact_chunk"},
    }
    for item in items:
        required = capability_tools.get(item.id, set())
        item.agent_tool_registered = bool(required) and required <= registrations
    return CapabilityManifest(capabilities=items).model_dump(mode="json")


def market_coverage(profile: dict[str, Any]) -> dict[str, Any]:
    """Return a model-safe coverage view without local paths or unrelated diagnostics."""
    file_digest = profile.get("sha256")
    if not isinstance(file_digest, str) or len(file_digest) != 64:
        identity = {
            key: profile.get(key)
            for key in ("rows", "securities", "first_date", "last_date")
        }
        file_digest = hashlib.sha256(
            json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

    return {
        "source_id": file_digest,
        "available": bool(profile.get("available")),
        "first_date": profile.get("first_date"),
        "last_date": profile.get("last_date"),
        "markets": profile.get("markets", {}),
        "rows": profile.get("rows", 0),
        "securities": profile.get("securities", 0),
        "columns": [
            {"name": item["name"], "type": item["type"]}
            for item in profile.get("columns", [])
            if isinstance(item, dict) and isinstance(item.get("name"), str) and isinstance(item.get("type"), str)
        ],
        "quality_status": profile.get("quality_status", "unknown"),
        "price_basis": profile.get("price_basis", "unknown"),
        "volume_unit": profile.get("volume_unit", "unknown"),
        "amount_unit": profile.get("amount_unit", "unknown"),
        "formal_execution_ready": bool(profile.get("formal_execution_ready", False)),
        "formal_blockers": list(profile.get("formal_blockers", [])),
    }
