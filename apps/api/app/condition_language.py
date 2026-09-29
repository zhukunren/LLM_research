"""Compile user intent into bounded, inspectable condition plans, never code."""
from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import Field, ValidationError

from .condition_contract import describe_filter
from .model_client import ModelRequestError, complete_json
from .models import StrictModel
from .rules import filter_parameters, validate_filter
from .settings import llm_settings

COMPILER_VERSION = "condition-plan-v3-timeseries"


class PlanCondition(StrictModel):
    key: str = Field(pattern=r"^c[1-9][0-9]?$", max_length=3)
    name: str = Field(min_length=1, max_length=100)
    library: Literal["technical", "report", "news"]
    source_quote: str = Field(min_length=1, max_length=4000)
    expression: dict[str, Any]


class PlanIssue(StrictModel):
    kind: Literal["clarification", "unsupported"]
    text: str = Field(min_length=1, max_length=500)
    suggestion: str = Field(default="", max_length=500)


class ModelPlan(StrictModel):
    conditions: list[PlanCondition] = Field(max_length=20)
    tree: dict[str, Any] | None
    issues: list[PlanIssue] = Field(default_factory=list, max_length=20)
    assumptions: list[str] = Field(default_factory=list, max_length=20)


COMPARATOR_PATTERN = r"(不低于|不小于|大于等于|不高于|不大于|小于等于|高于|大于|超过|低于|小于|等于|至少|至多|>=|<=|>|<|=)"
NUMBER = r"(-?\d+(?:\.\d+)?)"
OPS = {"不低于": "gte", "不小于": "gte", "大于等于": "gte", "至少": "gte", ">=": "gte", "不高于": "lte", "不大于": "lte", "小于等于": "lte", "至多": "lte", "<=": "lte", "高于": "gt", "大于": "gt", "超过": "gt", ">": "gt", "低于": "lt", "小于": "lt", "<": "lt", "等于": "eq", "=": "eq"}


def _atom(text: str) -> dict | None:
    compact = re.sub(r"\s+", "", text)
    match = re.fullmatch(rf"(?:收盘价|股价){COMPARATOR_PATTERN}(\d+)(?:个)?日均线", compact)
    if not match:
        match = re.fullmatch(r"(?:收盘价|股价)(?:在)?(\d+)日均线(?:之)?(上方|上|下方|下)", compact)
        if match:
            return {"op": "indicator_compare", "indicator": "sma", "field": "close", "window": int(match[1]), "operator": "lt" if match[2].startswith("上") else "gt", "compare_field": "close"}
    else:
        inverse = {"gt": "lt", "gte": "lte", "lt": "gt", "lte": "gte", "eq": "eq"}
        return {"op": "indicator_compare", "indicator": "sma", "field": "close", "window": int(match[2]), "operator": inverse[OPS[match[1]]], "compare_field": "close"}
    match = re.fullmatch(r"(?:MA|均线)?(\d+)(?:日均线|日)?(上穿|下穿)(?:MA|均线)?(\d+)(?:日均线|日)?", compact, re.I)
    if match:
        return {"op": "ma_cross", "fast_window": int(match[1]), "slow_window": int(match[3]), "direction": "up" if match[2] == "上穿" else "down"}
    match = re.fullmatch(rf"(?:近|最近|过去)(\d+)(?:个)?交易日(?:的)?涨幅{COMPARATOR_PATTERN}{NUMBER}%", compact)
    if match:
        return {"op": "metric_compare", "metric": "return_pct", "window": int(match[1]), "operator": OPS[match[2]], "value": float(match[3])}
    match = re.fullmatch(rf"(?:连续|持续)(\d+)(?:个)?(?:交易日|日)(?:内)?(?:的)?(?:每日)?成交量{COMPARATOR_PATTERN}(?:此前|前|过去)?(\d+)(?:个交易日|日)(?:平均成交量|前?日?均量|均量)(?:的)?({NUMBER})?倍?", compact)
    if match:
        expression = {"op": "metric_compare", "metric": "volume_ratio", "window": int(match[3]), "operator": OPS[match[2]], "value": float(match[4]) if match[4] else 1.0, "consecutive_days": int(match[1])}
        return expression
    match = re.fullmatch(rf"(?:今日|当日)?(?:的)?成交量{COMPARATOR_PATTERN}(?:此前|前|过去)?(\d+)(?:个交易日|日)(?:平均成交量|前?日?均量|均量)(?:的)?{NUMBER}倍", compact)
    if match:
        return {"op": "metric_compare", "metric": "volume_ratio", "window": int(match[2]), "operator": OPS[match[1]], "value": float(match[3])}
    match = re.fullmatch(rf"(?:收盘价|股价){COMPARATOR_PATTERN}{NUMBER}(?:元)?", compact)
    if match:
        return {"op": "metric_compare", "metric": "close", "window": 1, "operator": OPS[match[1]], "value": float(match[2])}
    match = re.fullmatch(rf"RSI(\d+){COMPARATOR_PATTERN}{NUMBER}", compact, re.I)
    if match:
        return {"op": "indicator_compare", "indicator": "rsi", "field": "close", "window": int(match[1]), "operator": OPS[match[2]], "value": float(match[3])}
    match = re.fullmatch(rf"MACD(?:柱|柱值|HIST){COMPARATOR_PATTERN}{NUMBER}", compact, re.I)
    if match:
        return {"op": "indicator_compare", "indicator": "macd_hist", "field": "close", "window": 9, "operator": OPS[match[1]], "value": float(match[2])}
    return None


