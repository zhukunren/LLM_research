from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, ValidationError

from . import conversation_store, model_client, screening_tools, screening_service, saved_screening_tasks
from .screening_contracts import (
    ContractModel,
    IntentProposal,
    ScreeningTaskRevision,
    validate_executable_task,
    validate_intent_source,
)
from .screening_tools import ToolContext

PLANNER_PROMPT_VERSION = "conversation-planner-v1"
TOOL_PROMPT_VERSION = "conversation-tools-v1"
MAX_TOOL_ROUNDS = 12


class RequirementCoverage(ContractModel):
    source_quote: str = Field(min_length=1, max_length=1000)
    treatment: Literal["condition", "scope", "ranking", "logic", "unresolved", "context"]
    target_id: str | None = Field(default=None, max_length=100)
    question: str | None = Field(default=None, max_length=1000)


class ModelPlan(ContractModel):
    proposal: IntentProposal
    task_revision: dict[str, Any] | None
    assistant_text: str = Field(min_length=1, max_length=8000)
    use_tools: bool
    requirements: list[RequirementCoverage] = Field(default_factory=list, max_length=100)
    cancel_pending_execute: bool = False


class ConversationProcessingError(ValueError):
    pass


def _prompt(name: str) -> str:
    return (Path(__file__).with_name("prompts") / name).read_text(encoding="utf-8")


def _normalize_quote(value: str) -> str:
    return re.sub(r"\s+", "", value)


_REQUIREMENT_SEPARATOR = re.compile(r"并且|同时|以及|而且|且|[，,；;。！？!\n]+")
_ACTION_ONLY = re.compile(
    r"^(?:先不运行|暂不运行|取消(?:运行|筛选|执行)?|不要运行|不再筛选|先不筛|按这个筛|再筛|"
    r"筛选|筛一下|筛选一下|帮我筛|执行|运行|解释一下|(?:先|只)?整理条件|先不执行|保存(?:这个条件)?|继续|是的?|对的?|确认|可以|按你说的)[了啊吧吗呢]*$"
)


def _requirement_segments(message: str) -> list[str]:
    return [part.strip() for part in _REQUIREMENT_SEPARATOR.split(message) if part.strip()]


def _is_action_only(segment: str) -> bool:
    return bool(_ACTION_ONLY.fullmatch(_normalize_quote(segment)))


