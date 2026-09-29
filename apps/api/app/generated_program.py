"""Validated, directly loaded source modules for LLM-generated time-series rules."""
from __future__ import annotations

import ast
import copy
import hashlib
import importlib.abc
import importlib.util
import math
import operator
import os
import re
import sys
import tempfile
import threading
from functools import lru_cache
from numbers import Integral, Real
from pathlib import Path
from types import MappingProxyType, SimpleNamespace
from typing import Any

import numpy as np

MAX_SOURCE = 12_000
MAX_NODES = 900
MAX_DEPTH = 24
MAX_SERIES = 500
MAX_RANGE = 5_000
MAX_TRACE_STEPS = 60_000
MAX_OUTPUT_METRICS = 12
NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,39}$")
FIELDS = {"open", "high", "low", "close", "volume", "amount"}
SAFE_NP_ATTRS = {
    "abs", "absolute", "acos", "all", "amax", "amin", "any", "arange", "arccos", "arcsin",
    "arctan", "arctan2", "argmax", "argmin", "argsort", "ceil", "clip", "convolve",
    "cos", "cosh", "cumprod", "cumsum", "diff", "divide", "e", "equal", "exp",
    "expm1", "fmax", "fmin", "floor", "full_like", "greater", "greater_equal",
    "hypot", "isfinite", "isinf", "isnan", "less", "less_equal", "log", "log10",
    "floor_divide", "log1p", "logical_and", "logical_not", "logical_or", "maximum", "mean", "minimum",
    "mod", "multiply", "nan", "nanargmax", "nanargmin", "nanmax", "nanmean",
    "nanmin", "nanpercentile", "nanquantile", "nanstd", "nansum", "nanvar", "negative",
    "percentile", "pi", "polyfit", "positive", "power", "quantile", "ravel", "remainder",
    "rint", "roll", "sign", "sin", "sinh", "sort", "sqrt", "square",
    "std", "subtract", "sum", "tan", "tanh", "true_divide", "unique", "var", "where",
    "zeros_like", "ones_like", "full_like",
}
SAFE_BUILTIN_NAMES = {
    "abs", "all", "any", "bool", "dict", "enumerate", "float", "int", "len", "list",
    "max", "min", "range", "round", "sorted", "sum", "tuple", "zip",
}
SAFE_KEYWORDS = {"axis", "ddof", "mode", "q", "keepdims", "method"}
SAFE_BUILTINS = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict, "enumerate": enumerate,
    "float": float, "int": int, "len": len, "list": list, "max": max, "min": min,
    "range": range, "round": round, "sorted": sorted, "sum": sum, "tuple": tuple, "zip": zip,
}
SAFE_NUMPY = SimpleNamespace(**{name: getattr(np, name) for name in SAFE_NP_ATTRS if hasattr(np, name)})


def _safe_polyfit(x, y, degree):
    if not isinstance(x, np.ndarray) or not isinstance(y, np.ndarray) or x.ndim != 1 or y.ndim != 1 or len(x) != len(y) or len(x) > MAX_SERIES:
        raise ProgramError("polyfit 只接受等长的一维时序，最多500个数据点")
    if type(degree) is not int or not 0 <= degree <= 3:
        raise ProgramError("polyfit 阶数必须是0到3之间的整数")
    if not np.isfinite(x).all() or not np.isfinite(y).all():
        raise ProgramError("polyfit 输入包含未定义数据")
    with np.errstate(all="ignore"):
        return np.polyfit(x, y, degree)


def _safe_arange(*args):
    if not 1 <= len(args) <= 3 or any(not isinstance(value, Integral) or isinstance(value, bool) for value in args):
        raise ProgramError("arange 仅接受整数边界")
    values = tuple(int(value) for value in args)
    result = np.arange(*values, dtype=np.int64)
    if result.ndim != 1 or len(result) > MAX_SERIES:
        raise ProgramError("arange 序列长度超过500")
    return result