def local_plan(prompt: str) -> dict | None:
    """Full consumption only: a recognized substring is never a valid whole plan."""
    text = re.sub(r"^(?:请)?(?:帮我)?(?:筛选出|筛选|找出|寻找|找一下|选出)\s*", "", prompt.strip()).strip("。.!！ ")
    text = text.replace("（", "(").replace("）", ")")
    text = re.sub(r"[,，;；]\s*(并且|而且|且|和|或者|或)", r"\1", text)
    parts = re.split(r"(\(|\)|并且|而且|或者|且|或|以及|并|和|[,，;；]|排除|不满足|\bAND\b|\bOR\b|\bNOT\b)", text, flags=re.I)
    tokens = [part.strip() for part in parts if part.strip()]
    conditions: list[dict] = []
    index = 0

    def parse_primary(depth=0):
        nonlocal index
        if depth > 12 or index >= len(tokens):
            raise ValueError()
        token = tokens[index]
        index += 1
        if token in ("排除", "不满足", "NOT", "not"):
            return {"op": "not", "children": [parse_primary(depth + 1)]}
        if token == "(":
            node = parse_or(depth + 1)
            if index >= len(tokens) or tokens[index] != ")":
                raise ValueError()
            index += 1
            return node
        expression = _atom(token)
        if expression is None or validate_filter("technical", expression) or len(conditions) >= 20:
            raise ValueError()
        key = f"c{len(conditions) + 1}"
        conditions.append({"key": key, "name": describe_filter("technical", expression)["summary"], "library": "technical", "source_quote": token, "expression": expression})
        return {"op": "condition", "key": key}

    def parse_and(depth=0):
        nonlocal index
        children = [parse_primary(depth)]
        while index < len(tokens) and tokens[index].upper() in ("并且", "而且", "且", "以及", "并", "和", ",", "，", ";", "；", "AND"):
            index += 1
            children.append(parse_primary(depth))
        return children[0] if len(children) == 1 else {"op": "all", "children": children}

    def parse_or(depth=0):
        nonlocal index
        children = [parse_and(depth)]
        while index < len(tokens) and tokens[index].upper() in ("或者", "或", "OR"):
            index += 1
            children.append(parse_and(depth))
        return children[0] if len(children) == 1 else {"op": "any", "children": children}

    try:
        tree = parse_or()
        if index != len(tokens):
            return None
    except (ValueError, RecursionError):
        return None
    return {"conditions": conditions, "tree": tree, "issues": [], "assumptions": []}


