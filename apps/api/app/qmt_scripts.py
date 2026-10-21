"""Static checks and downloadable QMT built-in Python scripts. Never executes code."""
from __future__ import annotations

import ast
import hashlib
import re
from typing import Literal
from urllib.parse import quote

from pydantic import Field

from . import conversation_store, research_files, qmt_docs, research_assistants
from .models import StrictModel


class QmtScriptArgs(StrictModel):
    code: str = Field(min_length=1, max_length=48000)
    filename: str = Field(default="qmt_strategy.py", pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,63}\.py$")
    encoding: Literal["gbk", "utf-8"] = "gbk"


_COOKIE = re.compile(r"^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)")
_ORDER_FUNCTIONS = {"passorder", "algo_passorder", "smart_algo_passorder", "order_shares",
                    "order_lots", "order_value", "order_percent", "order_target_value", "order_target_percent"}


def _source(code: str, encoding: str) -> str:
    lines = code.lstrip("\ufeff").replace("\r\n", "\n").split("\n")
    if lines[-1] == "":
        lines.pop()
    # Replace an existing cookie in its legal location; preserve a shebang.
    for index in range(min(2, len(lines))):
        if _COOKIE.match(lines[index]):
            lines[index] = "# -*- coding: " + encoding + " -*-"
            break
    else:
        lines.insert(1 if lines and lines[0].startswith("#!") else 0, "# -*- coding: " + encoding + " -*-")
    return "\n".join(lines) + "\n"


def inspect_script(args: QmtScriptArgs) -> tuple[dict, bytes | None]:
    source = _source(args.code, args.encoding)
    errors, warnings = [], []
    payload = None
    try:
        payload = source.encode(args.encoding)
    except UnicodeEncodeError:
        errors.append({"code": "encoding_error", "message": "源码含 GBK 无法表示的字符，请替换字符或选择 UTF-8。"})
    try:
        tree = ast.parse(source)
        compile(tree, args.filename, "exec", dont_inherit=True)  # Compile only; no evaluation/import.
    except (SyntaxError, ValueError, RecursionError) as exc:
        errors.append({"code": "python_syntax", "message": str(exc)[:500], "line": getattr(exc, "lineno", None)})
        tree = None
    if tree is not None:
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        for name in ("init", "handlebar"):
            function = functions.get(name)
            if function is None:
                errors.append({"code": "missing_entrypoint", "message": f"QMT 内置策略需要顶层 def {name}(ContextInfo)。"})
            elif (len(function.args.posonlyargs + function.args.args) != 1
                  or any(default is None for default in function.args.kw_defaults)):
                errors.append({"code": "invalid_entrypoint", "message": f"{name} 应接收一个策略上下文参数。", "line": function.lineno})
        nodes = list(ast.walk(tree))
        if any(isinstance(node, ast.Attribute) and node.attr == "is_back_test" for node in nodes):
            errors.append({"code": "unknown_backtest_flag", "message": "QMT 官方回测标记是 ContextInfo.do_back_test 布尔属性，请核对并修正 is_back_test。"})
        imports = [alias.name for node in nodes if isinstance(node, ast.Import) for alias in node.names]
        imports += [node.module or "" for node in nodes if isinstance(node, ast.ImportFrom)]
        if any(name.split(".")[0] == "xtquant" for name in imports):
            errors.append({"code": "wrong_runtime", "message": "当前目标为 QMT 内置 Python，请使用 ContextInfo 接口；xtquant 属于外部 Python 环境。"})
        calls = [node for node in nodes if isinstance(node, ast.Call)]
        order_calls = [node for node in calls if isinstance(node.func, ast.Name) and node.func.id in _ORDER_FUNCTIONS]
        if order_calls:
            warnings.append({"code": "order_calls", "message": "脚本包含交易调用；需在券商 QMT 核对账号、权限、数量单位与委托防重，工作台未执行交易。"})
        for call in calls:
            if isinstance(call.func, ast.Attribute) and call.func.attr == "get_market_data_ex":
                if not any(item.arg == "end_time" for item in call.keywords) and len(call.args) < 5:
                    warnings.append({"code": "market_cutoff", "line": call.lineno,
                                     "message": "行情调用未显式指定 end_time，请核对回测时是否读取了当前 bar 之后的数据。"})
        if any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"exec", "eval", "__import__"} for node in nodes):
            warnings.append({"code": "dynamic_code", "message": "存在动态执行，静态检查无法检查动态生成的逻辑。"})
    return {"valid": not errors, "target": "qmt_builtin", "encoding": args.encoding,
            "errors": errors, "warnings": warnings, "validation": "static_only", "runtime_verified": False,
            "note": "仅检查当前服务 Python 语法、策略入口、编码和常见接口误用；未验证券商版本兼容性、策略收益、完整前视偏差或实盘行为。"}, payload


