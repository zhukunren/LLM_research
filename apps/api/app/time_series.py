"""Closed time-series DSL. Inputs are data, never executable code."""
from __future__ import annotations

import json
import math
from collections import deque
from collections.abc import Sequence
from copy import deepcopy
from typing import Any

from .indicators import values as indicator_values

MAX_NODES, MAX_DEPTH, MAX_WINDOW, MAX_RUN = 32, 8, 250, 20
FIELDS = {"open", "high", "low", "close", "volume", "amount"}
INDICATORS = {"sma", "ema", "rsi", "bollinger", "macd_dif", "macd_dea", "macd_hist", "kdj_k", "kdj_d", "kdj_j", "atr"}
COMPARATORS = {"gt", "gte", "lt", "lte", "eq"}
SHAPES = {
    "field": {"op", "field"}, "constant": {"op", "value"}, "indicator": {"op", "name", "field", "window"},
    "return_pct": {"op", "window"}, "relative_volume": {"op", "window"}, "rolling": {"op", "method", "window", "input"},
    "lag": {"op", "period", "input"}, "binary": {"op", "operator", "left", "right"},
    "compare": {"op", "operator", "left", "right"}, "cross": {"op", "direction", "left", "right"},
    "logic": {"op", "operator", "children"}, "consecutive": {"op", "days", "input"},
    "within": {"op", "window", "input"}, "count_true": {"op", "window", "input"},
}


class FormulaError(ValueError):
    pass


def inspect(formula: Any) -> str:
    count = 0

    def visit(node, depth=0):
        nonlocal count
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH or not isinstance(node, dict) or not isinstance(node.get("op"), str):
            raise FormulaError("公式节点过多、嵌套过深或格式无效")
        op = node["op"]
        if op not in SHAPES or set(node) != SHAPES[op]:
            raise FormulaError(f"公式类型 {op!r} 未支持，或包含未识别字段")
        if op == "field":
            if node["field"] not in FIELDS:
                raise FormulaError("行情字段不在允许列表中")
            return "number"
        if op == "constant":
            value = node["value"]
            if type(value) not in (int, float) or not math.isfinite(value):
                raise FormulaError("公式常量必须是有限数值")
            return "number"
        if op == "indicator":
            name, field, window = node["name"], node["field"], node["window"]
            allowed = {"sma": {"close", "volume"}, "ema": {"close"}, "rsi": {"close"}, "bollinger": {"close"},
                       "macd_dif": {"close"}, "macd_dea": {"close"}, "macd_hist": {"close"}, "kdj_k": {"close"},
                       "kdj_d": {"close"}, "kdj_j": {"close"}, "atr": {"close"}}
            if name not in INDICATORS or field not in allowed.get(name, set()):
                raise FormulaError("指标名称或计算字段不在允许范围内")
            maximum = 100 if name in {"rsi", "kdj_k", "kdj_d", "kdj_j", "atr"} else MAX_WINDOW
            if type(window) is not int or not 2 <= window <= maximum or (name.startswith("macd_") and window != 9):
                raise FormulaError("指标周期超出允许范围")
            return "number"
        if op in {"return_pct", "relative_volume"}:
            if type(node["window"]) is not int or not 1 <= node["window"] <= MAX_WINDOW:
                raise FormulaError("观察周期必须为1到250个交易日")
            return "number"
        if op == "rolling":
            if node["method"] not in {"mean", "sum", "min", "max", "std"} or type(node["window"]) is not int or not 1 <= node["window"] <= MAX_WINDOW:
                raise FormulaError("滚动计算超出允许范围")
            if visit(node["input"], depth + 1) != "number":
                raise FormulaError("滚动窗口只接受数值时序")
            return "number"
        if op == "lag":
            if type(node["period"]) is not int or not 1 <= node["period"] <= MAX_WINDOW:
                raise FormulaError("历史偏移须为1到250个交易日")
            return visit(node["input"], depth + 1)
        if op == "binary":
            if node["operator"] not in {"add", "subtract", "multiply", "divide"} or any(visit(node[key], depth + 1) != "number" for key in ("left", "right")):
                raise FormulaError("数值公式只支持两个数值时序之间的加减乘除")
            return "number"
        if op in {"compare", "cross"}:
            if (op == "compare" and node["operator"] not in COMPARATORS) or (op == "cross" and node["direction"] not in {"up", "down"}):
                raise FormulaError("比较方式或穿越方向无效")
            if any(visit(node[key], depth + 1) != "number" for key in ("left", "right")):
                raise FormulaError("比较两边必须为数值时序")
            return "boolean"
        if op == "logic":
            children = node["children"]
            if node["operator"] not in {"all", "any", "not"} or not isinstance(children, list) or not 1 <= len(children) <= 12 or (node["operator"] == "not" and len(children) != 1):
                raise FormulaError("逻辑组合无效")
            if any(visit(child, depth + 1) != "boolean" for child in children):
                raise FormulaError("AND、OR和NOT只接受比较条件")
            return "boolean"
        days = node["days"] if op == "consecutive" else node["window"]
        maximum = MAX_RUN if op == "consecutive" else MAX_WINDOW
        if type(days) is not int or not 1 <= days <= maximum or visit(node["input"], depth + 1) != "boolean":
            raise FormulaError("时间逻辑只接受比较条件且周期不超过允许上限")
        return "number" if op == "count_true" else "boolean"

    result = visit(formula)
    if result != "boolean":
        raise FormulaError("最终公式必须能判断符合、不符合或数据不足")
    return result