SYSTEM_PROMPT = """你是股票筛选条件编译器。只输出 JSON，不输出代码、SQL、行情事实或投资建议。
目标用户没有技术背景。忠实保留全部意图，拆成可复用的原子条件和组合树。含义不明确就提具体问题；没有数据能力就明确说明，绝不能替换成相似的现有条件。不得默默忽略市值、行业、ST、财务等限制。
输出严格为 {conditions:[], tree:对象或null, issues:[], assumptions:[]}。
每项 condition 严格为 {key:"c1",name:中文短名,library:"technical"或"report"或"news",source_quote:用户原文中的连续片段,expression:对象}。
树叶 {op:"condition",key:"c1"}，组合 {op:"all"或"any"或"not",children:[]}；not 必须只有一个子节点，全部条件都被引用。保留括号优先级，且优先于或，并在 assumptions 解释混合逻辑。条件定义只放在 conditions 数组中；condition 叶节点只放在 tree 中，不能作为 condition 定义重复放入 conditions。
issues 每项 {kind:"clarification"或"unsupported",text:问题或无法支持的要求,suggestion:用户可以怎么补充}。即使部分可识别也必须留下每项未支持的要求。条件最多20项。
可执行技术表达式：
1 {op:"indicator_compare",indicator:"sma"或"ema"或"rsi"或"macd_dif"或"macd_dea"或"macd_hist"或"kdj_k"或"kdj_d"或"kdj_j"或"atr"或"bollinger",field:"close",window:2..250,operator:"gt"或"gte"或"lt"或"lte"或"eq",value:数字}。value 可替换成 compare_field:"close"。比较顺序为指标在左、收盘价在右，所以收盘价高于20日均线要写 sma lt close。MACD window=9, KDJ/ATR<=100，bollinger 仅支持上轨。未指明 RSI/KDJ 周期可用14/9，但必须在 assumptions 说明。
2 {op:"ma_cross",fast_window:整数,slow_window:整数,direction:"up"或"down"}，2<=fast<slow<=250，当日相对前一日穿越。
3 {op:"metric_compare",metric:"return_pct"或"volume_ratio"或"close",window:1..250,operator:同上,value:数字}。涨幅单位为百分点(5%=5)，回看 window 个有行情交易日，用 window+1 根日线；volume_ratio 是当日成交量/此前window日均量，不含当日，不是盘中量比；close 的 window 必须为1。
支持最多20个交易日逐日都满足的区间涨幅或成交量倍数条件（consecutive_days:1..20）。时序公式可组合日线字段、内置指标、历史偏移、滚动均值/合计/最大值/最小值/标准差、数值运算和比较，构造偏离率、波动率等派生指标。“连续”使用 consecutive，“近期曾满足”使用 within，“至少N次”使用 count_true 再比较次数，“刚上穿/下穿”使用 cross；必须保留事件语义，不能改成普通大于/小于。没指定“近期”周期或“放量/强势”阈值时必须提问，不能编造阈值。“天”未明确自然日还是交易日应提问。
技术库还可生成受限时序公式：{op:"timeseries_filter",formula:公式节点}。公式最多32个节点、嵌套不超过8层，所需历史最多500根日线。允许的公式节点为{op:"field",field:"open|high|low|close|volume|amount"}、{op:"constant",value:有限数值}、{op:"indicator",name:既有指标ID,field:允许字段,window:允许周期}、{op:"return_pct",window:1..250}、{op:"relative_volume",window:1..250}、{op:"rolling",method:"mean|sum|min|max|std",window:1..250,input:数值时序}、{op:"lag",period:1..250,input:数值时序}、{op:"binary",operator:"add|subtract|multiply|divide",left:数值时序,right:数值时序}、{op:"compare",operator:"gt|gte|lt|lte|eq",left:数值时序,right:数值时序}、{op:"cross",direction:"up|down",left:数值时序,right:数值时序}、{op:"logic",operator:"all|any|not",children:[比较条件]}、{op:"consecutive",days:1..20,input:比较条件}、{op:"within",window:1..250,input:比较条件}、{op:"count_true",window:1..250,input:比较条件}。不得生成或执行Python、SQL、代码、未支持字段或自定义函数。
例如“连续3日成交量大于20日均量”的公式是 {op:"consecutive",days:3,input:{op:"compare",operator:"gt",left:{op:"field",field:"volume"},right:{op:"rolling",method:"mean",window:20,input:{op:"lag",period:1,input:{op:"field",field:"volume"}}}}}。例如“RSI14大于45”的公式是 {op:"compare",operator:"gt",left:{op:"indicator",name:"rsi",field:"close",window:14},right:{op:"constant",value:45}}。必须按原话保留指标、阈值、窗口、组合逻辑和事件语义。
4 {op:"timeseries_filter",formula:时序公式}。公式最多32个节点、8层嵌套，所有字段和操作必须在白名单内；公式历史不得超过500根日线。公式原语：{op:"field",field:"open|high|low|close|volume|amount"}、{op:"constant",value:有限数字}、{op:"indicator",name:已有白名单指标,field:允许字段,window:允许周期}、{op:"return_pct",window:1..250}、{op:"relative_volume",window:1..250}、{op:"rolling",method:"mean|sum|min|max|std",window:1..250,input:数值时序}、{op:"lag",period:1..250,input:数值时序}、{op:"binary",operator:"add|subtract|multiply|divide",left:数值时序,right:数值时序}、{op:"compare",operator:"gt|gte|lt|lte|eq",left:数值时序,right:数值时序}、{op:"cross",direction:"up|down",left:数值时序,right:数值时序}、{op:"logic",operator:"all|any|not",children:[比较逻辑]}、{op:"consecutive",days:1..20,input:比较逻辑}、{op:"within",window:1..250,input:比较逻辑}、{op:"count_true",window:1..250,input:比较逻辑}。摘要使用中文说明意图。只返回此公式结构；不得生成Python、SQL、字段路径或其他代码。
研报语义仅当用户明确要求基于研报判断时，才用 library=report 的 {op:"evidence_query",evaluation_mode:"rubric",combine:"all"或"any",lookback_calendar_days:1..3650,criteria:[{id:英文下划线ID,label:中文,question:可按报告证据判断的问题,signals:[支持信号],counter_signals:[直接反向信号]}]}。一项独立研报意图为一个 condition。实际事实与预测分开。回溯期未指定可默认365自然日并在 assumptions 说明。不是量化财务数据库，不得用研报代替用户未指定来源的净利润、市值、PE、行业归属等字段。
无财务、估值、行业、资金流、实时资讯或ST元数据，不可用日线近似；这些要求必须 issues.unsupported。不要因为无法支持某一项就丢掉其他条目。source_quote 必须引用真实用户文字。
“区分已实现与预测”“不把预测当作事实”属于证据使用约束，不是独立的命中条件。要求实际收入增长时，仅生成实际收入增长这一判断标准，并在question中明确预测本身不能支持true；不能额外创建未来预测条件再用any组合，也不能要求必须有预测才算满足。只有用户明确希望筛选预测内容时才创建预测条件。
重要：上文 timeseries_filter 的封闭公式树用于可由基础运算清晰表达的公式。用户提出内置指标不能表达的新指标、复合算法或自定义时序计算时，必须使用 {op:"generated_timeseries_filter",summary:中文规则摘要,required_fields:[输入字段],parameters:{参数名:有限数字默认值},parameter_specs:{参数名:{label:中文名称,type:"number"或"integer",min:可选最小值,max:可选最大值}},code:生成函数源码}。模型可自行设计公式、辅助函数和计算步骤，不限于现有指标库；源码会按哈希直接加载为版本化模块，语法和运行边界由系统检查。
主函数签名固定为 def calculate(bars, params)。bars 是按日期升序、截止日及之前最多500根的一维只读数组字典，只含 open/high/low/close/volume/amount 与 valid 掩码；缺失或异常值为 numpy.nan。required_fields 必须逐项声明代码读取的行情字段。params 只含 parameters 中声明的有限数字。
函数必须返回 {"result":逐日结果,"metrics":{指标名:数值时序}}。每条输出时序与 bars 等长；result 使用 True/False/1/0 表示符合或不符合，用 None/numpy.nan 表示数据不足；metrics 只能是有限数值或 None/numpy.nan。预热不足、输入缺失、除零或公式未定义时必须返回未知，不能用0、False或相似条件代替。metrics 最多12项，用于解释最新计算值及近20个交易日过程。
生成源码只允许顶层 calculate(bars, params) 和无递归辅助函数，使用有限的 Python 数值、布尔、列表/字典/一维数组、赋值、if、for 与数组运算。不允许 import、while、属性反射、文件/网络/环境/进程访问、eval/exec、第三方库或多维广播。只可通过运行时注入的 np 数组函数和少量安全内置函数计算；公式节点、源码大小、循环范围、每次运行步数与输出长度均有上限。严禁未来数据和前视偏差。
required_fields 须包含代码读取的 OHLCVA 字段；参数须在 parameters 与 parameter_specs 中成对声明。只在最终时序结果未知处输出 NaN；模型应在 metrics 中返回用户容易理解的中间指标，不暴露无关临时数组。模型须在 assumptions 说明对未定义指标所采用的常见计算定义；若原意不能合理确定，则先澄清。筛选输入和输出由系统固定，内部算法由模型根据用户原意设计。
上述“不生成 Python”限制只适用于 timeseries_filter 的固定公式树；对内置指标无法表达的新算法，必须输出 generated_timeseries_filter 的源码模块。np 只开放 abs、acos、all、amax、amin、any、arctan、arctan2、argsort、clip、convolve、cos、cumprod、cumsum、diff、exp、floor、full_like、isfinite、isinf、isnan、log、log1p、maximum、mean、minimum、nanmax、nanmean、nanmin、nanpercentile、nanstd、nansum、nanvar、percentile、power、quantile、roll、sign、sin、sort、sqrt、square、std、sum、tanh、unique、var、where、zeros_like、ones_like、full_like、pi、nan。示例代码直接使用 bars["close"] 一维数组与 np 函数，不导入模块；条件输出为 1、0、NaN，指标说明输出数值数组。
summary 写清指标含义和比较关系，不要重复写入可调参数的默认数值；参数名称和值会在条件摘要中单独显示。缺失预热值必须通过 np.isfinite 或 bars["valid"] 生成 NaN，不能让 NaN 比较静默变成 False。
技术条件的 name 与 generated_timeseries_filter.summary 必须是给无技术背景用户看的中文自然语言，不能展示 rolling、gte、0.05 这类公式节点名或归一化比例；百分比按用户熟悉的百分数写，例如“当前收盘价距近20日最高收盘价不超过5%”。计算公式与条件摘要分开。
百分比阈值统一按百分点计算，5%表示数值5；若基础比率结果在0到1之间，先乘100再比较，不能把0.05作为用户阈值显示。百分比条件的可调参数也使用百分点单位。
新型时序计算可组合 np.arange（最多500个整数位置）与 np.polyfit（阶数最多3）等安全数组函数；例如线性回归、斜率和R²不要求登记为内置指标。
只有预测、没有实际数据时应保留unknown。counter_signals只写直接反向的已实现事实，例如实际收入下降，不把“只有预测”列作实际增长的反向证据。
"""