SAFE_NUMPY.polyfit = _safe_polyfit
SAFE_NUMPY.arange = _safe_arange
_LOAD_LOCK = threading.RLock()
_BINARY_FUNCTIONS = {
    ast.Add: (np.add, "add"), ast.Sub: (np.subtract, "subtract"), ast.Mult: (np.multiply, "multiply"),
    ast.Div: (np.divide, "divide"), ast.FloorDiv: (np.floor_divide, "floor_divide"),
    ast.Mod: (np.remainder, "remainder"), ast.Pow: (np.power, "power"),
    ast.BitAnd: (np.bitwise_and, "bitwise_and"), ast.BitOr: (np.bitwise_or, "bitwise_or"),
}


class ProgramError(ValueError):
    pass


def _tree_depth(node: ast.AST, depth: int = 0) -> int:
    if depth > MAX_DEPTH:
        raise ProgramError("公式语法嵌套过深")
    for child in ast.iter_child_nodes(node):
        _tree_depth(child, depth + 1)
    return depth


def _calls(node: ast.AST) -> set[str]:
    return {item.func.id for item in ast.walk(node) if isinstance(item, ast.Call) and isinstance(item.func, ast.Name)}


@lru_cache(maxsize=128)
def _parse(source: str) -> ast.Module:
    if not isinstance(source, str) or not source.strip() or len(source) > MAX_SOURCE:
        raise ProgramError("LLM 计算源码为空或超过长度限制")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise ProgramError(f"LLM 计算源码语法无效：{exc.msg}") from None
    nodes = list(ast.walk(tree))
    _tree_depth(tree)
    if len(nodes) > MAX_NODES or not tree.body or any(not isinstance(item, ast.FunctionDef) for item in tree.body):
        raise ProgramError("源码只允许少量顶层函数，或源码节点过多")
    if sum(isinstance(item, ast.FunctionDef) for item in nodes) != len(tree.body):
        raise ProgramError("源码不允许在计算函数内部动态定义函数")
    functions = {item.name: item for item in tree.body}
    if len(functions) != len(tree.body) or "calculate" not in functions:
        raise ProgramError("源码必须定义唯一 calculate 函数")
    function_names = set(functions)
    if any(not NAME.fullmatch(name) or name.startswith("_") for name in function_names) or function_names & SAFE_BUILTIN_NAMES | function_names & {"np"}:
        raise ProgramError("函数名称无效或覆盖了运行时函数")
    allowed_node_types = (
        ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return, ast.Assign, ast.AugAssign,
        ast.For, ast.If, ast.Expr, ast.Pass, ast.Break, ast.Continue, ast.Name, ast.Load, ast.Store,
        ast.Constant, ast.List, ast.Tuple, ast.Set, ast.Dict, ast.Subscript, ast.Slice, ast.BinOp,
        ast.UnaryOp, ast.BoolOp, ast.Compare, ast.IfExp, ast.Call, ast.Attribute, ast.keyword,
        ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow, ast.BitAnd, ast.BitOr,
        ast.UAdd, ast.USub, ast.Not, ast.Invert, ast.And, ast.Or, ast.Eq, ast.NotEq, ast.Gt,
        ast.GtE, ast.Lt, ast.LtE,
        ast.Is, ast.IsNot, ast.In, ast.NotIn,
    )
    if any(not isinstance(node, allowed_node_types) for node in nodes):
        unsupported = next(type(node).__name__ for node in nodes if not isinstance(node, allowed_node_types))
        raise ProgramError(f"源码包含未允许的 Python 结构：{unsupported}")
    for node in nodes:
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ProgramError("源码不能引用内部或双下划线名称")
        if isinstance(node, ast.Constant):
            value = node.value
            if not (value is None or type(value) in (bool, int, float, str)):
                raise ProgramError("源码常量类型不受支持")
            if isinstance(value, str) and len(value) > 120:
                raise ProgramError("源码文本常量过长")
            if type(value) is int and abs(value) > 10**12 or type(value) is float and not math.isfinite(value):
                raise ProgramError("源码数值常量超出范围")
        if isinstance(node, ast.Attribute):
            list_method = node.attr in {"append", "extend"} and any(isinstance(parent, ast.Call) and parent.func is node for parent in nodes)
            if not isinstance(node.ctx, ast.Load) or not (isinstance(node.value, ast.Name) and node.value.id == "np" and node.attr in SAFE_NP_ATTRS) and not list_method:
                raise ProgramError(f"源码属性不受支持：{node.attr}")
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Tuple):
            raise ProgramError("只允许对一维时序取值，不能创建多维广播数组")
        if isinstance(node, ast.Dict) and (len(node.keys) > 32 or any(key is None for key in node.keys)):
            raise ProgramError("源码字典字段过多或包含动态解包")
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)) and len(node.elts) > MAX_SERIES:
            raise ProgramError("源码序列常量过长")
        if isinstance(node, ast.Call):
            if any(keyword.arg not in SAFE_KEYWORDS for keyword in node.keywords) or any(keyword.arg is None for keyword in node.keywords):
                raise ProgramError("函数参数只允许公开的数值选项")
            if isinstance(node.func, ast.Name):
                if node.func.id not in SAFE_BUILTIN_NAMES | function_names:
                    raise ProgramError(f"源码调用了未开放的函数：{node.func.id}")
            elif isinstance(node.func, ast.Attribute):
                if isinstance(node.func.value, ast.Name) and node.func.value.id == "np" and node.func.attr in SAFE_NP_ATTRS:
                    pass
                elif node.func.attr in {"append", "extend"} and len(node.args) == 1 and not node.keywords:
                    pass
                else:
                    raise ProgramError("源码函数调用不在白名单中")
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Slice):
            if isinstance(node.slice.step, ast.Constant) and node.slice.step.value not in (None, 1, -1):
                raise ProgramError("时序切片步长只支持 1 或 -1")
    for function in functions.values():
        args = function.args
        if function.decorator_list or function.returns or args.vararg or args.kwarg or args.kwonlyargs or args.defaults or args.kw_defaults or args.posonlyargs:
            raise ProgramError("源码函数不允许装饰器、默认参数或可变参数")
        arg_names = [item.arg for item in args.args]
        if len(set(arg_names)) != len(arg_names) or any(not NAME.fullmatch(name) or name.startswith("_") for name in arg_names):
            raise ProgramError("源码函数参数名无效")
        if set(arg_names) & (SAFE_BUILTIN_NAMES | function_names | {"np"}):
            raise ProgramError("函数参数不能覆盖安全函数或模块名称")
        if function.name == "calculate" and arg_names != ["bars", "params"]:
            raise ProgramError("主函数签名必须为 calculate(bars, params)")
        if function.name != "calculate" and len(arg_names) > 8:
            raise ProgramError("辅助函数参数过多")
        assigned_names = {item.id for item in ast.walk(function) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Store)}
        if assigned_names & (SAFE_BUILTIN_NAMES | function_names | {"np"}):
            raise ProgramError("局部变量不能覆盖安全函数或模块名称")
    graph = {name: _calls(function) & function_names for name, function in functions.items()}
    def visit(name: str, active: set[str], complete: set[str]) -> None:
        if name in active: raise ProgramError("辅助函数不能递归调用")
        if name in complete: return
        for child in graph[name]: visit(child, active | {name}, complete)
        complete.add(name)
    complete: set[str] = set()
    for name in function_names: visit(name, set(), complete)
    return tree


