from __future__ import annotations

import re
import math
from collections import Counter
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


Intent = Literal["discuss", "edit", "execute", "explain_run", "save"]
DecisionState = Literal["true", "false", "unknown"]
EvaluationStatus = Literal["completed", "failed", "not_evaluated"]
ConditionLibrary = Literal["technical", "news", "report", "pattern", "ranking"]
ConversationScope = Literal["technical", "news", "report", "pattern", "screening"]
ResearchMode = Literal["research", "screening", "advanced"]
MAX_MESSAGE_CHARS = 8000
MAX_LOGIC_NODES = 1000
MAX_LOGIC_CHILDREN = 200
METRIC_NAME_PATTERN = r"[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]{0,39}"


def _normalized_quote(value: str) -> str:
    return re.sub(r"\s+", "", value)


class CreateConversationRequest(ContractModel):
    entry_scope: ConversationScope
    research_mode: ResearchMode | None = None
    project_id: str | None = Field(default=None, min_length=1, max_length=100)


class UpdateResearchModeRequest(ContractModel):
    research_mode: ResearchMode


class ConversationSourceReference(ContractModel):
    kind: Literal["report_page", "news_item", "security", "screening_run", "pattern", "condition"]
    source_id: str = Field(min_length=1, max_length=100)
    page_number: int | None = Field(default=None, ge=1, le=5000)
    version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def reference_shape_matches_kind(self):
        if self.kind == "report_page" and (self.page_number is None or self.version is not None):
            raise ValueError("研报来源必须指定文档页码")
        if self.kind in {"pattern", "condition"} and (self.version is None or self.page_number is not None):
            raise ValueError("已保存资产来源必须指定版本")
        if self.kind in {"security", "screening_run", "news_item"} and (self.page_number is not None or self.version is not None):
            raise ValueError("证券和筛选记录来源不能包含页码或条件版本")
        if self.kind == "security" and not re.fullmatch(r"\d{6}\.(?:SH|SZ|BJ)", self.source_id.upper()):
            raise ValueError("证券来源代码无效")
        return self


class AddUserMessageRequest(ContractModel):
    client_message_id: str = Field(min_length=1, max_length=100)
    base_revision: int = Field(ge=0)
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    source_refs: list[ConversationSourceReference] = Field(default_factory=list, max_length=8)


class IntentProposal(ContractModel):
    intent: Intent
    message_id: str = Field(min_length=1, max_length=100)
    run_id: str | None = Field(default=None, min_length=1, max_length=100)
    stock_code: str | None = Field(default=None, min_length=4, max_length=16)
    requires_clarification: bool = False
    clarification: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def explain_run_needs_target(self):
        if self.intent == "explain_run" and not self.run_id:
            raise ValueError("解释历史结果必须绑定指定运行")
        if self.requires_clarification and not self.clarification:
            raise ValueError("需要澄清时必须给出具体问题")
        return self


def validate_intent_source(
    proposal: IntentProposal,
    allowed_message_ids: set[str],
) -> None:
    """Bind a model proposal to a current turn or a server-held execute grant."""
    if proposal.message_id not in allowed_message_ids:
        raise ValueError("对话意图必须绑定当前回合或仍有效的待执行用户消息")


class UnresolvedRequirement(ContractModel):
    kind: Literal["clarification", "unsupported", "missing_data", "conflict"]
    source_quote: str = Field(min_length=1, max_length=1000)
    question: str = Field(min_length=1, max_length=1000)
    suggestion: str | None = Field(default=None, max_length=1000)


class UniverseScope(ContractModel):
    kind: Literal["all_a_shares", "watchlist", "explicit"]
    watchlist_id: str | None = None
    stock_codes: list[str] = Field(default_factory=list, max_length=20000)

    @field_validator("stock_codes")
    @classmethod
    def valid_stock_codes(cls, value: list[str]) -> list[str]:
        pattern = re.compile(r"^\d{4,6}\.(?:SH|SZ|BJ|HK|KS)$")
        if len(value) != len(set(value)) or any(not pattern.fullmatch(code) for code in value):
            raise ValueError("证券范围包含重复或格式无效的代码")
        return value

    @model_validator(mode="after")
    def valid_scope_reference(self):
        if self.kind == "watchlist" and (not self.watchlist_id or self.stock_codes):
            raise ValueError("观察池范围必须引用一个股票池，不能同时内嵌证券名单")
        if self.kind == "explicit" and (self.watchlist_id or not self.stock_codes):
            raise ValueError("指定证券范围必须包含证券名单")
        if self.kind == "all_a_shares" and (self.watchlist_id or self.stock_codes):
            raise ValueError("全体A股范围不能附带其他名单")
        return self