def _scope_quote_matches(target_id: str, quote: str) -> bool:
    if target_id == "universe":
        from .security_catalog import names
        return bool(
            re.search(r"A股|全市场|全部|所有|自选|观察池|股票池|指定股票|证券范围|\d{6}\.(?:SH|SZ|BJ)", quote, re.I)
        ) or any(name in quote for name in names().values())
    if target_id == "as_of":
        return bool(re.search(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}|截止|截至|哪一天|日期", quote))
    if target_id == "price_basis":
        return "复权" in quote
    if target_id == "report_lookback_calendar_days":
        return bool(re.search(r"研报.*(?:近|最近|回溯|过去)|(?:近|最近|回溯|过去).*研报", quote))
    if target_id == "news_lookback_calendar_days":
        return bool(re.search(r"资讯|新闻", quote))
    return False


def _validate_requirement_coverage(
    message: str,
    requirements: list[RequirementCoverage],
    current_task: ScreeningTaskRevision | None,
    candidate_task: ScreeningTaskRevision | None,
) -> tuple[list[str], list[dict[str, str]]]:
    message_normalized = _normalize_quote(message)
    segments = _requirement_segments(message)
    matched: dict[str, list[RequirementCoverage]] = {}
    for requirement in requirements:
        quote = _normalize_quote(requirement.source_quote)
        if not quote or quote not in message_normalized:
            raise ConversationProcessingError("需求覆盖中的原文片段不属于本条用户消息")
        # A conjunction is itself removed by segmentation. It describes the
        # relationship, but must not count as covering either operand.
        if requirement.treatment == "logic" and re.fullmatch(r"且|并且|同时|以及|而且|或|或者|并|和", quote):
            if not (candidate_task or current_task) or not (candidate_task or current_task).logic_tree:
                raise ConversationProcessingError("条件组合要求未写入组合逻辑")
            continue
        context_parts = _requirement_segments(requirement.source_quote)
        if requirement.treatment == "context" and context_parts and all(_is_action_only(part) for part in context_parts):
            for part in context_parts:
                part_quote = _normalize_quote(part)
                if any(_normalize_quote(segment) == part_quote for segment in segments):
                    matched.setdefault(part_quote, []).append(requirement)
            continue
        quoted_parts = _requirement_segments(requirement.source_quote)
        segment_quote = _normalize_quote(quoted_parts[0]) if len(quoted_parts) == 1 else quote
        segment = next((part for part in segments if segment_quote in _normalize_quote(part)), None)
        if segment is None:
            raise ConversationProcessingError("需求覆盖片段不能对应到单独的用户要求")
        matched.setdefault(_normalize_quote(segment), []).append(requirement)

    task = candidate_task or current_task
    condition_ids = set()
    reference_ids = set()
    if task:
        condition_ids = {item.condition_id for item in task.conditions}
        reference_ids = {item.reference_id for item in task.references}
    unresolved: list[dict[str, str]] = []
    scope_fields = {
        "universe", "as_of", "price_basis", "report_lookback_calendar_days", "news_lookback_calendar_days"
    }
    for segment in segments:
        key = _normalize_quote(segment)
        if _is_action_only(segment):
            continue
        requirements_for_segment = matched.get(key, [])
        if not requirements_for_segment:
            continue
        for requirement in requirements_for_segment:
            _validate_coverage_item(requirement, segment, task, condition_ids, reference_ids, scope_fields, unresolved)

    uncovered = [
        segment for segment in segments
        if not _is_action_only(segment) and _normalize_quote(segment) not in matched
    ]
    if candidate_task:
        unresolved.extend(
            {"source_quote": item.source_quote, "question": item.question}
            for item in candidate_task.unresolved
        )
    return uncovered, unresolved


def _validate_coverage_item(requirement, segment, task, condition_ids, reference_ids, scope_fields, unresolved):
    if requirement.treatment == "context":
        if not _is_action_only(segment):
            raise ConversationProcessingError("筛选要求不能标记为纯对话上下文")
    elif requirement.treatment == "condition":
        if not requirement.target_id or requirement.target_id not in condition_ids | reference_ids:
            raise ConversationProcessingError("筛选条件必须指向当前任务中的条件或稳定引用")
    elif requirement.treatment == "scope":
        if not task or requirement.target_id not in scope_fields:
            raise ConversationProcessingError("证券范围和口径要求必须映射到明确的任务字段")
        if getattr(task.scope, requirement.target_id) is None:
            raise ConversationProcessingError("模型将未设置的筛选口径标记为已覆盖")
        if not _scope_quote_matches(requirement.target_id, requirement.source_quote):
            raise ConversationProcessingError("需求原文与模型映射的证券范围字段不一致")
    elif requirement.treatment == "ranking":
        if not task or task.scope.ranking is None:
            raise ConversationProcessingError("排名要求未写入任务排名合同")
    elif requirement.treatment == "logic":
        if not task or task.logic_tree is None:
            raise ConversationProcessingError("条件组合要求未写入组合逻辑")
    elif requirement.treatment == "unresolved":
        if not requirement.question:
            raise ConversationProcessingError("待澄清要求必须附带具体问题")
        unresolved.append({"source_quote": requirement.source_quote, "question": requirement.question})

def _require_current_quote(quote: str | None, current_message: str, target: str) -> None:
    if not quote or _normalize_quote(quote) not in _normalize_quote(current_message):
        raise ConversationProcessingError(f"本次修改{target}必须引用当前用户原话")


def _validate_targeted_revision(
    previous: ScreeningTaskRevision | None,
    candidate: ScreeningTaskRevision,
    requirements: list[RequirementCoverage],
    current_message: str,
) -> None:
    condition_targets = {
        item.target_id for item in requirements if item.treatment == "condition" and item.target_id
    }
    scope_targets = {
        item.target_id for item in requirements if item.treatment == "scope" and item.target_id
    }
    ranking_targeted = any(item.treatment == "ranking" for item in requirements)
    logic_targeted = any(item.treatment == "logic" for item in requirements)

    old_conditions = {item.condition_id: item for item in previous.conditions} if previous else {}
    new_conditions = {item.condition_id: item for item in candidate.conditions}
    old_references = {item.reference_id: item for item in previous.references} if previous else {}
    new_references = {item.reference_id: item for item in candidate.references}
    if ranking_targeted:
        condition_targets.update(
            item.condition_id for item in [*old_conditions.values(), *new_conditions.values()]
            if item.library == "ranking"
        )

    def referenced_by_target(condition_id: str) -> bool:
        target_references = condition_targets & (set(old_references) | set(new_references))
        return any(
            reference_id in target_references
            and reference.condition_id == condition_id
            for reference_id, reference in {**old_references, **new_references}.items()
        )

    changed_condition_ids = set(old_conditions) | set(new_conditions)
    for condition_id in changed_condition_ids:
        old_item = old_conditions.get(condition_id)
        new_item = new_conditions.get(condition_id)
        if old_item and new_item and old_item == new_item:
            continue
        if condition_id not in condition_targets and not referenced_by_target(condition_id):
            raise ConversationProcessingError("模型修订改动了用户未指定的条件")
        old_reference_count = sum(item.condition_id == condition_id for item in old_references.values())
        if condition_id not in condition_targets and old_reference_count > 1:
            raise ConversationProcessingError("共享条件不能用单个引用的修改来覆盖全部引用")
        if new_item:
            _require_current_quote(new_item.source_quote, current_message, "条件")

    for reference_id in set(old_references) | set(new_references):
        old_item = old_references.get(reference_id)
        new_item = new_references.get(reference_id)
        if old_item and new_item and old_item == new_item:
            continue
        if reference_id not in condition_targets:
            condition_id = (new_item or old_item).condition_id
            if condition_id not in condition_targets:
                raise ConversationProcessingError("模型修订改动了用户未指定的条件引用")
        if new_item and previous is not None:
            _require_current_quote(new_item.source_quote, current_message, "条件引用")

    if previous:
        for field in (
            "universe", "as_of", "price_basis", "report_lookback_calendar_days", "news_lookback_calendar_days"
        ):
            if getattr(previous.scope, field) != getattr(candidate.scope, field) and field not in scope_targets:
                raise ConversationProcessingError("模型修订改动了用户未指定的范围或口径")
        if previous.scope.ranking != candidate.scope.ranking and not ranking_targeted:
            raise ConversationProcessingError("模型修订改动了用户未指定的排名规则")
        if previous.logic_tree != candidate.logic_tree and not logic_targeted:
            raise ConversationProcessingError("模型修订改动了用户未指定的组合逻辑")
    else:
        for field in scope_targets:
            if getattr(candidate.scope, field) is None:
                raise ConversationProcessingError("模型没有保存用户刚确认的筛选口径")
        for field in ("universe", "as_of", "price_basis", "report_lookback_calendar_days", "news_lookback_calendar_days"):
            if getattr(candidate.scope, field) is not None and field not in scope_targets:
                raise ConversationProcessingError("新任务包含用户未明确提出的范围或口径")
        if candidate.scope.ranking is not None and not ranking_targeted:
            raise ConversationProcessingError("新任务包含用户未明确提出的排名规则")


def _user_texts(messages: list[dict[str, Any]]) -> list[str]:
    return [item["content"] for item in messages if item["role"] == "user"]


def _validate_candidate_quotes(candidate: dict[str, Any], user_messages: list[str]) -> None:
    searchable = [_normalize_quote(message) for message in user_messages]
    references = [item for item in candidate.get("references", []) if isinstance(item, dict) and item.get("source_quote")]
    for item in [*candidate.get("conditions", []), *candidate.get("unresolved", []), *references]:
        quote = item.get("source_quote") if isinstance(item, dict) else None
        if not isinstance(quote, str) or not any(_normalize_quote(quote) in message for message in searchable):
            raise ConversationProcessingError("任务修订中的来源片段无法在本对话用户消息中核对")


def _comparable_task(task: ScreeningTaskRevision) -> dict[str, Any]:
    result = task.model_dump(mode="json")
    result.pop("revision", None)
    result.pop("original_user_messages", None)
    return result


def _revision_changes(
    previous: ScreeningTaskRevision | None,
    current: ScreeningTaskRevision | None,
) -> list[str]:
    if current is None:
        return []
    if previous is None:
        return [f"建立筛选任务，包含 {len(current.conditions)} 项条件。"]

    changes: list[str] = []
    old_conditions = {item.condition_id: item for item in previous.conditions}
    new_conditions = {item.condition_id: item for item in current.conditions}
    for condition_id in old_conditions:
        if condition_id not in new_conditions:
            changes.append(f"移除条件：{old_conditions[condition_id].description}")
    for condition_id in new_conditions:
        if condition_id not in old_conditions:
            changes.append(f"新增条件：{new_conditions[condition_id].description}")
    for condition_id in old_conditions:
        if condition_id not in new_conditions:
            continue
        old_item = old_conditions[condition_id].model_dump(mode="json")
        new_item = new_conditions[condition_id].model_dump(mode="json")
        label = new_conditions[condition_id].description
        if old_item.get("program") != new_item.get("program"):
            changes.append(f"调整条件计算方法或所需数据（{label}）")
        if old_item["expression"] != new_item["expression"]:
            before = json.dumps(old_item["expression"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            after = json.dumps(new_item["expression"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            changes.append(f"调整条件参数（{label}）：{before} -> {after}")
        if old_item["description"] != new_item["description"]:
            changes.append(f"调整条件说明：{old_item['description']} -> {new_item['description']}")
        if (old_item["library"], old_item["implementation_id"], old_item["implementation_version"]) != (
            new_item["library"], new_item["implementation_id"], new_item["implementation_version"]
        ):
            changes.append(f"调整条件使用的资料或实现（{label}）")
    if previous.logic_tree != current.logic_tree:
        changes.append("调整条件组合关系")
    if previous.scope.universe != current.scope.universe:
        changes.append("调整证券范围")
    if previous.scope.as_of != current.scope.as_of:
        changes.append(f"调整数据截止日：{previous.scope.as_of or '未设置'} -> {current.scope.as_of or '未设置'}")
    if previous.scope.price_basis != current.scope.price_basis:
        changes.append("调整价格复权口径")
    if previous.scope.ranking != current.scope.ranking:
        changes.append("调整排名规则")
    if (
        previous.scope.report_lookback_calendar_days != current.scope.report_lookback_calendar_days
        or previous.scope.news_lookback_calendar_days != current.scope.news_lookback_calendar_days
    ):
        changes.append("调整资讯或研报回溯时间范围")
    if previous.unresolved != current.unresolved:
        changes.append("更新了待澄清要求")
    return changes


def _plan_input(
    conversation: dict[str, Any],
    turn: dict[str, Any],
    current_message: dict[str, Any],
    task: ScreeningTaskRevision | None,
    pending_execute_message_id: str | None,
) -> dict[str, Any]:
    from .main import screening_capability_manifest
    from . import screening_service

    messages = conversation["messages"]
    from .security_catalog import entries
    mentioned_securities = [{"stock_code": item["stock_code"], "name": item["name"]} for item in entries()
                            if item["name"] in current_message["content"] or item["stock_code"][:6] in current_message["content"]]
    turns = {item["user_message_id"]: item for item in conversation.get("turns", [])}
    pending = []
    previous = [item for item in messages if item["role"] == "user" and item["id"] != current_message["id"]]
    for item in reversed(previous):
        prior_turn = turns.get(item["id"], {})
        if prior_turn.get("state") != "awaiting_user":
            break
        if task is not None and not prior_turn.get("result", {}).get("unresolved_requirements"):
            break
        pending.insert(0, item["content"])
    requirements_text = "\n".join([*pending, current_message["content"]])
    return {
        "mentioned_securities": mentioned_securities,
        "requirements_text": requirements_text,
        "requirement_segments": _requirement_segments(requirements_text),
        "entry_scope": conversation["entry_scope"],
        "current_message_id": current_message["id"],
        "current_message": current_message["content"],
        "current_message_sources": current_message["source_refs"],
        "previous_messages": [
            {"role": item["role"], "content": item["content"]}
            for item in messages
            if item["id"] != current_message["id"]
        ][-20:],
        "current_task_revision": task.model_dump(mode="json") if task else None,
        "capability_manifest": screening_capability_manifest(),
        "server_execute_grant": pending_execute_message_id,
        "turn_base_revision": turn["base_revision"],
        "active_run_id": conversation.get("active_run_id"),
        "screening_runs": screening_service.list_task_runs(conversation["id"], 20),
        "task_contract": ScreeningTaskRevision.model_json_schema(),
    }


def _make_candidate(
    raw_candidate: dict[str, Any],
    conversation_id: str,
    next_revision: int,
    user_messages: list[str],
) -> ScreeningTaskRevision:
    _validate_candidate_quotes(raw_candidate, user_messages)
    payload = dict(raw_candidate)
    payload["logic_tree"] = _canonical_logic(payload.get("logic_tree"), payload.get("references", []))
    payload["task_id"] = conversation_id
    payload["revision"] = next_revision
    payload["original_user_messages"] = user_messages[-100:]
    try:
        return ScreeningTaskRevision.model_validate(payload)
    except ValidationError as exc:
        raise ConversationProcessingError("模型生成的筛选条件不符合任务合同") from exc


def _canonical_logic(node, references):
    """Normalize unambiguous JSON spellings, without changing logical operands."""
    if not isinstance(node, dict):
        return node
    if len(node) == 1:
        key, value = next(iter(node.items()))
        if key in {"all", "any", "not"} and isinstance(value, list):
            return {"op": key, "children": [_canonical_logic(child, references) for child in value]}
        if key == "condition" and isinstance(value, str):
            direct = [ref for ref in references if ref.get("reference_id") == value]
            candidates = direct or [ref for ref in references if ref.get("condition_id") == value]
            if len(candidates) == 1:
                return {"op": "condition", "reference_id": candidates[0]["reference_id"]}
    if set(node) == {"op", "children"} and isinstance(node["children"], list):
        return {**node, "children": [_canonical_logic(child, references) for child in node["children"]]}
    return node


def _task_gap(task: ScreeningTaskRevision | None) -> str | None:
    if task is None or not task.conditions:
        return "还没有明确要筛选的条件。你想按哪些指标或特征筛选？"
    if task.unresolved:
        return task.unresolved[0].question
    if task.logic_tree is None:
        return "这些条件需要同时满足，还是满足其中任意一项？"
    if task.scope.universe is None:
        return "筛选范围是全部A股、自选池，还是指定的股票？"
    if task.scope.as_of is None:
        return "这次筛选以哪一天作为数据截止日？"
    try:
        validate_executable_task(task)
    except ValueError as exc:
        return str(exc)
    return None


def _task_tool_context(
    conversation_id: str,
    turn_id: str,
    revision: int,
    task: ScreeningTaskRevision | None,
    source_refs: list[dict[str, Any]],
) -> ToolContext:
    scope = task.scope if task else None
    universe = scope.universe if scope else None
    stock_codes = frozenset(universe.stock_codes) if universe and universe.kind == "explicit" else None
    if universe and universe.kind == "watchlist":
        from .db import connect
        with connect() as connection:
            stock_codes = frozenset(row[0] for row in connection.execute(
                "SELECT stock_code FROM watchlist_items WHERE watchlist_id=?", (universe.watchlist_id,)))
    allowed_document_ids = frozenset(
        item["source_id"] for item in source_refs if item.get("kind") == "report_page"
    )
    return ToolContext(
        conversation_id=conversation_id,
        turn_id=turn_id,
        task_revision=revision,
        as_of=scope.as_of.isoformat() if scope and scope.as_of else None,
        universe_kind=universe.kind if universe else None,
        stock_codes=stock_codes,
        report_lookback_calendar_days=scope.report_lookback_calendar_days if scope else None,
        news_lookback_calendar_days=scope.news_lookback_calendar_days if scope else None,
        allowed_document_ids=allowed_document_ids or None,
        allowed_news_ids=frozenset(item["source_id"] for item in source_refs if item.get("kind") == "news_item") or None,
    )


def _tool_answer(
    context: dict[str, Any],
    tool_context: ToolContext,
) -> tuple[str, list[str]]:
    tools = screening_tools.registry.functions_for_model()
    if not tools:
        return "当前没有可用的资料查询工具。", []
    conversation: list[dict[str, Any]] = [
        {"role": "user", "content": json.dumps(context, ensure_ascii=False, separators=(",", ":"))}
    ]
    tool_call_ids: list[str] = []
    total_calls = 0
    instructions = _prompt("conversation_tools_v1.md")

    for _ in range(MAX_TOOL_ROUNDS):
        turn = model_client.create_tool_turn(
            instructions,
            conversation,
            tools,
            max_output_tokens=5000,
        )
        if not turn.calls:
            if turn.refusal:
                return "我暂时无法处理这项请求。", tool_call_ids
            if turn.text and turn.text.strip():
                return turn.text.strip(), tool_call_ids
            raise ConversationProcessingError("模型没有给出可展示的最终答复")

        total_calls += len(turn.calls)
        if total_calls > screening_tools.MAX_TOOL_CALLS_PER_TURN:
            raise ConversationProcessingError("本回合工具调用次数超过上限")
        outputs: dict[str, dict[str, Any]] = {}
        for call in turn.calls:
            outputs[call.call_id] = screening_tools.registry.dispatch(call, tool_context)
            tool_call_ids.append(call.call_id)
        conversation.extend(turn.continuation_items)
        conversation.extend(model_client.tool_output_items(turn, outputs))

    raise ConversationProcessingError("工具查询轮数达到上限")


def _safe_failure(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, screening_service.ScreeningServiceError):
        return exc.code, str(exc)
    if isinstance(exc, model_client.ModelRequestError):
        return "model_request_failed", "助手暂时无法处理这条消息，请稍后重试。"
    if isinstance(exc, ConversationProcessingError):
        return "invalid_model_plan", "系统未能把这条要求整理成可靠的筛选条件，原要求已保留。请点击“重新处理”，无需改写你的描述。"
    return "conversation_processing_failed", "本轮处理失败，请稍后重试。"


def _request_valid_plan(planner_input, current_task, conversation_id, active_revision, user_messages):
    request_input = dict(planner_input)
    for attempt in range(2):
        raw = model_client.complete_json(
            _prompt("conversation_planner_v1.md"),
            json.dumps(request_input, ensure_ascii=False, separators=(",", ":")),
            max_output_tokens=9000,
        )
        try:
            plan = ModelPlan.model_validate(raw)
            if plan.task_revision is not None:
                candidate = _make_candidate(plan.task_revision, conversation_id, active_revision + 1, user_messages)
                uncovered, unresolved = _validate_requirement_coverage(
                    planner_input["requirements_text"], plan.requirements, current_task, candidate
                )
                if not uncovered and not unresolved:
                    _validate_targeted_revision(current_task, candidate, plan.requirements, planner_input["requirements_text"])
            return plan
        except (ValidationError, ConversationProcessingError) as exc:
            cause = exc.__cause__ or exc
            details = [{"field": list(item["loc"]), "message": item["msg"]}
                       for item in cause.errors(include_input=False, include_url=False)] if isinstance(cause, ValidationError) else str(exc)
            logging.getLogger(__name__).warning("Planner validation attempt %s: %s", attempt + 1, details)
            if attempt:
                raise ConversationProcessingError("模型生成的条件经过重试仍未通过核对") from exc
            request_input["repair"] = {"previous_plan": raw, "validation_errors": details}
    raise AssertionError("unreachable")


def process_turn(conversation_id: str, turn_id: str) -> dict[str, Any]:
    turn = conversation_store.get_turn(conversation_id, turn_id)
    if turn["state"] in {"awaiting_user", "succeeded", "failed", "cancelled"}:
        return turn
    conversation_store.start_turn(conversation_id, turn_id)
    conversation = conversation_store.get_conversation(conversation_id, message_limit=100)
    turn = conversation_store.get_turn(conversation_id, turn_id)
    active_revision = conversation["task_revision"]
    pending_execute_message_id = conversation_store.get_pending_execute_message(conversation_id)
    current_message = conversation_store.get_user_message(conversation_id, turn["user_message_id"])
    candidate_task: ScreeningTaskRevision | None = None
    authorized_message_id = pending_execute_message_id
    unresolved_requirements: list[dict[str, str]] = []
    execute_grant_cancelled = False
    tool_call_ids: list[str] = []

    try:
        if turn["base_revision"] != active_revision:
            raise conversation_store.ConversationConflict("处理回合的基础条件版本已经过期")
        current_task = (
            conversation_store.get_task_revision(conversation_id, active_revision)
            if active_revision > 0 else None
        )
        # The confirmation button submits this exact command. Its meaning is
        # explicit; do not ask a model to reinterpret or pre-calculate a saved task.
        if current_task is not None and current_message["content"].strip() == "按这个筛":
            gap = _task_gap(current_task)
            conversation_store.finish_turn(
                conversation_id, turn_id, active_revision, "awaiting_user" if gap else "succeeded",
                gap or "已确认当前条件、股票范围与日期。筛选完成后，请在结果区查看逐股判断。",
                {"intent": "execute", "intent_message_id": current_message["id"], "task_revision": active_revision,
                 "execution_authorization_message_id": current_message["id"], "execution_authorized": True,
                 "ready_to_execute": gap is None, "requires_clarification": bool(gap)},
                pending_execute_message_id=current_message["id"],
            )
            return conversation_store.get_turn(conversation_id, turn_id)
        planner_input = _plan_input(
            conversation, turn, current_message, current_task, pending_execute_message_id
        )
        plan = _request_valid_plan(planner_input, current_task, conversation_id, active_revision, _user_texts(conversation["messages"]))

        proposal = plan.proposal
        allowed_message_ids = {current_message["id"]}
        if pending_execute_message_id:
            allowed_message_ids.add(pending_execute_message_id)
        validate_intent_source(proposal, allowed_message_ids)
        if proposal.intent != "execute" and proposal.message_id != current_message["id"]:
            raise ConversationProcessingError("非执行意图必须引用本条用户消息")
        if plan.cancel_pending_execute:
            if proposal.intent == "execute" or proposal.message_id != current_message["id"]:
                raise ConversationProcessingError("撤销待执行授权必须由当前非执行用户消息触发")
            authorized_message_id = None
            execute_grant_cancelled = pending_execute_message_id is not None

        if plan.task_revision is not None:
            if proposal.intent not in {"edit", "execute"}:
                raise ConversationProcessingError("讨论或历史解释不能修改筛选任务")
            next_revision = active_revision + 1
            proposed_task = _make_candidate(
                plan.task_revision,
                conversation_id,
                next_revision,
                _user_texts(conversation["messages"]),
            )
            uncovered, unresolved_requirements = _validate_requirement_coverage(
                planner_input["requirements_text"], plan.requirements, current_task, proposed_task
            )
            if uncovered:
                unresolved_requirements.append({
                    "source_quote": uncovered[0],
                    "question": f"这项要求还没有明确的条件或数据来源：{uncovered[0]}。请补充口径；我不会先保存其余条件。",
                })
                candidate_task = current_task
            elif unresolved_requirements or proposed_task.unresolved:
                candidate_task = current_task
            else:
                _validate_targeted_revision(
                    current_task, proposed_task, plan.requirements, planner_input["requirements_text"]
                )
                if current_task and _comparable_task(proposed_task) == _comparable_task(current_task):
                    candidate_task = current_task
                else:
                    candidate_task = proposed_task
                    saved = conversation_store.save_task_revision(
                        conversation_id, active_revision, current_message["id"], candidate_task
                    )
                    active_revision = saved["revision"]
        elif proposal.intent == "edit" and not proposal.requires_clarification:
            raise ConversationProcessingError("条件修改请求缺少可核对的任务修订")
        else:
            candidate_task = current_task

        if not unresolved_requirements and (plan.requirements or proposal.requires_clarification):
            uncovered, unresolved_requirements = _validate_requirement_coverage(
                planner_input["requirements_text"], plan.requirements, current_task, candidate_task
            )
            if uncovered:
                unresolved_requirements.append({
                    "source_quote": uncovered[0],
                    "question": f"这项要求还没有明确的条件或数据来源：{uncovered[0]}。请补充口径；我不会先保存其余条件。",
                })

        wants_execution = proposal.intent == "execute"
        if plan.cancel_pending_execute:
            authorized_message_id = None
        elif wants_execution:
            authorized_message_id = proposal.message_id
        elif pending_execute_message_id:
            authorized_message_id = pending_execute_message_id

        clarification = proposal.clarification if proposal.requires_clarification else None
        if unresolved_requirements:
            clarification = unresolved_requirements[0]["question"]
        continuing_execute = bool(
            pending_execute_message_id and not plan.cancel_pending_execute and proposal.intent == "edit"
        )
        if not clarification and (wants_execution or continuing_execute):
            clarification = _task_gap(candidate_task)

        execution_ready = bool(
            (wants_execution or continuing_execute)
            and not clarification
            and candidate_task is not None
        )
        if execution_ready:
            try:
                validate_executable_task(candidate_task)
            except ValueError:
                clarification = _task_gap(candidate_task)
                execution_ready = False

        if proposal.intent == "save":
            if candidate_task is None:
                response_text = "当前对话还没有完整筛选条件，暂时不能保存。"
            else:
                try:
                    default_name = current_message["content"].strip()[:100] or candidate_task.conditions[0].description
                    saved = saved_screening_tasks.save_task(candidate_task, name=default_name)
                    response_text = f"已保存筛选条件“{saved['name']}” v{saved['version']}。保存不会自动执行筛选。"
                except saved_screening_tasks.SavedTaskError as exc:
                    response_text = f"暂时不能保存：{exc}"
        elif proposal.intent == "explain_run":
            if not proposal.run_id:
                response_text = "请指出要解释的筛选运行；我不会根据模糊编号猜测历史结果。"
            else:
                response_text = screening_service.explain_task_run_text(
                    conversation_id, proposal.run_id, stock_code=proposal.stock_code
                )
        elif clarification:
            response_text = clarification
            if authorized_message_id:
                response_text += " 补充后会继续处理这项已授权的筛选，不需要重复确认。"
        elif execution_ready:
            response_text = "已核对筛选条件。筛选完成后，请在结果区查看实际计算的逐股判断。"
        elif plan.use_tools:
            answer_context = {
                **planner_input,
                "intent": proposal.model_dump(mode="json"),
                "confirmed_task_revision": candidate_task.model_dump(mode="json") if candidate_task else None,
                "revision_changes": _revision_changes(current_task, candidate_task),
                "execution_authorized": bool(authorized_message_id),
            }
            response_text, tool_call_ids = _tool_answer(
                answer_context,
                _task_tool_context(
                    conversation_id,
                    turn_id,
                    active_revision,
                    candidate_task,
                    current_message["source_refs"],
                ),
            )
        else:
            response_text = plan.assistant_text.strip()

        changes = _revision_changes(current_task, candidate_task)
        if changes and proposal.intent in {"edit", "execute"}:
            response_text = "已更新筛选条件：" + "；".join(changes) + "。\n" + response_text
        if execution_ready:
            response_text += "\n筛选条件已确认，执行授权已记录。"

        next_state = "awaiting_user" if clarification else "succeeded"
        result = {
            "intent": proposal.intent,
            "intent_message_id": proposal.message_id,
            "execution_authorization_message_id": authorized_message_id,
            "task_revision": active_revision,
            "revision_changes": changes,
            "execution_authorized": bool(authorized_message_id),
            "ready_to_execute": execution_ready,
            "execute_grant_cancelled": execute_grant_cancelled,
            "unresolved_requirements": unresolved_requirements,
            "tool_call_ids": tool_call_ids,
            "model_metadata": {
                "planner_prompt": PLANNER_PROMPT_VERSION,
                "tool_prompt": TOOL_PROMPT_VERSION if plan.use_tools else None,
            },
        }
        conversation_store.finish_turn(
            conversation_id,
            turn_id,
            active_revision,
            next_state,
            response_text,
            result,
            pending_execute_message_id=authorized_message_id,
        )
    except Exception as exc:
        code, message = _safe_failure(exc)
        try:
            conversation_store.finish_turn(
                conversation_id,
                turn_id,
                active_revision,
                "failed",
                message,
                {"error_code": code, "ready_to_execute": False},
                pending_execute_message_id=authorized_message_id,
            )
        except conversation_store.ConversationConflict:
            raise
    return conversation_store.get_turn(conversation_id, turn_id)