def minimum_history(node: dict[str, Any]) -> int:
    op = node["op"]
    if op in {"field", "constant"}: return 1
    if op == "indicator": return 34 if node["name"].startswith("macd_") else node["window"] + (1 if node["name"] in {"rsi", "atr", "kdj_k", "kdj_d", "kdj_j"} else 0)
    if op in {"relative_volume", "return_pct"}: return node["window"] + 1
    if op == "rolling": return minimum_history(node["input"]) + node["window"] - 1
    if op == "lag": return minimum_history(node["input"]) + node["period"]
    if op == "binary": return max(minimum_history(node["left"]), minimum_history(node["right"]))
    if op == "compare" or op == "cross": return max(minimum_history(node["left"]), minimum_history(node["right"])) + int(op == "cross")
    if op == "logic": return max(minimum_history(child) for child in node["children"])
    return minimum_history(node["input"]) + ((node["days"] if op == "consecutive" else node["window"]) - 1)


def summary(node: dict[str, Any]) -> str:
    fields = {"open": "开盘价", "high": "最高价", "low": "最低价", "close": "收盘价", "volume": "成交量", "amount": "成交额"}
    indicators = {"sma": "均线", "ema": "指数均线", "rsi": "RSI", "bollinger": "布林上轨", "macd_dif": "MACD DIF", "macd_dea": "MACD DEA", "macd_hist": "MACD 柱", "kdj_k": "KDJ K", "kdj_d": "KDJ D", "kdj_j": "KDJ J", "atr": "ATR"}
    op = node["op"]
    if op == "field": return fields[node["field"]]
    if op == "constant": return f"{node['value']:g}"
    if op == "indicator": return f"{node['window']}日{indicators[node['name']]}"
    if op == "relative_volume": return f"当日成交量 / 前{node['window']}日均量"
    if op == "return_pct": return f"近{node['window']}日涨幅"
    if op == "rolling":
        method = {"mean": "均值", "sum": "合计", "min": "最低值", "max": "最高值", "std": "标准差"}[node["method"]]
        return f"最近{node['window']}个交易日{method}（{summary(node['input'])}）"
    if op == "lag": return f"{node['period']}个交易日前的{summary(node['input'])}"
    if op == "binary":
        symbol = {"add": "+", "subtract": "−", "multiply": "×", "divide": "÷"}[node["operator"]]
        return f"（{summary(node['left'])} {symbol} {summary(node['right'])}）"
    if op == "compare":
        comparator = {"gt": "大于", "gte": "不低于", "lt": "小于", "lte": "不高于", "eq": "等于"}[node["operator"]]
        return f"{summary(node['left'])}{comparator}{summary(node['right'])}"
    if op == "cross": return f"{summary(node['left'])}{'上穿' if node['direction']=='up' else '下穿'}{summary(node['right'])}"
    if op == "logic": return f"（{('，且' if node['operator']=='all' else '，或').join(summary(child) for child in node['children'])}）"
    if op == "consecutive": return f"连续{node['days']}个有行情交易日逐日满足（{summary(node['input'])}）"
    if op == "within": return f"最近{node['window']}个交易日内曾满足（{summary(node['input'])}）"
    return f"最近{node['window']}个交易日满足次数（{summary(node['input'])}）"


