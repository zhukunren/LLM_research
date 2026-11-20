"""Research methods, with immutable per-conversation and per-turn skill snapshots."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, NotRequired, TypedDict
from uuid import uuid4

from .db import connect, json_dump, json_load, utc_now
from .settings import PROJECT_ROOT

SKILLS = PROJECT_ROOT / "apps" / "api" / "app" / "skills"


class MethodSource(TypedDict):
    name: str
    url: str
    revision: str


class MethodGuide(TypedDict):
    use_when: str
    inputs: str
    outputs: str
    example_prompt: str
    source: NotRequired[MethodSource]


@dataclass(frozen=True)
class AssistantDefinition:
    """Server-owned launch contract; adding a task requires no client branching."""

    id: str
    name: str
    description: str
    skill: str | None = None
    launch_mode: Literal["draft", "immediate"] = "draft"
    launch_label: str = "开始对话"
    launch_description: str = "输入问题，按助手的研究方法开展分析。"
    default_prompt: str = ""
    input_schema: dict = field(default_factory=lambda: {"type": "object", "properties": {}, "additionalProperties": False})
    revision: int = 1
    method_guide: MethodGuide | None = None


CHINA_STOCK_RESEARCH_REVISION = "66bea91d78f55aee97011b29aa64afa641824584"
CHINA_STOCK_RESEARCH_SOURCE: MethodSource = {
    "name": "china-stock-research-skills",
    "url": f"https://github.com/spikeHongg/china-stock-research-skills/tree/{CHINA_STOCK_RESEARCH_REVISION}",
    "revision": CHINA_STOCK_RESEARCH_REVISION,
}


BUILTINS = (
    AssistantDefinition(
        "general", "通用投研", "综合研究公司、行业和投资问题",
        method_guide=MethodGuide(
            use_when="想快速了解一家公司或一个行业，或有几个问题需要一起核对。",
            inputs="说明研究对象和想弄清的问题。可指定截止日期或附上已有材料。",
            outputs="围绕问题给出直接结论、可回查的证据和待核实事项。",
            example_prompt="研究比亚迪的主要收入来源，核对最近公开披露的经营变化，并列出值得继续验证的问题。",
        ),
    ),
    AssistantDefinition(
        "financial", "财报分析", "核对业绩变化、现金流与财务质量", "financial-analysis",
        method_guide=MethodGuide(
            use_when="看到利润、经营现金流或资产负债有变化，想弄清变化来自哪里。",
            inputs="公司名称或股票代码、关注的报告期。有明确的财务指标也可一并列出。",
            outputs="同口径的期间对比、变化原因、财务质量判断及其财报出处。",
            example_prompt="核对宁德时代近两年的归母净利润和经营现金流，解释两者变化是否一致，并标明数据出处。",
        ),
    ),
    AssistantDefinition(
        "reports", "研报解读", "提炼研报判断，区分事实、预测和假设", "report-reading",
        method_guide=MethodGuide(
            use_when="手上已有一份研报，想看懂作者的判断、盈利预测和关键假设。",
            inputs="研报附件、链接或资料库中的报告。可指定章节、数据或结论。",
            outputs="核心观点、假设及其影响、需要回到原始披露核验的问题，附研报定位。",
            example_prompt="解读我附上的研报，梳理盈利预测依赖的关键假设，并列出需要回到公司公告核实的说法。",
        ),
    ),
    AssistantDefinition(
        "supply-chain", "产业链研究", "识别供给约束层级，核验公司敞口、反方证据和失效条件",
        "supply-chain-research", revision=2,
        method_guide=MethodGuide(
            use_when="想知道一个产业趋势受哪个供给环节限制，以及哪些公司有可验证的业务敞口。",
            inputs="产业主题、产品或技术路线。可指定关注市场、公司范围和时间窗。",
            outputs="产业链及约束环节、相关公司的业务证据和研究优先级，以及会推翻判断的变化。",
            example_prompt="拆解 A 股光模块产业链，找出可能限制放量的环节，用公开披露核对相关公司的实际业务敞口。",
        ),
    ),
    AssistantDefinition(
        "risk", "风险复核", "寻找反证，检验关键假设和失效条件", "risk-review",
        method_guide=MethodGuide(
            use_when="手上已有投资假设或研究结论，想找出它最容易出错的地方。",
            inputs="待检验的结论和依据。可补充原报告、关键数字和需要核实的假设。",
            outputs="最影响结论的假设、支持和反对的证据、失效条件及可跟踪的指标。",
            example_prompt="复核「贵州茅台未来两年能维持当前毛利率水平」这一假设，找出最可能推翻它的证据和跟踪指标。",
        ),
    ),
    AssistantDefinition(
        "a-share-company-research", "A股公司研究", "核验业务转型、订单兑现和竞争优势",
        "a-share-company-research",
        method_guide=MethodGuide(
            use_when="想验证一家 A 股公司的新业务、扩产或订单是否已经体现在经营成果里。",
            inputs="公司名称或股票代码、关注的业务或项目。可指定报告期及已有公告。",
            outputs="经营事件和披露证据、订单到回款的进展、竞争对手参照及仍需核验的环节。",
            example_prompt="研究中际旭创业绩增长来自哪些业务，核对出货、收入确认和经营现金流的变化是否同步。",
            source=CHINA_STOCK_RESEARCH_SOURCE,
        ),
    ),
    AssistantDefinition(
        "a-share-valuation", "A股估值分析", "比较同行估值，测算不同假设下的估值区间",
        "a-share-valuation",
        method_guide=MethodGuide(
            use_when="想判断一家公司的估值处在哪个位置，或看清增长、利润率等假设对估值的影响。",
            inputs="股票代码或公司名称、估值日期。可提供可比公司或希望检验的假设。",
            outputs="同口径估值比较和来源。需要测算区间时，列出情景假设、计算方法和敏感因素。",
            example_prompt="用同一交易日的 TTM 市盈率和市净率比较宁德时代、亿纬锂能和国轩高科，注明口径、来源及差异原因。",
            source=CHINA_STOCK_RESEARCH_SOURCE,
        ),
    ),
    AssistantDefinition(
        "qmt-script", "QMT 脚本生成", "用自然语言编写、检查和下载 QMT 客户端内置 Python 策略", "qmt-script",
        launch_label="编写 QMT 脚本", launch_description="描述策略，在对话中生成代码、静态检查并下载 .py 文件。",
        revision=2,
    ),
    AssistantDefinition(
        "daily-hotspots", "今日热点", "检索并精选今日最重要的 10 条财经、市场与产业资讯", "daily-hotspots",
        launch_mode="immediate", launch_label="查看今日热点", launch_description="立即检索网页，按重要性整理资讯及来源。",
        default_prompt="今日热点｜{as_of_date}\n请检索真实网页，精选今天截至当前最重要的 10 条财经、市场与产业资讯，去重排序并解释重要性。逐条给出事件时间、发布时间和可打开的原始来源；可靠资讯不足 10 条时按实际数量交付。",
    ),
    AssistantDefinition(
        "policy-tracker", "政策追踪", "追踪最新政策原文，识别影响范围与落地进度", "policy-tracker",
        launch_mode="immediate", launch_label="追踪最新政策", launch_description="立即检索官方发布，梳理政策变化和实施阶段。",
        default_prompt="政策追踪｜{as_of_date}\n请检索近 24 小时影响中国市场的重要政策原文，按影响程度排序，说明发布机构、发布日期、实施日期、落地阶段和受影响行业。若近 24 小时无实质更新，可补充近 7 天进展并明确日期。",
    ),
    AssistantDefinition(
        "industry-updates", "产业动态", "跟进供需、订单和产能变化，核对实际产业证据", "industry-updates",
        launch_mode="immediate", launch_label="查看产业动态", launch_description="立即检索近期产业信息，提炼有证据的变化。",
        default_prompt="产业动态｜{as_of_date}\n请检索近 7 天对中国市场重要的产业变化，优先核对供需、订单、价格和产能的原始证据。按影响程度精选最多 8 项，标明事件时间、发布日期、来源、确认程度和下一步验证指标。",
    ),
)

LAUNCH_FIELDS = ("launch_mode", "launch_label", "launch_description", "default_prompt", "input_schema")


class AssistantError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def _body(content: str) -> str:
    return content.split("---", 2)[2].strip() if content.startswith("---") else content.strip()


def _builtins() -> list[dict]:
    return [{"id": item.id, "name": item.name, "description": item.description, "builtin": True,
             "enabled": True, "revision": item.revision, **{key: getattr(item, key) for key in LAUNCH_FIELDS},
             **({"method_guide": item.method_guide} if item.method_guide else {}),
             "instructions": _body((SKILLS / item.skill / "SKILL.md").read_text(encoding="utf-8-sig")) if item.skill else
             "根据用户的问题选择研究方法，综合核对公司、行业、市场数据与原始资料。简短问题直接回答；需要深入判断时说明证据、风险和待验证事项。"}
            for item in BUILTINS]


def _custom(row) -> dict:
    return {key: row[key] for key in ("id", "name", "description", "instructions", "revision", "created_at", "updated_at")} | {
        "builtin": False, "enabled": bool(row["enabled"]), "launch_mode": "draft", "launch_label": "开始对话",
        "launch_description": "输入问题，按助手的研究方法开展分析。", "default_prompt": "",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    }


def snapshot(profile: dict) -> dict:
    base = (SKILLS / "investment-research" / "SKILL.md").read_text(encoding="utf-8-sig")
    skill_content = base + "\n\n# Selected research method\n\n" + profile["instructions"] + "\n"
    digest = hashlib.sha256(skill_content.encode("utf-8")).hexdigest()
    return {key: profile[key] for key in ("id", "name", "description", "revision", "builtin")} | {
        "skill_hash": digest, "skill_content": skill_content,
        **{key: profile[key] for key in LAUNCH_FIELDS},
    }


def metadata(value: dict) -> dict:
    if not value:
        value = snapshot(_builtins()[0])
    return {key: value[key] for key in ("id", "name", "description", "revision", "builtin", "skill_hash")}


def list_assistants(include_disabled: bool = False) -> list[dict]:
    with connect() as connection:
        rows = connection.execute("SELECT * FROM research_assistants WHERE enabled=1 OR ? ORDER BY created_at,id", (include_disabled,)).fetchall()
    return [profile | {"skill_hash": snapshot(profile)["skill_hash"]} for profile in [*_builtins(), *map(_custom, rows)]]


def selection_snapshot(connection, assistant_id: str = "general") -> dict:
    profile = next((item for item in _builtins() if item["id"] == assistant_id), None)
    if profile is None:
        row = connection.execute("SELECT * FROM research_assistants WHERE id=?", (assistant_id,)).fetchone()
        if row is None:
            raise AssistantError("找不到这个研究助手，请重新选择。")
        profile = _custom(row)
    if not profile["enabled"]:
        raise AssistantError("这个助手已停用，请选择其他助手。")
    return snapshot(profile)


def save_assistant(name: str, description: str, instructions: str, *, assistant_id: str | None = None,
                   base_revision: int | None = None, enabled: bool = True, request_id: str | None = None) -> dict:
    name, description, instructions = name.strip(), description.strip(), instructions.strip()
    if not 1 <= len(name) <= 60 or len(description) > 240 or not 1 <= len(instructions) <= 16000:
        raise AssistantError("请填写名称和研究要求，名称最多60字，简介最多240字，研究要求最多16000字。")
    if assistant_id in {item.id for item in BUILTINS}:
        raise AssistantError("内置助手保留原始版本，请复制为自定义助手后修改。", 409)
    now = utc_now()
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        create_hash = hashlib.sha256(json_dump([name, description, instructions, enabled]).encode("utf-8")).hexdigest()
        if not assistant_id and request_id:
            existing = connection.execute("SELECT * FROM research_assistants WHERE create_request_id=?", (request_id,)).fetchone()
            if existing:
                if existing["create_request_hash"] != create_hash:
                    raise AssistantError("相同创建请求不能提交不同的助手内容。", 409)
                profile = _custom(existing)
                return profile | {"skill_hash": snapshot(profile)["skill_hash"]}
        if assistant_id:
            row = connection.execute("SELECT * FROM research_assistants WHERE id=?", (assistant_id,)).fetchone()
            if row is None:
                raise AssistantError("找不到这个助手。", 404)
            if base_revision != row["revision"]:
                raise AssistantError("助手已被修改，请重新读取后再保存。", 409)
            connection.execute("UPDATE research_assistants SET name=?,description=?,instructions=?,enabled=?,revision=revision+1,updated_at=? WHERE id=?",
                               (name, description, instructions, enabled, now, assistant_id))
        else:
            assistant_id = "custom-" + str(uuid4())
            connection.execute("INSERT INTO research_assistants(id,name,description,instructions,enabled,revision,created_at,updated_at,create_request_id,create_request_hash) VALUES(?,?,?,?,?,1,?,?,?,?)",
                               (assistant_id, name, description, instructions, enabled, now, now, request_id, create_hash))
        profile = _custom(connection.execute("SELECT * FROM research_assistants WHERE id=?", (assistant_id,)).fetchone())
    return profile | {"skill_hash": snapshot(profile)["skill_hash"]}


def update_selection(conversation_id: str, assistant_id: str, base_revision: int) -> dict:
    from . import conversation_store
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = conversation_store._require_idle_conversation(connection, conversation_id)
        if row["workflow_type"] != "research":
            raise AssistantError("研究助手只能用于研究对话，选股使用独立的方案与确认流程。")
        if row["assistant_revision"] != base_revision:
            raise AssistantError("对话中的助手已变更，请重新读取后再选择。", 409)
        chosen = selection_snapshot(connection, assistant_id)
        changed = json_dump(chosen) != row["assistant_snapshot_json"]
        connection.execute("UPDATE conversations SET assistant_snapshot_json=?,assistant_revision=assistant_revision+?,updated_at=? WHERE id=?",
                           (json_dump(chosen), int(changed), utc_now(), conversation_id))
        return {"assistant": metadata(chosen), "assistant_revision": row["assistant_revision"] + int(changed)}


def turn_snapshot(conversation_id: str, turn_id: str) -> dict:
    with connect() as connection:
        row = connection.execute("SELECT assistant_snapshot_json,workflow_type FROM conversation_turns WHERE id=? AND conversation_id=?", (turn_id, conversation_id)).fetchone()
    if row is None:
        raise AssistantError("找不到研究轮次。", 404)
    stored = json_load(row["assistant_snapshot_json"])
    # Pre-feature turns have no reconstructable skill snapshot and use the original default.
    return stored or snapshot(_builtins()[0])


def materialize_skill(workspace: Path, chosen: dict) -> Path:
    """Only the server-computed digest determines the file path, never user input."""
    content = chosen["skill_content"]
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    root = workspace.resolve() / ".assistant-skills"
    path = root / digest / "SKILL.md"
    if not path.resolve().is_relative_to(workspace.resolve()):
        raise AssistantError("助手文件路径无效。")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path