class RankingSpec(ContractModel):
    ranking_universe: Literal["all_a_shares", "watchlist", "after_filters", "industry"]
    metric_reference_id: str | None = Field(default=None, min_length=1, max_length=80)
    metric_name: str | None = Field(default=None, min_length=1, max_length=40)
    direction: Literal["ascending", "descending"]
    top_n: int | None = Field(default=None, ge=1, le=20000)
    top_fraction: float | None = Field(default=None, gt=0, le=1)
    top_fraction_rounding: Literal["ceil"] | None = None
    ties_policy: Literal["include_all", "stable_code"]
    missing_policy: Literal["unknown", "exclude_with_notice"]
    rank_after_filters: bool = False
    population_logic_tree: dict[str, Any] | None = None

    @model_validator(mode="after")
    def exactly_one_limit(self):
        if self.metric_reference_id is None or self.metric_name is None:
            raise ValueError("排名必须明确指定来源条件和指标名称")
        if not re.fullmatch(METRIC_NAME_PATTERN, self.metric_name):
            raise ValueError("排名指标名称格式无效")
        if (self.top_n is None) == (self.top_fraction is None):
            raise ValueError("排名必须且只能指定 TopN 或前百分比")
        if (self.top_fraction is None) != (self.top_fraction_rounding is None):
            raise ValueError("仅前百分比排名必须明确取整方式")
        if self.ranking_universe == "after_filters" and not self.rank_after_filters:
            raise ValueError("过滤后排名必须明确标记 rank_after_filters")
        if self.ranking_universe != "after_filters" and (self.rank_after_filters or self.population_logic_tree is not None):
            raise ValueError("完整范围排名不能隐式附加预筛选")
        if self.ranking_universe == "after_filters" and self.population_logic_tree is None:
            raise ValueError("过滤后排名必须明确给出比较范围的条件组合")
        return self


class TaskScope(ContractModel):
    universe: UniverseScope | None = None
    as_of: date | None = None
    report_lookback_calendar_days: int | None = Field(default=None, ge=1, le=3650)
    news_lookback_calendar_days: int | None = Field(default=None, ge=1, le=3650)
    price_basis: Literal["unadjusted", "forward_adjusted", "back_adjusted", "unknown"] | None = None
    ranking: RankingSpec | None = None


class ProgramParameterSpec(ContractModel):
    label: str = Field(min_length=1, max_length=100)
    type: Literal["number", "integer"]
    minimum: float | None = None
    maximum: float | None = None

    @model_validator(mode="after")
    def valid_bounds(self):
        if self.minimum is not None and not math.isfinite(self.minimum):
            raise ValueError("程序参数下限必须是有限数值")
        if self.maximum is not None and not math.isfinite(self.maximum):
            raise ValueError("程序参数上限必须是有限数值")
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("程序参数上下限无效")
        return self