def validate_plan(candidate: dict, prompt: str) -> dict:
    if isinstance(candidate, dict) and isinstance(candidate.get("conditions"), list):
        declared = {item.get("key") for item in candidate["conditions"] if isinstance(item, dict) and item.get("op") != "condition" and isinstance(item.get("key"), str)}
        conditions = [item for item in candidate["conditions"] if not (isinstance(item, dict) and (set(item) == {"key"} or set(item) == {"op", "key"} and item.get("op") == "condition") and item.get("key") in declared)]
        candidate = {**candidate, "conditions": conditions}
    plan = ModelPlan.model_validate(candidate).model_dump()
    keys = [item["key"] for item in plan["conditions"]]
    if len(set(keys)) != len(keys):
        raise ValueError("条件编号重复")
    for item in plan["conditions"]:
        errors = validate_filter(item["library"], item["expression"])
        if errors:
            raise ValueError("；".join(errors))
        if re.sub(r"\s+", "", item["source_quote"]) not in re.sub(r"\s+", "", prompt):
            raise ValueError("条件来源片段不能在用户原话中找到")
    seen: set[str] = set()
    count = 0

    def visit(node, depth=0):
        nonlocal count
        count += 1
        if count > 80 or depth > 12 or not isinstance(node, dict):
            raise ValueError("组合树过深或格式无效")
        if node.get("op") == "condition":
            if set(node) != {"op", "key"} or not isinstance(node.get("key"), str) or node["key"] not in keys:
                raise ValueError("组合引用了不存在的条件")
            seen.add(node["key"])
            return
        if set(node) != {"op", "children"} or node.get("op") not in ("all", "any", "not"):
            raise ValueError("组合逻辑无效")
        children = node["children"]
        if not isinstance(children, list) or not children or (node["op"] == "not" and len(children) != 1):
            raise ValueError("组合组不能为空，排除组只接受一个子组")
        for child in children:
            visit(child, depth + 1)

    if plan["tree"] is not None:
        visit(plan["tree"])
    if set(keys) != seen:
        raise ValueError("组合树遗漏了条件")
    if not keys and not plan["issues"]:
        raise ValueError("没有生成条件或补充问题")
    for item in plan["conditions"]:
        if item["library"] == "technical" and item["expression"].get("op") == "timeseries_filter":
            item["name"] = item["source_quote"]
            item["expression"]["summary"] = item["source_quote"]
        item["contract"] = describe_filter(item["library"], item["expression"])
        item["parameters"] = filter_parameters(item["library"], item["expression"])
    return plan