def validate_program(source: Any) -> None:
    if not isinstance(source, str):
        raise ProgramError("LLM 计算源码必须是文本")
    _parse(source)


def _bounded_range(*args):
    if not 1 <= len(args) <= 3 or any(not isinstance(value, Integral) or isinstance(value, bool) for value in args):
        raise ProgramError("range 仅接受整数边界")
    result = range(*(int(value) for value in args))
    if len(result) > MAX_RANGE:
        raise ProgramError("单次循环范围超出安全上限")
    return result


def _safe_binary(name: str, left: Any, right: Any):
    if name in {"bitwise_and", "bitwise_or"}:
        if isinstance(left, np.ndarray) and isinstance(right, np.ndarray):
            if left.dtype.kind != "b" or right.dtype.kind != "b" or left.ndim != 1 or right.ndim != 1 or len(left) != len(right) or len(left) > MAX_SERIES:
                raise ProgramError("位运算只允许等长的一维布尔时序")
        elif isinstance(left, (bool, np.bool_)) and isinstance(right, (bool, np.bool_)):
            return bool(left and right) if name == "bitwise_and" else bool(left or right)
        else:
            raise ProgramError("位运算只允许布尔值和布尔时序")
    left_array, right_array = isinstance(left, np.ndarray), isinstance(right, np.ndarray)
    if left_array or right_array:
        for value in (left, right):
            if isinstance(value, np.ndarray) and (value.ndim != 1 or len(value) > MAX_SERIES * 2 or value.dtype.kind not in "biuf"):
                raise ProgramError("数值运算只允许有限长度的一维数值数组")
            if not isinstance(value, np.ndarray) and not (isinstance(value, Real) and not isinstance(value, bool)):
                raise ProgramError("数组运算只允许与数值或等长一维数组组合")
        if left_array and right_array and len(left) != len(right):
            raise ProgramError("两条行情时序长度不一致")
        if name == "power" and right_array:
            raise ProgramError("幂运算指数必须是单个数值")
        if name == "power" and abs(float(right)) > 16:
            raise ProgramError("幂运算指数超过安全范围")
        function = _BINARY_FUNCTIONS[next(kind for kind, (_, label) in _BINARY_FUNCTIONS.items() if label == name)][0]
        with np.errstate(all="ignore"):
            result = function(left, right)
        if not isinstance(result, np.ndarray) or result.ndim != 1 or len(result) > MAX_SERIES * 2 or result.dtype.kind not in "biuf":
            raise ProgramError("数值运算产生了超出合同的一维时序")
        if result.dtype.kind in "iuf":
            result = np.where(np.isfinite(result), result, np.nan)
        return result
    if not (isinstance(left, Real) and not isinstance(left, bool) and isinstance(right, Real) and not isinstance(right, bool)):
        raise ProgramError("公式运算只允许数值或数值时序，不能拼接列表和文本")
    if isinstance(left, Integral) and isinstance(right, Integral) and name != "divide":
        if name == "power" and abs(int(right)) > 16:
            raise ProgramError("幂运算指数超过安全范围")
        operations = {"add": operator.add, "subtract": operator.sub, "multiply": operator.mul, "floor_divide": operator.floordiv, "remainder": operator.mod, "power": operator.pow}
        if name in operations:
            try: result = int(operations[name](int(left), int(right)))
            except (ArithmeticError, OverflowError) as exc: raise ProgramError("整数运算无效") from exc
            if abs(result) > 10**100: raise ProgramError("整数运算结果超出安全范围")
            return result
    left, right = float(left), float(right)
    if not math.isfinite(left) or not math.isfinite(right) or abs(left) > 1e100 or abs(right) > 1e100:
        raise ProgramError("数值运算输入超出安全范围")
    if name == "power" and abs(right) > 16:
        raise ProgramError("幂运算指数超过安全范围")
    function = _BINARY_FUNCTIONS[next(kind for kind, (_, label) in _BINARY_FUNCTIONS.items() if label == name)][0]
    with np.errstate(all="ignore"):
        result = function(left, right)
    result = float(result)
    return result if math.isfinite(result) else math.nan