def parameters(formula: dict[str, Any]) -> dict[str, dict[str, Any]]:
    specs = {}
    def visit(node, path="formula"):
        op = node["op"]
        if op == "constant":
            specs[f"{path}.value"] = {"label": "数值阈值", "type": "number"}
        if op == "indicator":
            name = node["name"]
            if not name.startswith("macd_"):
                specs[f"{path}.window"] = {"label": f"{name.upper()} 计算周期", "type": "integer", "min": 2, "max": 100 if name in {"rsi", "kdj_k", "kdj_d", "kdj_j", "atr"} else MAX_WINDOW}
        if op in {"return_pct", "relative_volume"}:
            specs[f"{path}.window"] = {"label": "比较周期", "type": "integer", "min": 1, "max": MAX_WINDOW}
        if op == "rolling":
            specs[f"{path}.window"] = {"label": "滚动窗口", "type": "integer", "min": 1, "max": MAX_WINDOW}
        if op == "lag":
            specs[f"{path}.period"] = {"label": "历史偏移周期", "type": "integer", "min": 1, "max": MAX_WINDOW}
        if op in {"within", "count_true"}:
            specs[f"{path}.window"] = {"label": "回看交易日数", "type": "integer", "min": 1, "max": MAX_WINDOW}
        if op == "consecutive":
            specs[f"{path}.days"] = {"label": "连续交易日数", "type": "integer", "min": 1, "max": MAX_RUN}
        for field in ("left", "right", "input"):
            if isinstance(node.get(field), dict): visit(node[field], f"{path}.{field}")
        for index, child in enumerate(node.get("children", [])):
            visit(child, f"{path}.children.{index}")
    visit(formula)
    return specs