def compile_plan(prompt: str, library_context: str | None = None) -> dict:
    candidate = local_plan(prompt) if library_context in (None, "technical") else None
    literal_news_request = False
    if library_context == "news":
        # Only explicit quoted keyword requests have a deterministic local meaning.
        match = re.fullmatch(r'(?:近|过去)(\d+)(?:个)?自然日(?:内)?(?:的)?资讯(?:正文)?(?:包含|出现)[“"「](.+?)[”"」]', prompt.strip())
        if match and 1 <= int(match[1]) <= 3650:
            literal_news_request = True
            candidate = {"conditions": [{"key": "c1", "name": f"资讯包含“{match[2]}”", "library": "news", "source_quote": prompt,
                "expression": {"op": "evidence_query", "terms": [match[2]], "lookback_calendar_days": int(match[1]), "source": "tushare", "scope": "same_document_page"}}],
                "tree": {"op": "condition", "key": "c1"}, "issues": [], "assumptions": ["仅定义原文关键词命中；资讯源接入前无法执行，也不等同于语义事实已核实。"]}
    source, model = "local_parser", None
    if candidate is None:
        config = llm_settings()
        if config["configured"]:
            source, model = "configured_llm", config["model"]
            try:
                context = {
                    "technical": "当前在技术指标库，只生成 technical 条件。若请求包含其他类别，不得忽略，应在 issues 中说明应到相应资料库建立条件再组合。",
                    "report": "当前在研报库，用户已明确选择以研报为依据，即使未在原句重复写研报，也应按 report rubric 整理研究目标。只生成判断口径，不声称已找到证据；其他数据类要求用 issues 说明。",
                    "news": "当前在资讯库，允许定义未来接入数据后执行的 news 原文关键词条件。仅当用户明确要求文本包含某些词时使用 evidence_query + terms + lookback_calendar_days + source=tushare；每项关键词组合都要保留。资讯源尚未接入不妨碍保存明确的定义，但必须在 assumptions 说明当前无法执行。复杂事件语义、数值抽取或关系推断暂不支持，不能把它们降级成关键词，必须给出 issues。只生成 news 条件。",
                }.get(library_context, "")
                candidate = complete_json(SYSTEM_PROMPT + "\n" + context, prompt, timeout_seconds=45, max_output_tokens=5000)
            except ModelRequestError as exc:
                return {"conditions": [], "tree": None, "issues": [{"kind": "clarification", "text": "本次模型解析没有完成，原描述已保留。", "suggestion": str(exc)}], "assumptions": [], "status": "service_error", "source": source, "model": model, "compiler_version": COMPILER_VERSION}
        else:
            candidate = {"conditions": [], "tree": None, "issues": [{"kind": "clarification", "text": "当前本地解析器无法完整理解这段描述。", "suggestion": "可明确写出周期、比较方式和阈值，例如：收盘价高于20日均线，且近5个交易日涨幅大于3%。自由描述需要在系统设置中配置文本模型。"}], "assumptions": []}
    try:
        plan = validate_plan(candidate, prompt)
    except (ValidationError, ValueError, TypeError, KeyError, RecursionError):
        plan = {"conditions": [], "tree": None, "issues": [{"kind": "clarification", "text": "解析结果未通过完整性检查，没有生成可保存的条件。", "suggestion": "请用明确的周期、指标、比较方式重新描述，或重试。"}], "assumptions": []}
    # Independently guard absent data domains even if a model omits its own issue.
    if library_context and any(item["library"] != library_context for item in plan["conditions"]):
        plan["issues"].append({"kind": "unsupported", "text": "描述包含其他资料库的条件，尚未完整归入当前库。", "suggestion": "请在对应资料库分别创建条件，再到组合选股中组合。"})
    actual_only = re.search(r"实际|已实现|已发生", prompt) and re.search(r"区分|不能|不把|不要|不作为", prompt) and re.search(r"预测|预期|未来", prompt)
    if actual_only and any(item["library"] == "report" and any(re.search(r"预测|预期|未来", criterion["label"]) and not re.search(r"已实现|实际|区分|剔除|排除", criterion["label"]) for criterion in item["expression"].get("criteria", [])) for item in plan["conditions"]):
        plan["issues"].append({"kind": "clarification", "text": "实际业绩与未来预测不能用“任一满足”互相替代，当前草稿需要重新整理。", "suggestion": "可明确写：只按已实现的增长判断，预测本身不能作为命中依据。"})
    if not plan["issues"] and not literal_news_request:
        constrained_prompt = re.sub(r"(?:不考虑|不限制|不限|不看)(?:市值|市盈率|市净率|换手率)", "", prompt)
        absent = re.search(r"市值|市盈率|市净率|(?i:\bPE\b|\bPB\b|(?<![a-z])ST(?![a-z]))|北向资金|主力资金|换手率", constrained_prompt)
        if absent and not ((library_context == "report" or re.search(r"研报|报告", prompt)) and all(item["library"] == "report" for item in plan["conditions"])):
            plan["issues"].append({"kind": "unsupported", "text": f"“{absent[0]}”所需数据尚未接入，不能省略这项要求。", "suggestion": "接入并核实对应数据后才能纳入筛选；也可以修改描述，仅保留现有数据能判断的要求。"})
        def contains_op(node, wanted):
            return isinstance(node, dict) and (node.get("op") == wanted or any(contains_op(value, wanted) for value in node.values() if isinstance(value, (dict, list)))) or isinstance(node, list) and any(contains_op(value, wanted) for value in node)
        def has_formula_op(wanted):
            return any(item["library"] == "technical" and item["expression"].get("op") == "timeseries_filter" and contains_op(item["expression"].get("formula"), wanted) for item in plan["conditions"])
        has_generated_program = any(item["library"] == "technical" and item["expression"].get("op") == "generated_timeseries_filter" for item in plan["conditions"])
        has_consecutive = any(item["library"] == "technical" and item["expression"].get("consecutive_days") for item in plan["conditions"]) or has_formula_op("consecutive") or has_generated_program
        event_checks = (
            (re.search(r"连续", prompt) and not has_consecutive, "连续逐日条件", "请说明连续交易日数和每日比较口径。"),
            (re.search(r"曾经|出现过|发生过", prompt) and not (has_formula_op("within") or has_generated_program), "近期曾满足条件", "请确认回看交易日数，近期事件可用时间窗口表达。"),
            (re.search(r"至少\s*\d+\s*次", prompt) and not (has_formula_op("count_true") or has_generated_program), "窗口内发生次数", "请确认统计窗口和最少次数。"),
            (re.search(r"刚(?:刚)?(?:站上|突破|上穿|下穿)|突破", prompt) and not (has_formula_op("cross") or has_generated_program), "突破或穿越事件", "请说明要穿越的指标、价位或区间边界。"),
        )
        if library_context != "report" and not re.search(r"研报|报告", prompt):
            for missing, label, suggestion in event_checks:
                if missing:
                    plan["issues"].append({"kind": "unsupported", "text": f"{label}尚未形成可执行公式，不能近似成普通比较。", "suggestion": suggestion})
    return {**plan, "status": "ready" if plan["conditions"] and not plan["issues"] else "needs_clarification", "source": source, "model": model, "compiler_version": COMPILER_VERSION}