class CustomProgram(ContractModel):
    """Standard Python source plus the fixed data and result contract."""

    contract_version: Literal["python-screen-v1"]
    source_code: str = Field(min_length=1, max_length=32_000)
    required_fields: list[Literal["open", "high", "low", "close", "volume", "amount"]] = Field(
        min_length=1, max_length=6
    )
    required_history_bars: int = Field(ge=1, le=500)
    parameters: dict[str, int | float] = Field(default_factory=dict, max_length=32)
    parameter_specs: dict[str, ProgramParameterSpec] = Field(default_factory=dict, max_length=32)

    @field_validator("required_fields")
    @classmethod
    def unique_required_fields(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("所需行情字段不能重复")
        return value

    @field_validator("parameters", mode="before")
    @classmethod
    def finite_numeric_parameters(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            raise ValueError("程序参数必须是数值对象")
        for name, item in value.items():
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,39}", str(name)):
                raise ValueError("程序参数名称格式无效")
            if type(item) not in (int, float) or not math.isfinite(float(item)):
                raise ValueError("程序参数必须是有限数值，不能使用布尔值")
        return value

    @model_validator(mode="after")
    def parameters_match_specs(self):
        if set(self.parameters) != set(self.parameter_specs):
            raise ValueError("每个可调程序参数都必须有且只有一个参数说明")
        for name, value in self.parameters.items():
            spec = self.parameter_specs[name]
            if spec.type == "integer" and type(value) is not int:
                raise ValueError(f"程序参数{name}必须是整数")
            if spec.minimum is not None and value < spec.minimum:
                raise ValueError(f"程序参数{name}低于允许下限")
            if spec.maximum is not None and value > spec.maximum:
                raise ValueError(f"程序参数{name}高于允许上限")
        return self


class ConditionDefinition(ContractModel):
    condition_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
    library: ConditionLibrary
    source_quote: str = Field(min_length=1, max_length=2000)
    expression: dict[str, Any] = Field(default_factory=dict)
    program: CustomProgram | None = None
    description: str = Field(min_length=1, max_length=1000)
    implementation_id: str | None = None
    implementation_version: str | None = None

    @model_validator(mode="after")
    def implementation_matches_contract(self):
        if self.library == "ranking":
            if self.expression or self.program is not None:
                raise ValueError("排名条件使用独立的排名合同，不能包含筛选表达式或程序")
            if (self.implementation_id, self.implementation_version) != ("ranking-v1", "ranking-v1"):
                raise ValueError("排名条件必须标记固定排名实现版本")
            return self
        if self.program is None and not self.expression:
            raise ValueError("条件必须包含已保存实现或自定义程序")
        if self.program is not None:
            if self.library != "technical":
                raise ValueError("自定义行情计算程序必须属于技术条件")
            if self.expression:
                raise ValueError("自定义程序条件不能同时携带另一套公式表达式")
            if self.implementation_id != "llm-python-screen":
                raise ValueError("自定义程序必须标记固定执行接口")
            if self.implementation_version != self.program.contract_version:
                raise ValueError("自定义程序版本必须与执行合同一致")
        return self


class ConditionReference(ContractModel):
    reference_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
    condition_id: str
    condition_version: int | None = Field(default=None, ge=1)
    parameter_overrides: dict[str, Any] = Field(default_factory=dict)
    source_quote: str | None = Field(default=None, min_length=1, max_length=2000)


def validate_logic_tree(tree: dict[str, Any] | None) -> list[str]:
    """Return condition reference IDs in a strict AND/OR/NOT tree."""
    if tree is None:
        return []
    references: list[str] = []
    node_count = 0

    def visit(node: Any, depth: int = 0) -> None:
        nonlocal node_count
        node_count += 1
        if node_count > MAX_LOGIC_NODES or depth > 32 or not isinstance(node, dict):
            raise ValueError("组合逻辑格式无效或嵌套过深")
        op = node.get("op")
        if op == "condition":
            if set(node) != {"op", "reference_id"}:
                raise ValueError("条件引用节点字段无效")
            reference_id = node.get("reference_id")
            if not isinstance(reference_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", reference_id):
                raise ValueError("条件引用ID格式无效")
            references.append(reference_id)
            return
        if op not in {"all", "any", "not"} or set(node) != {"op", "children"}:
            raise ValueError("组合节点只允许 all、any、not 或 condition")
        children = node.get("children")
        if (
            not isinstance(children, list)
            or not children
            or len(children) > MAX_LOGIC_CHILDREN
            or (op == "not" and len(children) != 1)
        ):
            raise ValueError("组合节点子项数量无效")
        for child in children:
            visit(child, depth + 1)

    visit(tree)
    return references


class ScreeningTaskRevision(ContractModel):
    task_id: str = Field(min_length=1, max_length=100)
    revision: int = Field(ge=1)
    original_user_messages: list[str] = Field(default_factory=list, max_length=100)
    conditions: list[ConditionDefinition] = Field(default_factory=list, max_length=100)
    references: list[ConditionReference] = Field(default_factory=list, max_length=200)
    logic_tree: dict[str, Any] | None = None
    scope: TaskScope = Field(default_factory=TaskScope)
    unresolved: list[UnresolvedRequirement] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def references_are_complete(self):
        condition_ids = [condition.condition_id for condition in self.conditions]
        reference_ids = [reference.reference_id for reference in self.references]
        if len(condition_ids) != len(set(condition_ids)):
            raise ValueError("条件定义ID不能重复")
        if len(reference_ids) != len(set(reference_ids)):
            raise ValueError("条件引用ID不能重复")
        known_conditions = set(condition_ids)
        if any(reference.condition_id not in known_conditions for reference in self.references):
            raise ValueError("条件引用了不存在的条件定义")
        tree_refs = validate_logic_tree(self.logic_tree)
        if Counter(tree_refs) != Counter(reference_ids):
            raise ValueError("逻辑树必须完整且仅引用任务中的条件引用")
        if self.conditions and {item.condition_id for item in self.references} != known_conditions:
            raise ValueError("每个条件定义都必须至少有一个明确引用")
        ranking_conditions = [item for item in self.conditions if item.library == "ranking"]
        if self.scope.ranking is None and ranking_conditions:
            raise ValueError("排名条件必须具有对应的排名口径")
        if self.scope.ranking is not None:
            if len(ranking_conditions) != 1:
                raise ValueError("每个筛选任务必须且只能包含一个排名条件")
            reference_ids = {item.reference_id: item for item in self.references}
            metric_reference = reference_ids.get(self.scope.ranking.metric_reference_id or "")
            if metric_reference is None:
                raise ValueError("排名指标必须引用任务中的一个条件引用")
            metric_condition = next(
                (item for item in self.conditions if item.condition_id == metric_reference.condition_id), None
            )
            if metric_condition is None or metric_condition.program is None:
                raise ValueError("排名指标必须来自一个自定义程序条件")
            if ranking_conditions[0].condition_id == metric_condition.condition_id:
                raise ValueError("排名条件不能把自身作为指标来源")
            ranking_refs = [ref for ref in self.references if ref.condition_id == ranking_conditions[0].condition_id]
            if len(ranking_refs) != 1 or ranking_refs[0].parameter_overrides:
                raise ValueError("当前排名口径必须对应一个无隐式参数覆盖的排名引用")
            if self.scope.ranking.population_logic_tree is not None:
                population_refs = validate_logic_tree(self.scope.ranking.population_logic_tree)
                if not set(population_refs) <= set(reference_ids) or ranking_refs[0].reference_id in population_refs:
                    raise ValueError("排名比较范围只能引用已定义的非排名条件，不能循环依赖")
        sourced_items = [
            *self.conditions,
            *self.unresolved,
            *(item for item in self.references if item.source_quote),
        ]
        if sourced_items and not self.original_user_messages:
            raise ValueError("条件和未解决要求必须保留至少一条用户原始消息")
        messages = [_normalized_quote(message) for message in self.original_user_messages]
        if any(
            not any(_normalized_quote(item.source_quote) in message for message in messages)
            for item in sourced_items
        ):
            raise ValueError("条件来源片段必须能在用户原始消息中核对")
        return self


class SaveTaskRevisionRequest(ContractModel):
    base_revision: int = Field(ge=0)
    source_message_id: str = Field(min_length=1, max_length=100)
    task: ScreeningTaskRevision


def validate_executable_task(task: ScreeningTaskRevision) -> None:
    """Reject unresolved or incomplete tasks before creating a screening run."""
    if not task.conditions or not task.references or task.logic_tree is None:
        raise ValueError("筛选任务必须包含完整条件和组合逻辑")
    if task.scope.universe is None:
        raise ValueError("执行前必须确定股票范围")
    if task.unresolved:
        raise ValueError("筛选任务仍有待澄清、未支持或相互冲突的要求")
    for condition in task.conditions:
        if condition.library == "news":
            expression = condition.expression
            if expression.get("lookback_trading_days") is not None or expression.get("time_unit") == "trading_days":
                raise ValueError("当前资讯条件只支持自然日回溯，不能把交易日窗口直接当作可执行条件")
    ranking = task.scope.ranking
    if ranking is not None:
        universe = task.scope.universe
        if ranking.ranking_universe == "industry":
            raise ValueError("当前没有历史行业分类数据，不能执行行业内排名")
        if ranking.ranking_universe == "all_a_shares" and universe.kind != "all_a_shares":
            raise ValueError("全市场排名必须使用完整的A股筛选范围")
        if ranking.ranking_universe == "watchlist" and universe.kind != "watchlist":
            raise ValueError("观察池排名必须使用被冻结的观察池范围")


class ConditionImplementation(ContractModel):
    implementation_id: str = Field(min_length=1, max_length=100)
    condition_id: str
    condition_version: int = Field(ge=1)
    kind: Literal["builtin", "sandbox_python", "local_python", "evidence", "pattern", "saved_filter"]
    algorithm_version: str = Field(min_length=1, max_length=100)
    input_requirements: dict[str, Any] = Field(default_factory=dict)
    parameters: dict[str, Any] = Field(default_factory=dict)
    artifact_id: str | None = None


class ExecutionRequest(ContractModel):
    """Server-owned execution record; never accept it as LLM tool output."""

    request_id: str = Field(min_length=1, max_length=100)
    task_id: str
    revision: int = Field(ge=1)
    action: Literal["button", "explicit_user_message"]
    source_message_id: str | None = None
    idempotency_key: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def explicit_message_is_bound(self):
        if self.action == "explicit_user_message" and not self.source_message_id:
            raise ValueError("自然语言执行必须绑定用户原始消息")
        return self


class ConditionDecision(ContractModel):
    stock_code: str
    condition_id: str
    condition_version: int | None = Field(default=None, ge=1)
    reference_id: str
    state: DecisionState
    evaluation_status: EvaluationStatus
    reason_code: Literal[
        "condition_met", "condition_not_met", "data_missing", "evidence_conflict",
        "semantic_uncertain", "execution_failed", "not_processed", "unsupported_capability", "other",
    ]
    explanation: str = Field(min_length=1, max_length=4000)
    actual_values: dict[str, Any] = Field(default_factory=dict)
    thresholds: dict[str, Any] = Field(default_factory=dict)
    units: dict[str, str] = Field(default_factory=dict)
    evidence_refs: list[str] = Field(default_factory=list, max_length=200)
    artifact_refs: list[str] = Field(default_factory=list, max_length=200)
    data_as_of: str | None = None
    implementation_id: str | None = None

    @model_validator(mode="after")
    def failed_work_is_unknown(self):
        if self.evaluation_status != "completed" and self.state != "unknown":
            raise ValueError("失败或未处理的条件必须保留为 unknown")
        return self


class StockDecision(ContractModel):
    stock_code: str
    state: DecisionState
    evaluation_status: EvaluationStatus
    reason_code: str
    condition_decisions: list[ConditionDecision] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def nested_decisions_match_stock(self):
        if any(item.stock_code != self.stock_code for item in self.condition_decisions):
            raise ValueError("逐股结果包含其他证券的条件判断")
        reference_ids = [item.reference_id for item in self.condition_decisions]
        if len(reference_ids) != len(set(reference_ids)):
            raise ValueError("逐股结果中的条件引用不能重复")
        if self.evaluation_status != "completed" and self.state != "unknown":
            raise ValueError("失败或未处理的逐股结果必须为 unknown")
        return self


class RunCoverage(ContractModel):
    target_total: int = Field(ge=0)
    true_count: int = Field(ge=0)
    false_count: int = Field(ge=0)
    unknown_count: int = Field(ge=0)
    failed_count: int = Field(default=0, ge=0)
    not_evaluated_count: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def counts_are_consistent(self):
        if self.target_total != self.true_count + self.false_count + self.unknown_count:
            raise ValueError("目标范围必须完整拆分为 true、false、unknown")
        if self.failed_count + self.not_evaluated_count > self.unknown_count:
            raise ValueError("失败和未处理数量不能超过 unknown，且不能重复计数")
        return self


class ScreeningRunResult(ContractModel):
    run_id: str
    task_id: str
    revision: int = Field(ge=1)
    status: Literal["queued", "running", "succeeded", "partial", "failed", "cancelled"]
    execution_version: str
    coverage: RunCoverage
    stock_decisions: list[StockDecision] = Field(default_factory=list)
    execution_request_id: str
    source_manifests: list[str] = Field(default_factory=list)
    tool_call_ids: list[str] = Field(default_factory=list)
    model_metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def decisions_match_coverage(self):
        codes = [item.stock_code for item in self.stock_decisions]
        if len(codes) != len(set(codes)):
            raise ValueError("运行结果中的证券不能重复")
        counts = Counter(item.state for item in self.stock_decisions)
        if len(codes) != self.coverage.target_total or any(
            counts[state] != getattr(self.coverage, f"{state}_count")
            for state in ("true", "false", "unknown")
        ):
            raise ValueError("逐股结果必须逐股包含目标证券，逐股判断与覆盖计数不一致")
        failed = sum(item.evaluation_status == "failed" for item in self.stock_decisions)
        pending = sum(item.evaluation_status == "not_evaluated" for item in self.stock_decisions)
        if failed != self.coverage.failed_count or pending != self.coverage.not_evaluated_count:
            raise ValueError("逐股失败/未处理状态与覆盖计数不一致")
        if self.status == "succeeded" and self.coverage.unknown_count:
            raise ValueError("包含 unknown 的完整筛选必须标记为 partial")
        return self


def combine_logic_tree(
    tree: dict[str, Any],
    condition_states: dict[str, DecisionState],
) -> DecisionState:
    """Evaluate the saved AND/OR/NOT tree with three-valued logic."""
    references = validate_logic_tree(tree)
    if set(references) != set(condition_states):
        raise ValueError("条件状态必须与逻辑树引用完全一致")

    def visit(node: dict[str, Any]) -> DecisionState:
        if node["op"] == "condition":
            return condition_states[node["reference_id"]]
        states = [visit(child) for child in node["children"]]
        if node["op"] == "not":
            return {"true": "false", "false": "true", "unknown": "unknown"}[states[0]]
        if node["op"] == "all":
            return "false" if "false" in states else "true" if all(state == "true" for state in states) else "unknown"
        return "true" if "true" in states else "false" if all(state == "false" for state in states) else "unknown"

    return visit(tree)


def validate_stock_decision(
    task: ScreeningTaskRevision,
    decision: StockDecision,
) -> None:
    """Check per-reference results and derive the aggregate state from the saved tree."""
    validate_executable_task(task)
    definitions = {item.condition_id: item for item in task.conditions}
    references = {item.reference_id: item for item in task.references}
    by_reference = {item.reference_id: item for item in decision.condition_decisions}
    if set(by_reference) != set(references):
        raise ValueError("逐股结果必须且只能包含任务中的每个条件引用")

    for reference_id, item in by_reference.items():
        reference = references[reference_id]
        if item.condition_id != reference.condition_id:
            raise ValueError("逐股条件定义与任务引用不匹配")
        if reference.condition_version is not None and item.condition_version != reference.condition_version:
            raise ValueError("逐股条件版本与任务引用不匹配")
        implementation_id = definitions[reference.condition_id].implementation_id
        if implementation_id is not None and item.implementation_id != implementation_id:
            raise ValueError("逐股计算实现与条件定义不匹配")

    derived_state = combine_logic_tree(
        task.logic_tree,  # type: ignore[arg-type]
        {reference_id: item.state for reference_id, item in by_reference.items()},
    )
    if decision.state != derived_state:
        raise ValueError("逐股总状态必须由任务组合逻辑和原子条件状态计算")


def validate_run_for_task(
    task: ScreeningTaskRevision,
    result: ScreeningRunResult,
    target_stock_codes: list[str],
) -> None:
    """Bind an LLM-produced result to the server-owned task and universe snapshots."""
    validate_executable_task(task)
    if result.task_id != task.task_id or result.revision != task.revision:
        raise ValueError("筛选结果与本次执行的任务修订不匹配")
    if len(target_stock_codes) != len(set(target_stock_codes)):
        raise ValueError("服务器股票范围快照包含重复证券")
    if task.scope.universe.kind == "explicit" and set(target_stock_codes) != set(task.scope.universe.stock_codes):
        raise ValueError("服务器执行证券范围与已确认任务不匹配")
    actual = {item.stock_code: item for item in result.stock_decisions}
    if set(actual) != set(target_stock_codes):
        raise ValueError("筛选结果必须且只能包含服务器冻结股票范围中的证券")
    for decision in result.stock_decisions:
        validate_stock_decision(task, decision)