class _SafeBinary(ast.NodeTransformer):
    def visit_BinOp(self, node):
        self.generic_visit(node)
        name = _BINARY_FUNCTIONS[type(node.op)][1]
        return ast.copy_location(ast.Call(func=ast.Name(id=f"__condition_{name}", ctx=ast.Load()), args=[node.left, node.right], keywords=[]), node)

    def visit_AugAssign(self, node):
        self.generic_visit(node)
        target = copy.deepcopy(node.target)
        left = copy.deepcopy(node.target)
        left.ctx = ast.Load()
        right = node.value
        name = _BINARY_FUNCTIONS[type(node.op)][1]
        call = ast.Call(func=ast.Name(id=f"__condition_{name}", ctx=ast.Load()), args=[left, right], keywords=[])
        return ast.copy_location(ast.Assign(targets=[target], value=call), node)

    def visit_UnaryOp(self, node):
        self.generic_visit(node)
        if isinstance(node.op, ast.Invert):
            return ast.copy_location(ast.Call(func=ast.Name(id="__condition_invert", ctx=ast.Load()), args=[node.operand], keywords=[]), node)
        return node


def _safe_invert(value):
    if isinstance(value, np.ndarray) and value.dtype.kind == "b" and value.ndim == 1 and len(value) <= MAX_SERIES:
        return np.logical_not(value)
    if isinstance(value, (bool, np.bool_)):
        return not value
    raise ProgramError("取反只允许布尔值和一维布尔时序")