def validate_script(args: QmtScriptArgs, context) -> dict:
    return inspect_script(args)[0]


def export_script(args: QmtScriptArgs, context) -> dict:
    from .screening_tools import ToolDispatchError

    result, payload = inspect_script(args)
    if not result["valid"]:
        return {**result, "exported": False}
    conversation_store.get_conversation(context.conversation_id, message_limit=1)
    chosen = research_assistants.turn_snapshot(context.conversation_id, context.turn_id)
    if chosen.get("id") == "qmt-script" and chosen.get("revision", 1) >= 2:
        try:
            documentation = qmt_docs.consultation(context, args.code)
        except qmt_docs.QmtReferenceError as exc:
            raise ToolDispatchError("qmt_reference_error", str(exc)) from exc
        if documentation["missing_doc_ids"]:
            return {**result, "exported": False, "documentation": documentation,
                    "message": "请先用 read_qmt_doc 读完缺少的手册/接口正文（续读 next_offset），再以新的工具调用导出。搜索摘要不算完整查阅。"}
        result["documentation"] = documentation
    digest = hashlib.sha256(payload).hexdigest()
    filename = args.filename[:-3] + "_" + digest[:16] + ".py"
    try:
        # Check all workspace boundaries before creating a file; never overwrite.
        root = research_files._outputs_root(context.conversation_id)
        root.mkdir(parents=True, exist_ok=True)
        root = research_files._outputs_root(context.conversation_id)
        path = root / filename
        try:
            with path.open("xb") as output:
                output.write(payload)
        except FileExistsError:
            existing = research_files.generated_file_path(context.conversation_id, filename)
            if hashlib.sha256(existing.read_bytes()).hexdigest() != digest:
                raise research_files.GeneratedFileError("同名成果内容冲突，请修改文件名后重试。")
        verified = research_files.generated_file_path(context.conversation_id, filename)
    except (OSError, ValueError) as exc:
        raise ToolDispatchError("qmt_export_failed", "QMT 脚本导出失败，请检查成果目录或修改文件名后重试。") from exc
    return {**result, "exported": True, "file": {
        "name": filename, "bytes": verified.stat().st_size, "sha256": digest,
        "url": f"/api/v1/conversations/{quote(context.conversation_id, safe='')}/generated-files/{quote(filename)}",
    }}


def register_tools(registry) -> None:
    qmt_docs.register_tools(registry)
    registry.register("validate_qmt_script", "Statically check a QMT CLIENT BUILT-IN Python strategy (init/handlebar, syntax, encoding, obvious runtime mixups and data cutoff warnings). Never executes the script or connects to a broker. Not a backtest or safety proof.", QmtScriptArgs, validate_script)
    registry.register("export_qmt_script", "Check and export QMT client built-in Python source as an immutable downloadable .py file. QMT assistant v2 requires complete current-turn read_qmt_doc consultations of the handbook, lifecycle and relevant interfaces; missing_doc_ids tells you what to read before retrying with a new call. Returns actual documentation provenance. Default GBK, optional UTF-8. Never executes code or sends orders. Include file URL, sources and static-check limits in the answer.", QmtScriptArgs, export_script, read_only=False)
