from __future__ import annotations

import re
import math
from copy import deepcopy
from collections.abc import Sequence
from typing import Any

from .indicators import compare, values


INDICATOR_FIELDS = {
    "sma": {"close", "volume"}, "ema": {"close"}, "rsi": {"close"}, "bollinger": {"close"},
    "macd_dif": {"close"}, "macd_dea": {"close"}, "macd_hist": {"close"},
    "kdj_k": {"close"}, "kdj_d": {"close"}, "kdj_j": {"close"}, "atr": {"close"},
}
COMPARATORS = {"gt", "gte", "lt", "lte", "eq"}
LOGIC_OPS = {"all", "any", "not"}


class RuleError(ValueError):
    pass


def _finite_condition_number(value: Any) -> bool:
    if type(value) not in (int, float):
        return False
    if type(value) is int:
        return abs(value) <= 10**100
    return math.isfinite(value) and abs(value) <= 1e100


def validate_filter(library: str, expression: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(expression, dict):
        return ["条件表达式必须是对象"]
    if library not in {"technical", "news", "report"}:
        return ["条件库类型无效"]
    op = expression.get("op")
    if not isinstance(op, str):
        return ["条件操作类型必须是字符串"]
    if library == "technical":
        allowed = {
            "indicator_compare": {"op", "indicator", "field", "window", "operator", "value", "compare_field"},
            "ma_cross": {"op", "fast_window", "slow_window", "direction"},
            "metric_compare": {"op", "metric", "window", "operator", "value", "consecutive_days"},
            "timeseries_filter": {"op", "formula", "summary"},
            "generated_timeseries_filter": {"op", "code", "summary", "required_fields", "parameters", "parameter_specs"},
        }
        if op in allowed and set(expression) - allowed[op]:
            errors.append("条件包含未支持的字段，不能忽略执行")
        if op == "timeseries_filter":
            try:
                from .time_series import FormulaError, inspect, minimum_history
                inspect(expression.get("formula"))
                if minimum_history(expression["formula"]) > 500:
                    errors.append("公式预热历史超过单只证券最多支持的500根日线")
            except (ValueError, TypeError, KeyError, ZeroDivisionError) as exc:
                errors.append(str(exc) or "时序公式格式无效")
            summary = expression.get("summary")
            if summary is not None and (not isinstance(summary, str) or not summary.strip() or len(summary) > 300):
                errors.append("公式摘要必须是不超过300字的中文说明")
        elif op == "generated_timeseries_filter":
            try:
                from .generated_program import validate_program
                code = expression.get("code")
                validate_program(code)
            except (ValueError, TypeError) as exc:
                errors.append(str(exc) or "LLM 计算程序格式无效")
            summary = expression.get("summary")
            if not isinstance(summary, str) or not summary.strip() or len(summary) > 300:
                errors.append("生成公式需要不超过300字的中文条件摘要")
            fields = expression.get("required_fields", [])
            allowed_fields = {"open", "high", "low", "close", "volume", "amount"}
            if not isinstance(fields, list) or len(fields) > len(allowed_fields) or any(not isinstance(field, str) or field not in allowed_fields for field in fields) or len(set(fields)) != len(fields):
                errors.append("公式所需行情字段必须来自输入合同且不能重复")
            elif isinstance(code, str):
                referenced = set(re.findall(r"['\"](open|high|low|close|volume|amount)['\"]", code))
                if not referenced <= set(fields):
                    errors.append("公式读取的行情字段必须完整声明在 required_fields 中")
            parameters = expression.get("parameters")
            specs = expression.get("parameter_specs")
            if not isinstance(parameters, dict) or not isinstance(specs, dict) or set(parameters) != set(specs) or len(parameters) > 20:
                errors.append("公式参数默认值与参数说明必须一一对应，最多20项")
            else:
                for key, spec in specs.items():
                    if not isinstance(key, str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,39}", key) or not isinstance(spec, dict) or set(spec) - {"label", "type", "min", "max"}:
                        errors.append("公式参数说明格式无效")
                        continue
                    if not isinstance(spec.get("label"), str) or not spec["label"].strip() or len(spec["label"]) > 80 or spec.get("type") not in {"number", "integer"}:
                        errors.append(f"公式参数 {key} 缺少有效名称或类型")
                        continue
                    default, minimum, maximum = parameters[key], spec.get("min"), spec.get("max")
                    if not _finite_condition_number(default) or (spec["type"] == "integer" and type(default) is not int):
                        errors.append(f"公式参数 {key} 的默认值类型无效")
                    valid_bounds = True
                    for bound in (minimum, maximum):
                        if bound is not None and not _finite_condition_number(bound):
                            errors.append(f"公式参数 {key} 的取值范围无效")
                            valid_bounds = False
                            break
                    if valid_bounds and minimum is not None and maximum is not None and minimum > maximum:
                        errors.append(f"公式参数 {key} 的最小值不能大于最大值")
                    if valid_bounds and type(default) in (int, float) and ((minimum is not None and default < minimum) or (maximum is not None and default > maximum)):
                        errors.append(f"公式参数 {key} 的默认值超出范围")
                if isinstance(code, str):
                    referenced_parameters = set(re.findall(r"""params\s*\[\s*['"]([A-Za-z][A-Za-z0-9_]{0,39})['"]\s*\]""", code))
                    if not referenced_parameters <= set(parameters):
                        errors.append("公式代码读取了未声明的参数")
        elif op == "indicator_compare":
            indicator = expression.get("indicator")
            if not isinstance(indicator, str):
                return ["指标名称必须是字符串"]
            if indicator not in INDICATOR_FIELDS:
                errors.append("指标不在允许列表中")
            field = expression.get("field", "close")
            if not isinstance(field, str):
                return ["行情字段必须是字符串"]
            if indicator in INDICATOR_FIELDS and field not in INDICATOR_FIELDS[indicator]:
                errors.append("该指标不支持此行情字段")
            window = expression.get("window")
            if not isinstance(window, int) or isinstance(window, bool) or not 2 <= window <= 250:
                errors.append("指标窗口必须是 2 到 250 的整数")
            elif indicator in {"macd_dif", "macd_dea", "macd_hist"} and window != 9:
                errors.append("MACD 的 signal 窗口固定为 9；DIF 使用 EMA12/EMA26")
            elif indicator in {"kdj_k", "kdj_d", "kdj_j", "atr"} and window > 100:
                errors.append("KDJ/ATR 窗口必须是 2 到 100 之间的整数")
            if not isinstance(expression.get("operator"), str) or expression["operator"] not in COMPARATORS:
                errors.append("比较方式无效")
            if ("value" in expression) == ("compare_field" in expression):
                errors.append("请提供一个数值阈值或一个行情字段")
            if "compare_field" in expression and (not isinstance(expression["compare_field"], str) or expression["compare_field"] not in {"open", "high", "low", "close", "volume", "amount"}):
                errors.append("比较字段不在允许列表中")
            if "value" in expression and (not isinstance(expression["value"], (int, float)) or isinstance(expression["value"], bool) or not math.isfinite(expression["value"])):
                errors.append("比较阈值必须是有限数值")
        elif op == "ma_cross":
            fast, slow = expression.get("fast_window"), expression.get("slow_window")
            if not all(isinstance(value, int) and not isinstance(value, bool) and 2 <= value <= 250 for value in (fast, slow)):
                errors.append("均线窗口必须是 2 到 250 的整数")
            elif fast >= slow:
                errors.append("短期均线窗口必须小于长期均线窗口")
            if expression.get("direction", "up") not in ("up", "down"):
                errors.append("均线穿越方向必须是 up 或 down")
        elif op == "metric_compare":
            metric = expression.get("metric")
            if metric not in ("return_pct", "volume_ratio", "close"):
                errors.append("只支持区间涨幅、日成交量倍数或收盘价")
            window = expression.get("window")
            if type(window) is not int or not 1 <= window <= 250:
                errors.append("观察周期必须为 1 到 250 个交易日")
            elif metric == "close" and window != 1:
                errors.append("收盘价使用当日值，周期必须为 1")
            if expression.get("operator") not in tuple(COMPARATORS):
                errors.append("比较方式无效")
            value = expression.get("value")
            if type(value) not in (int, float) or not math.isfinite(value):
                errors.append("比较阈值必须是有限数值")
            elif metric in ("volume_ratio", "close") and value < 0:
                errors.append("成交量倍数和价格阈值不能为负")
            consecutive = expression.get("consecutive_days")
            if consecutive is not None and (metric not in ("return_pct", "volume_ratio") or type(consecutive) is not int or not 1 <= consecutive <= 20):
                errors.append("连续周期仅支持区间涨幅或成交量倍数，且须为1到20个交易日")
        else:
            errors.append("技术条件只支持指标比较、均线穿越或行情数值比较")
    elif library in {"news", "report"}:
        if op != "evidence_query":
            errors.append("资讯和研报条件必须使用 evidence_query")
        lookback = expression.get("lookback_calendar_days", 30)
        if not isinstance(lookback, int) or not 1 <= lookback <= 3650:
            errors.append("回溯范围必须为 1 到 3650 天")
        if library == "report" and expression.get("evaluation_mode") == "rubric":
            allowed_fields = {"op", "evaluation_mode", "criteria", "combine", "lookback_calendar_days", "evidence_policy"}
            unexpected = set(expression) - allowed_fields
            if unexpected:
                errors.append(f"研报口径包含未支持字段：{', '.join(sorted(unexpected))}")
            criteria = expression.get("criteria")
            if not isinstance(criteria, list) or not 1 <= len(criteria) <= 8:
                errors.append("研报判断口径需要 1 到 8 项可评估标准")
            else:
                ids: set[str] = set()
                for index, criterion in enumerate(criteria, start=1):
                    if not isinstance(criterion, dict):
                        errors.append(f"第 {index} 项判断标准格式无效")
                        continue
                    allowed_criterion_fields = {"id", "label", "question", "signals", "counter_signals"}
                    unexpected_criterion_fields = set(criterion) - allowed_criterion_fields
                    if unexpected_criterion_fields:
                        errors.append(f"第 {index} 项判断标准包含未支持字段")
                    criterion_id = criterion.get("id")
                    if not isinstance(criterion_id, str) or not re.fullmatch(r"[a-z][a-z0-9_]{1,63}", criterion_id):
                        errors.append(f"第 {index} 项需要稳定的英文 ID")
                    elif criterion_id in ids:
                        errors.append(f"判断标准 ID 重复：{criterion_id}")
                    else:
                        ids.add(criterion_id)
                    for field, maximum in (("label", 100), ("question", 1200)):
                        value = criterion.get(field)
                        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
                            errors.append(f"第 {index} 项的 {field} 不能为空且不能超过 {maximum} 字")
                    for field in ("signals", "counter_signals"):
                        values = criterion.get(field, [])
                        if not isinstance(values, list) or len(values) > 12 or any(not isinstance(value, str) or not value.strip() or len(value) > 240 for value in values):
                            errors.append(f"第 {index} 项的 {field} 最多 12 条，每条不超过 240 字")
            if expression.get("combine") not in {"all", "any"}:
                errors.append("判断口径组合方式必须是 all 或 any")
        else:
            terms = expression.get("terms")
            if not isinstance(terms, list) or not terms or any(not isinstance(term, str) or not term.strip() for term in terms):
                errors.append("至少填写一个文本检索词")
            if isinstance(terms, list) and len(terms) > 12:
                errors.append("检索词最多 12 个")
            if library == "news" and expression.get("source") not in {None, "tushare"}:
                errors.append("未知资讯来源")
    return errors


def filter_parameters(library: str, expression: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Parameters that can be changed on one strategy reference without editing its asset."""
    if library != "technical":
        return {}
    if expression.get("op") == "timeseries_filter":
        from .time_series import parameters
        return parameters(expression["formula"])
    if expression.get("op") == "generated_timeseries_filter":
        return {f"parameters.{name}": spec for name, spec in expression.get("parameter_specs", {}).items()}
    if expression.get("op") == "metric_compare":
        params = {"value": {"label": "涨幅阈值（%）" if expression.get("metric") == "return_pct" else "比较阈值", "type": "number"}}
        if expression.get("metric") != "close":
            params["window"] = {"label": "交易日数", "type": "integer", "min": 1, "max": 250}
        if expression.get("consecutive_days") is not None:
            params["consecutive_days"] = {"label": "连续交易日数", "type": "integer", "min": 1, "max": 20}
        return params
    if expression.get("op") == "ma_cross":
        return {
            "fast_window": {"label": "短均线周期", "type": "integer", "min": 2, "max": 250},
            "slow_window": {"label": "长均线周期", "type": "integer", "min": 2, "max": 250},
            "direction": {"label": "穿越方向", "type": "enum", "options": {"up": "上穿", "down": "下穿"}},
        }
    if expression.get("op") == "indicator_compare":
        indicator = expression.get("indicator", "")
        params: dict[str, dict[str, Any]] = {}
        if not indicator.startswith("macd_"):
            params["window"] = {"label": "指标周期", "type": "integer", "min": 2, "max": 100 if indicator.startswith("kdj_") or indicator == "atr" else 250}
        if "value" in expression:
            params["value"] = {"label": "比较阈值", "type": "number"}
        return params
    return {}


def resolve_filter_expression(library: str, expression: dict[str, Any], overrides: Any = None) -> dict[str, Any]:
    overrides = {} if overrides is None else overrides
    if not isinstance(overrides, dict):
        raise RuleError("条件参数覆写必须是对象")
    allowed = filter_parameters(library, expression)
    if set(overrides) - set(allowed):
        raise RuleError("包含不允许覆写的条件参数；资讯和研报口径须另存条件版本")
    if library == "technical" and expression.get("op") == "timeseries_filter":
        from .time_series import apply_parameters
        result = apply_parameters(expression, overrides)
        errors = validate_filter(library, result)
        if errors:
            raise RuleError("；".join(errors))
        return result
    if library == "technical" and expression.get("op") == "generated_timeseries_filter":
        result = deepcopy(expression)
        for path, value in overrides.items():
            parts = path.split(".")
            if len(parts) != 2 or parts[0] != "parameters" or parts[1] not in result.get("parameters", {}) or not _finite_condition_number(value):
                raise RuleError("生成公式只允许修改已声明的有限数值参数")
            result["parameters"][parts[1]] = value
        errors = validate_filter(library, result)
        if errors:
            raise RuleError("；".join(errors))
        return result
    result = {**expression, **overrides}
    errors = validate_filter(library, result)
    if errors:
        raise RuleError("；".join(errors))
    return result


def local_draft(library: str, prompt: str) -> tuple[str, dict[str, Any], str]:
    if library == "technical":
        macd = re.search(r"MACD\s*(?:柱|hist(?:ogram)?)?.*?(>|大于|超过|低于|<)\s*(-?\d+(?:\.\d+)?)", prompt, re.I)
        if macd:
            operator = "gt" if macd.group(1) in {">", "大于", "超过"} else "lt"
            expression = {"op": "indicator_compare", "indicator": "macd_hist", "field": "close", "window": 9, "operator": operator, "value": float(macd.group(2))}
            return "MACD 柱值条件", expression, "MACD 柱值为 2×(DIF−DEA)，固定 EMA12/EMA26/signal9。"
        kdj = re.search(r"KDJ\s*([KDJ])?.*?(>|大于|超过|低于|<)\s*(-?\d+(?:\.\d+)?)", prompt, re.I)
        if kdj:
            component = (kdj.group(1) or "j").lower()
            operator = "gt" if kdj.group(2) in {">", "大于", "超过"} else "lt"
            expression = {"op": "indicator_compare", "indicator": f"kdj_{component}", "field": "close", "window": 9, "operator": operator, "value": float(kdj.group(3))}
            return f"KDJ {component.upper()} 条件", expression, "KDJ 窗口默认 9，K/D 的递推初值为 50。"
        cross = re.search(r"(?:MA|均线)\s*(\d+)\s*(?:日)?\s*(上穿|突破|下穿|跌破|cross(?:es)?\s*(?:above|below))\s*(?:MA|均线)?\s*(\d+)", prompt, re.I)
        if cross:
            direction = "down" if re.search(r"下穿|跌破|below", cross.group(2), re.I) else "up"
            expression = {"op": "ma_cross", "fast_window": int(cross.group(1)), "slow_window": int(cross.group(3)), "direction": direction}
            return "均线向下穿越" if direction == "down" else "均线向上穿越", expression, "本地规则解析：比较两个简单移动平均值；请确认周期和穿越方向。"
        rsi = re.search(r"RSI\s*(\d+)?.*?(>|大于|超过|低于|<)\s*(\d+(?:\.\d+)?)", prompt, re.I)
        if rsi:
            operator = "gt" if rsi.group(2) in {">", "大于", "超过"} else "lt"
            expression = {"op": "indicator_compare", "indicator": "rsi", "field": "close", "window": int(rsi.group(1) or 14), "operator": operator, "value": float(rsi.group(3))}
            return "RSI 条件", expression, "本地规则解析：按 Wilder RSI 初始化规则计算；请核对阈值和周期。"
        ma = re.search(r"(?:收盘价|股价|close).*?(?:在|高于|站上|低于|跌破)\s*(\d+)\s*(?:日)?\s*(?:均线|MA)", prompt, re.I)
        if ma:
            operator = "gt" if re.search(r"低于|跌破", prompt) else "lt"
            expression = {"op": "indicator_compare", "indicator": "sma", "field": "close", "window": int(ma.group(1)), "operator": operator, "compare_field": "close"}
            return f"收盘价与 {ma.group(1)} 日均线", expression, "本地规则解析：规则会逐证券按有效日线计算。"
        return "技术指标条件", {"op": "indicator_compare", "indicator": "sma", "field": "close", "window": 20, "operator": "gt", "compare_field": "close"}, "未能可靠解析原句，已提供可编辑示例；请检查规则后再保存。"
    days = re.search(r"(\d+)\s*(?:个)?\s*(交易日|自然日|天)", prompt)
    lookback = int(days.group(1)) if days else 365
    lookback = max(1, min(3650, lookback))
    if library == "report":
        criteria = []
        if re.search(r"基本面|财务|经营|盈利|fundamental", prompt, re.I):
            criteria.append({
                "id": "fundamental_improvement", "label": "公司基本面改善",
                "question": "研报是否提供近期公司经营或财务实际改善的证据，例如收入、利润或毛利率改善，订单增长、客户验证进展、现金流改善或产能利用率提升？请区分实际数据、公司表述、预测和分析师观点，不要求每个维度都出现。",
                "signals": ["实际收入、利润、毛利率或现金流改善", "订单、客户导入或产能利用率等经营进展", "相较明确历史期间的改善"],
                "counter_signals": ["明确披露经营指标恶化", "订单、利润或现金流显著下降"],
            })
        if re.search(r"行业|景气|需求|价格|industry|cycle", prompt, re.I):
            criteria.append({
                "id": "industry_improvement", "label": "所属行业景气度提升",
                "question": "研报是否提供行业需求、订单、价格、库存、产能利用率或供需变化改善的证据？区分已发生事实、公司/机构观点和预测，并检查证据对应的期间。",
                "signals": ["行业需求或订单改善", "产品价格、库存或供需格局改善", "行业产能利用率或客户需求提升"],
                "counter_signals": ["明确披露行业需求走弱", "价格下跌、库存上升或产能利用率下降"],
            })
        if not criteria:
            criteria.append({
                "id": "research_goal", "label": "用户研究目标",
                "question": f"判断研报是否提供与以下研究目标相关、可定位到原文的支持证据：{prompt[:800]}。识别目标涉及的公司、事件或行业，区分事实、观点、预测与反向证据；信息不足时返回 unknown。",
                "signals": ["与用户目标直接相关的公司或行业证据"],
                "counter_signals": ["与用户目标直接相关的反向证据"],
            })
        expression = {
            "op": "evidence_query", "evaluation_mode": "rubric", "criteria": criteria,
            "combine": "all", "lookback_calendar_days": lookback,
            "evidence_policy": "每项判断须引用原文；事实、公司表述、分析师观点和预测分开标记；无证据为 unknown。",
        }
        return "研报综合判断口径", expression, "本地通用判断模板：用于展示和编辑口径，尚未由文本模型按本次请求解析；证据评估需配置模型。"
    terms = [part.strip() for part in re.split(r"[，,。；;\s]+", prompt) if len(part.strip()) >= 2][:8]
    expression = {"op": "evidence_query", "terms": terms or [prompt[:80]], "lookback_calendar_days": lookback, "scope": "same_document_page"}
    return "资讯条件", expression, "仅把原句转换为可编辑关键词草稿；新版对话执行会读取已同步到本地资讯库的原文。"


def evaluate_filter(expression: dict[str, Any], bars: Sequence[dict[str, Any]]) -> dict[str, Any]:
    op = expression.get("op")
    if op == "generated_timeseries_filter":
        from .generated_program import ProgramError, execute_program
        source = expression["code"]
        selected_bars = list(bars[-500:])
        required_fields = expression.get("required_fields", [])
        try:
            states, metrics, code_hash, _ = execute_program(source, selected_bars, expression.get("parameters", {}), required_fields)
        except ProgramError as exc:
            return {"state": "unknown", "reason": f"生成公式无法完成安全计算：{exc}", "summary": expression.get("summary"), "effective_expression": expression}
        index = len(selected_bars) - 1
        state = states[index] if index >= 0 else "unknown"
        recent_start = max(0, index - 19)
        daily_values = [{"date": selected_bars[position].get("trade_date"), "state": states[position], "metrics": {name: values[position] for name, values in metrics.items()}} for position in range(recent_start, index + 1)]
        latest_metrics = {name: values[index] for name, values in metrics.items()} if index >= 0 else {}
        from .condition_contract import describe_filter
        summary = describe_filter("technical", expression)["summary"]
        return {
            "state": state, "actual": state, "summary": summary, "effective_expression": expression,
            "program_trace": {"code_hash": code_hash, "metrics": latest_metrics, "daily_values": daily_values},
            "start_date": selected_bars[0].get("trade_date") if selected_bars else None,
            "end_date": selected_bars[-1].get("trade_date") if selected_bars else None,
            "reason": "预热历史不足、公式结果未定义或所需行情缺失" if state == "unknown" else None,
        }
    if op == "timeseries_filter":
        from .time_series import calculate, trace
        formula = expression["formula"]
        states, cache = calculate(formula, bars)
        index = len(bars) - 1
        raw_state = states[index] if index >= 0 else "unknown"
        state = raw_state if raw_state in {"true", "false", "unknown"} else "unknown"
        formula_trace = trace(formula, cache, index, bars) if index >= 0 else None
        if formula_trace and expression.get("summary"):
            formula_trace["label"] = expression["summary"]
        unknown_days = [item["date"] for item in (formula_trace or {}).get("daily_values", []) if item["state"] == "unknown"]
        from .condition_contract import describe_filter
        summary = describe_filter("technical", expression)["summary"]
        return {"state": state, "actual": formula_trace["value"] if formula_trace else None,
                "summary": summary, "formula_trace": formula_trace, "effective_expression": expression,
                "start_date": unknown_days[0] if unknown_days else (bars[-1].get("trade_date") if bars else None),
                "end_date": bars[-1].get("trade_date") if bars else None,
                "reason": "公式预热历史不足或行情存在缺口" if state == "unknown" else None}
    if op == "metric_compare":
        metric, window = expression["metric"], expression["window"]
        consecutive = expression.get("consecutive_days")
        required = 1 if metric == "close" else window + (consecutive if consecutive is not None else 1)
        if len(bars) < required:
            return {"state": "unknown", "reason": f"需要 {required} 根日线，当前只有 {len(bars)} 根"}
        span = bars[-required:]
        field = "volume" if metric == "volume_ratio" else "close"
        raw = [bar.get(field) for bar in span]
        if consecutive is not None:
            daily_values = []
            for target_index in range(window, len(span)):
                target_bar = span[target_index]
                baseline_bars = span[target_index - window:target_index]
                readings = [target_bar.get(field), *(bar.get(field) for bar in baseline_bars)]
                if any(not bar.get("quality_valid", True) for bar in [target_bar, *baseline_bars]) or any(type(value) not in (int, float) or not math.isfinite(value) or value < 0 or (field == "close" and value == 0) for value in readings):
                    daily_values.append({"date": target_bar.get("trade_date"), "state": "unknown", "reason": "该交易日行情缺失或异常"})
                    continue
                baseline = sum(readings[1:]) / window if metric == "volume_ratio" else readings[1]
                if baseline == 0:
                    daily_values.append({"date": target_bar.get("trade_date"), "state": "unknown", "reason": "比较基数为零，无法计算"})
                    continue
                actual = readings[0] / baseline if metric == "volume_ratio" else (readings[0] / baseline - 1) * 100
                daily_values.append({"date": target_bar.get("trade_date"), "state": compare(actual, expression["operator"], expression["value"]), "actual": actual, "baseline": baseline})
            states = [item["state"] for item in daily_values]
            state = "false" if "false" in states else ("true" if states and all(item == "true" for item in states) else "unknown")
            latest = daily_values[-1]
            return {"state": state, "actual": latest.get("actual"), "threshold": expression["value"], "operator": expression["operator"],
                    "metric": metric, "window": window, "consecutive_days": consecutive, "baseline": latest.get("baseline"),
                    "latest_value": raw[-1], "start_date": daily_values[0]["date"], "end_date": latest["date"], "unit": "%" if metric == "return_pct" else "倍",
                    "daily_values": daily_values, "reason": None if state != "unknown" else "连续观察期间至少有一个交易日数据不足"}
        if any(not bar.get("quality_valid", True) for bar in span) or any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 or (field == "close" and v == 0) for v in raw):
            return {"state": "unknown", "reason": "观察窗口内行情缺失或异常"}
        baseline = raw[0] if metric == "return_pct" else (sum(raw[:-1]) / window if metric == "volume_ratio" else None)
        if baseline == 0:
            return {"state": "unknown", "reason": "基期成交量为零，无法计算倍数"}
        actual = (raw[-1] / baseline - 1) * 100 if metric == "return_pct" else (raw[-1] / baseline if metric == "volume_ratio" else raw[-1])
        return {"state": compare(actual, expression["operator"], expression["value"]), "actual": actual,
                "threshold": expression["value"], "operator": expression["operator"], "metric": metric,
                "window": window, "baseline": baseline, "latest_value": raw[-1],
                "start_date": span[0].get("trade_date"), "end_date": span[-1].get("trade_date"),
                "unit": "%" if metric == "return_pct" else ("倍" if metric == "volume_ratio" else "元")}
    if op == "indicator_compare":
        if not bars:
            return {"state": "unknown", "reason": "没有可用行情"}
        indicator = expression["indicator"]
        field = expression.get("field", "close")
        window = expression["window"]
        series = values(bars, indicator, window, field)
        actual = series[-1] if series else None
        target = expression.get("value")
        if "compare_field" in expression:
            target = bars[-1].get(expression["compare_field"])
        state = compare(actual, expression["operator"], target)
        return {
            "state": state,
            "actual": actual,
            "operator": expression["operator"],
            "threshold": target,
            "indicator": indicator,
            "window": window,
            "reason": None if state != "unknown" else "历史不足、行情异常或指标值缺失",
        }
    if op == "ma_cross":
        fast = values(bars, "sma", expression["fast_window"])
        slow = values(bars, "sma", expression["slow_window"])
        if len(fast) < 2 or len(slow) < 2 or any(value is None for value in (fast[-1], fast[-2], slow[-1], slow[-2])):
            return {"state": "unknown", "reason": "均线预热历史不足"}
        hit = (fast[-1] < slow[-1] and fast[-2] >= slow[-2]) if expression.get("direction", "up") == "down" else (fast[-1] > slow[-1] and fast[-2] <= slow[-2])
        return {"state": "true" if hit else "false", "actual": {"fast": fast[-1], "slow": slow[-1]}, "previous": {"fast": fast[-2], "slow": slow[-2]}, "reason": None}
    if op == "evidence_query":
        return {"state": "unknown", "reason": "需要可追溯文档证据服务"}
    return {"state": "unknown", "reason": "条件类型不支持执行"}


def combine(op: str, states: Sequence[str]) -> str:
    if op == "not":
        if len(states) != 1:
            raise RuleError("NOT 节点必须且只能包含一个子条件")
        return {"true": "false", "false": "true", "unknown": "unknown"}.get(states[0], "unknown")
    if op == "all":
        if "false" in states:
            return "false"
        return "true" if states and all(state == "true" for state in states) else "unknown"
    if op == "any":
        if "true" in states:
            return "true"
        return "false" if states and all(state == "false" for state in states) else "unknown"
    raise RuleError("组合节点必须是 all、any 或 not")


def validate_tree(
    tree: dict[str, Any],
    filters: dict[tuple[str, int], dict[str, Any]],
    patterns: set[tuple[str, int]] | None = None,
) -> list[str]:
    errors: list[str] = []
    count = 0

    def visit(node: Any, depth: int = 0) -> None:
        nonlocal count
        count += 1
        if count > 200 or depth > 16:
            errors.append("策略节点过多或嵌套过深")
            return
        if not isinstance(node, dict):
            errors.append("策略节点必须是对象")
            return
        op = node.get("op")
        if not isinstance(op, str):
            errors.append("策略节点操作类型必须是字符串")
            return
        if op == "filter_ref":
            if not isinstance(node.get("filter_id"), str) or type(node.get("version")) is not int:
                errors.append("条件引用必须包含有效 ID 和整数版本")
                return
            key = (node.get("filter_id"), node.get("version"))
            if key not in filters:
                errors.append(f"缺少固定版本的条件引用：{key[0]} v{key[1]}")
            elif "expression" in filters[key]:
                try:
                    resolve_filter_expression(filters[key]["library"], filters[key]["expression"], node.get("parameter_overrides"))
                except RuleError as exc:
                    errors.append(f"条件 {filters[key].get('name', key[0])}：{exc}")
            weight = node.get("score_weight", 1)
            if not isinstance(weight, (int, float)) or isinstance(weight, bool) or not math.isfinite(weight) or not 0 <= weight <= 100:
                errors.append("评分权重必须在 0 到 100 之间")
            return
        if op == "pattern_ref":
            if not isinstance(node.get("pattern_id"), str) or type(node.get("version")) is not int:
                errors.append("形态引用必须包含有效 ID 和整数版本")
                return
            key = (node.get("pattern_id"), node.get("version"))
            if key not in (patterns or set()):
                errors.append(f"缺少固定版本的形态引用：{key[0]} v{key[1]}")
            weight = node.get("score_weight", 1)
            if not isinstance(weight, (int, float)) or isinstance(weight, bool) or not math.isfinite(weight) or not 0 <= weight <= 100:
                errors.append("评分权重必须在 0 到 100 之间")
            threshold = node.get("min_similarity", 80)
            if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not math.isfinite(threshold) or not 0 <= threshold <= 100:
                errors.append("形态相似度阈值必须在 0 到 100 之间")
            match_mode = node.get("match_mode", "current")
            if match_mode not in {"current", "recent"}:
                errors.append("形态匹配模式只能为当前窗口或近期窗口")
            recent_bars = node.get("recent_bars", 20)
            if type(recent_bars) is not int or isinstance(recent_bars, bool) or not 1 <= recent_bars <= 120:
                errors.append("近期形态回看交易日数必须为1到120的整数")
            return
        if op not in LOGIC_OPS:
            errors.append(f"不支持的组合节点：{op}")
            return
        children = node.get("children", [])
        if not isinstance(children, list) or not children:
            errors.append("逻辑节点必须包含子条件")
            return
        if op == "not" and len(children) != 1:
            errors.append("NOT 节点必须只有一个子条件")
        for child in children:
            visit(child, depth + 1)

    visit(tree)
    return errors


def references(tree: dict[str, Any]) -> list[tuple[str, int]]:
    result: list[tuple[str, int]] = []

    def visit(node: Any, depth: int = 0) -> None:
        if not isinstance(node, dict) or depth > 16 or len(result) > 200:
            return
        if node.get("op") == "filter_ref" and isinstance(node.get("filter_id"), str) and type(node.get("version")) is int:
            result.append((node.get("filter_id"), node.get("version")))
        children = node.get("children", [])
        for child in children if isinstance(children, list) else []:
            visit(child, depth + 1)

    visit(tree)
    return result


def pattern_references(tree: dict[str, Any]) -> list[tuple[str, int]]:
    result: list[tuple[str, int]] = []

    def visit(node: Any, depth: int = 0) -> None:
        if not isinstance(node, dict) or depth > 16 or len(result) > 200:
            return
        if node.get("op") == "pattern_ref" and isinstance(node.get("pattern_id"), str) and type(node.get("version")) is int:
            result.append((node.get("pattern_id"), node.get("version")))
        children = node.get("children", [])
        for child in children if isinstance(children, list) else []:
            visit(child, depth + 1)

    visit(tree)
    return result