def _source_path(source: str) -> tuple[str, Path]:
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
    root = Path(tempfile.gettempdir()) / "llm-research-generated" / "conditions"
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{digest}.py"
    with _LOAD_LOCK:
        if path.exists():
            if path.read_text(encoding="utf-8") != source:
                raise ProgramError("源码缓存哈希与内容不一致")
        else:
            fd, temporary = tempfile.mkstemp(prefix=f"{digest}.", suffix=".tmp", dir=root)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                    stream.write(source)
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    return digest, path


@lru_cache(maxsize=128)
def _load_module(source: str):
    _parse(source)
    digest, path = _source_path(source)
    module_name = f"_llm_condition_{digest}"
    with _LOAD_LOCK:
        if module_name in sys.modules:
            return digest, path, sys.modules[module_name]
        loader = _GeneratedModuleLoader(path)
        spec = importlib.util.spec_from_loader(module_name, loader, origin=str(path))
        if spec is None or spec.loader is None:
            raise ProgramError("无法加载生成公式源码模块")
        module = importlib.util.module_from_spec(spec)
        module.__dict__["__builtins__"] = {**SAFE_BUILTINS, "range": _bounded_range}
        module.__dict__["np"] = SAFE_NUMPY
        module.__dict__.update({f"__condition_{name}": lambda left, right, name=name: _safe_binary(name, left, right) for _, (_, name) in _BINARY_FUNCTIONS.items()})
        module.__dict__["__condition_invert"] = _safe_invert
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            sys.modules.pop(module_name, None)
            raise ProgramError(f"生成公式源码加载失败：{exc}") from None
        if not callable(module.__dict__.get("calculate")):
            sys.modules.pop(module_name, None)
            raise ProgramError("源码模块没有可调用的 calculate 函数")
        return digest, path, module


class _GeneratedModuleLoader(importlib.abc.Loader):
    def __init__(self, source_path: Path):
        self.source_path = source_path

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        source = self.source_path.read_text(encoding="utf-8")
        tree = _SafeBinary().visit(copy.deepcopy(_parse(source)))
        ast.fix_missing_locations(tree)
        code = compile(tree, str(self.source_path), "exec")
        exec(code, module.__dict__)


def build_input(bars: list[dict[str, Any]], required_fields: list[str]) -> tuple[MappingProxyType, np.ndarray]:
    if len(bars) > MAX_SERIES:
        raise ProgramError("公式最多接收500根有序日线")
    required = set(required_fields)
    valid = np.ones(len(bars), dtype=bool)
    arrays = {field: np.full(len(bars), np.nan, dtype=np.float64) for field in FIELDS}
    for index, bar in enumerate(bars):
        row_valid = bool(bar.get("quality_valid", True))
        for field in FIELDS:
            value = bar.get(field)
            is_valid = isinstance(value, Real) and not isinstance(value, bool)
            if is_valid:
                try:
                    value = float(value)
                    is_valid = math.isfinite(value) and (value > 0 if field in {"open", "high", "low", "close"} else value >= 0)
                except (TypeError, ValueError, OverflowError):
                    is_valid = False
            if row_valid and is_valid:
                arrays[field][index] = value
            elif field in required:
                row_valid = False
        valid[index] = row_valid
    arrays["valid"] = valid
    for array in arrays.values(): array.setflags(write=False)
    return MappingProxyType(arrays), valid