def apply_parameters(expression: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    formula = deepcopy(expression["formula"])
    allowed = parameters(formula)
    if set(overrides) - set(allowed):
        raise FormulaError("公式参数包含未公开的修改项")
    for key, value in overrides.items():
        parts = key.split(".")
        if len(parts) < 2 or parts[0] != "formula":
            raise FormulaError("公式参数路径无效")
        node = formula
        for part in parts[1:-1]:
            if isinstance(node, dict):
                node = node.get(part)
            elif isinstance(node, list) and part.isdigit() and int(part) < len(node):
                node = node[int(part)]
            else:
                node = None
        field = parts[-1]
        if not isinstance(node, dict) or field not in {"value", "window", "period", "days"} or type(value) not in (int, float) or not math.isfinite(value):
            raise FormulaError("公式修改参数必须是有限数值")
        node[field] = value
    result = {**expression, "formula": formula}
    errors = []
    try:
        inspect(formula)
        if minimum_history(formula) > 500:
            errors.append("公式预热历史超过单只证券最多支持的500根日线")
    except FormulaError as exc:
        errors.append(str(exc))
    if errors: raise FormulaError("；".join(errors))
    return result


def calculate(formula: dict[str, Any], bars: Sequence[dict]) -> tuple[list, dict[str, list]]:
    inspect(formula)
    cache: dict[str, list] = {}
    def evaluate(node: dict):
        key = json.dumps(node, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        if key in cache: return cache[key]
        op = node["op"]
        if op == "constant":
            output = [float(node["value"])] * len(bars)
        elif op == "field":
            output = []
            for bar in bars:
                value = bar.get(node["field"])
                if not bar.get("quality_valid", True) or type(value) not in (int, float) or not math.isfinite(value) or (node["field"] in {"open", "high", "low", "close"} and value <= 0) or (node["field"] in {"volume", "amount"} and value < 0): output.append(None)
                else: output.append(float(value))
        elif op == "indicator":
            needed_fields = {"high", "low", "close"} if node["name"].startswith(("kdj_", "atr")) else {node["field"]}
            safe_bars = []
            for bar in bars:
                valid = bar.get("quality_valid", True)
                for field in needed_fields:
                    value = bar.get(field)
                    valid = valid and type(value) in (int, float) and math.isfinite(value)
                    valid = valid and (value > 0 if field in {"open", "high", "low", "close"} else value >= 0)
                safe_bars.append({**bar, "quality_valid": bool(valid)})
            output = indicator_values(safe_bars, node["name"], node["window"], node["field"])
        elif op in {"return_pct", "relative_volume"}:
            field, window = ("close" if op == "return_pct" else "volume"), node["window"]
            series, output = evaluate({"op": "field", "field": field}), [None] * len(bars)
            for index in range(window, len(series)):
                prior, current = series[index-window], series[index]
                baseline = prior if op == "return_pct" else (sum(series[index-window:index]) / window if all(value is not None for value in series[index-window:index]) else None)
                if prior is not None and current is not None and baseline:
                    value = (current / baseline - 1) * 100 if op == "return_pct" else current / baseline
                    output[index] = value if math.isfinite(value) else None
        elif op == "rolling":
            output = _rolling(evaluate(node["input"]), node["window"], node["method"])
        elif op == "lag":
            series, period = evaluate(node["input"]), node["period"]
            output = [None] * min(period, len(series)) + series[:max(0, len(series)-period)]
        elif op == "binary":
            left, right, operation = evaluate(node["left"]), evaluate(node["right"]), node["operator"]
            output = []
            for a, b in zip(left, right):
                if a is None or b is None or (operation == "divide" and b == 0): output.append(None); continue
                value = {"add": lambda: a+b, "subtract": lambda: a-b, "multiply": lambda: a*b, "divide": lambda: a/b}[operation]()
                output.append(value if math.isfinite(value) else None)
        elif op == "compare":
            left, right = evaluate(node["left"]), evaluate(node["right"])
            output = [_compare(a,node["operator"],b) for a,b in zip(left,right)]
        elif op == "cross":
            left,right,direction=evaluate(node["left"]),evaluate(node["right"]),node["direction"]
            output=["unknown"]
            for i in range(1,len(bars)):
                a,b,pa,pb=left[i],right[i],left[i-1],right[i-1]
                if any(value is None or not math.isfinite(value) for value in (a, b, pa, pb)):
                    output.append("unknown")
                else:
                    hit=(pa<=pb and a>b) if direction=="up" else (pa>=pb and a<b)
                    output.append("true" if hit else "false")
        elif op == "logic":
            children=[evaluate(child) for child in node["children"]]; output=[]
            for i in range(len(bars)):
                states=[child[i] for child in children]
                result=({"true":"false","false":"true","unknown":"unknown"}[states[0]] if node["operator"]=="not" else ("false" if "false" in states else ("unknown" if "unknown" in states else "true")) if node["operator"]=="all" else ("true" if "true" in states else ("unknown" if "unknown" in states else "false")))
                output.append(result)
        else:
            source,window=evaluate(node["input"]),node["days"] if op=="consecutive" else node["window"]
            output=[None if op=="count_true" else "unknown" for _ in bars]
            for i in range(window-1,len(source)):
                group=source[i-window+1:i+1]
                if op=="consecutive": output[i]="false" if "false" in group else ("true" if all(value=="true" for value in group) else "unknown")
                elif op=="within": output[i]="true" if "true" in group else ("unknown" if "unknown" in group else "false")
                elif "unknown" not in group: output[i]=float(sum(value=="true" for value in group))
        cache[key]=output
        return output
    return evaluate(formula),cache


def _compare(left, operator: str, right) -> str:
    if type(left) not in (int, float) or type(right) not in (int, float) or not math.isfinite(left) or not math.isfinite(right): return "unknown"
    return "true" if {"gt":left>right,"gte":left>=right,"lt":left<right,"lte":left<=right,"eq":left==right}[operator] else "false"


def _rolling(series: list, window: int, method: str) -> list:
    queue, output, total, squares, valid = deque(), [], 0., 0., 0
    for value in series:
        queue.append(value)
        if value is not None: total+=value; squares+=value*value; valid+=1
        if len(queue)>window:
            old=queue.popleft()
            if old is not None: total-=old; squares-=old*old; valid-=1
        if len(queue)<window or valid!=window: output.append(None)
        elif method=="sum": output.append(total if math.isfinite(total) else None)
        elif method=="mean": output.append(total/window if math.isfinite(total) else None)
        elif method=="std":
            variance = squares/window-(total/window)**2
            output.append(math.sqrt(max(0., variance)) if math.isfinite(squares) and math.isfinite(variance) else None)
        else:
            ordered=list(queue); output.append(min(ordered) if method=="min" else max(ordered))
    return output


def trace(formula: dict[str, Any], cache: dict[str, list], index: int, bars: Sequence[dict]) -> dict[str, Any]:
    def visit(current, position):
        key=json.dumps(current,sort_keys=True,ensure_ascii=False,separators=(",", ":"))
        value=cache[key][position] if 0<=position<len(cache[key]) else None
        node={**current,"label":summary(current),"value":value}
        if current["op"] in {"compare", "cross"}:
            display_operator = {"gt": "大于", "gte": "不低于", "lt": "小于", "lte": "不高于", "eq": "等于"}.get(current.get("operator"), "上穿" if current.get("direction") == "up" else "下穿")
            node["operator"] = display_operator
            node["display_operator"] = display_operator
        for name in ("input","left","right"):
            if isinstance(current.get(name),dict): node[name]=visit(current[name],position)
        if isinstance(current.get("children"),list): node["children"]=[visit(item,position) for item in current["children"]]
        if current["op"]=="cross" and position>0:
            node["previous"]={key:cache[json.dumps(current[key],sort_keys=True,ensure_ascii=False,separators=(",", ":"))][position-1] for key in ("left","right")}
        if current["op"]=="consecutive":
            source=cache[json.dumps(current["input"],sort_keys=True,ensure_ascii=False,separators=(",", ":"))]
            start=max(0,position-current["days"]+1)
            node["daily_values"]=[{"date":bars[i].get("trade_date"),"state":source[i],"formula":visit(current["input"],i)} for i in range(start,position+1)]
        return node
    return visit(formula,index)