def _invoke(module, path: Path, bars: MappingProxyType, params: MappingProxyType):
    previous_trace = sys.gettrace()
    steps = 0
    def budget(frame, event, arg):
        nonlocal steps
        if frame.f_code.co_filename == str(path) and event == "line":
            steps += 1
            if steps > MAX_TRACE_STEPS:
                raise ProgramError("生成公式超过单只证券计算步骤上限")
        return budget
    try:
        sys.settrace(budget)
        return module.calculate(bars, params)
    except ProgramError:
        raise
    except Exception as exc:
        raise ProgramError(f"生成公式计算失败：{type(exc).__name__}: {exc}") from None
    finally:
        sys.settrace(previous_trace)


def _vector(value: Any, length: int, name: str) -> list[Any]:
    if isinstance(value, np.ndarray):
        if value.ndim != 1 or len(value) != length or value.dtype.kind not in "biuf":
            raise ProgramError(f"{name} 必须是一维数值时序且长度等于输入")
        values = value.tolist()
    elif isinstance(value, (list, tuple)) and len(value) == length:
        values = list(value)
    else:
        raise ProgramError(f"{name} 必须是一维时序且长度等于输入")
    return values


def _normalize_result(value: Any, length: int) -> list[bool | None]:
    values = _vector(value, length, "result")
    output: list[bool | None] = []
    for item in values:
        if item is None: output.append(None)
        elif isinstance(item, (bool, np.bool_)): output.append(bool(item))
        elif isinstance(item, Real) and not isinstance(item, bool):
            number = float(item)
            if not math.isfinite(number): output.append(None)
            elif number in (0.0, 1.0): output.append(bool(number))
            else: raise ProgramError("result 数值只能用1表示符合、0表示不符合、NaN表示数据不足")
        else: raise ProgramError("result 只能包含布尔值、0/1 或数据不足")
    return output


def _normalize_metric(value: Any, length: int, name: str) -> list[float | None]:
    values = _vector(value, length, f"metrics.{name}")
    output = []
    for item in values:
        if item is None: output.append(None)
        elif isinstance(item, Real) and not isinstance(item, (bool, np.bool_)):
            number = float(item)
            output.append(number if math.isfinite(number) else None)
        else: raise ProgramError(f"metrics.{name} 只能包含数值或数据不足")
    return output


def execute_program(source: str, bars: list[dict[str, Any]], params: dict[str, Any], required_fields: list[str]) -> tuple[list[str], dict[str, list], str, list[bool]]:
    if len(bars) > MAX_SERIES:
        bars = bars[-MAX_SERIES:]
    input_bars, valid = build_input(bars, required_fields)
    digest, path, module = _load_module(source)
    output = _invoke(module, path, input_bars, MappingProxyType(dict(params)))
    if not isinstance(output, dict) or set(output) != {"result", "metrics"}:
        raise ProgramError("calculate 必须返回 {result:布尔时序, metrics:数值时序字典}")
    raw_result, raw_metrics = output["result"], output["metrics"]
    if not isinstance(raw_metrics, dict) or len(raw_metrics) > MAX_OUTPUT_METRICS:
        raise ProgramError("metrics 必须是最多12项的数值时序字典")
    result = _normalize_result(raw_result, len(bars))
    metrics = {}
    for name, series in raw_metrics.items():
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ProgramError("指标解释项名称无效")
        metrics[name] = _normalize_metric(series, len(bars), name)
    for index, row_valid in enumerate(valid):
        if not row_valid:
            result[index] = None
            for series in metrics.values(): series[index] = None
    states = ["unknown" if value is None else "true" if value else "false" for value in result]
    return states, metrics, digest, valid.tolist()
