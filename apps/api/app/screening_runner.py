from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import MappingProxyType
from typing import Any

if __name__ == "__main__":
    dependency_dir = Path(__file__).resolve().parents[3] / "runtime" / "python-deps"
    if dependency_dir.is_dir():
        sys.path.insert(0, str(dependency_dir))

import numpy as np

MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_BYTES = 20 * 1024 * 1024
_OUTPUT_FD = None


def _json_default(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(f"Unsupported output type: {type(value).__name__}")


def _write_result(wrapper: dict[str, Any]) -> None:
    try:
        encoded = json.dumps(wrapper, ensure_ascii=False, allow_nan=False, default=_json_default).encode("utf-8")
    except (TypeError, ValueError, OverflowError):
        encoded = json.dumps(
            {"ok": False, "error": {"message": "程序结果包含合同不支持的数据类型或非有限数值"}},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    if len(encoded) > MAX_OUTPUT_BYTES:
        encoded = json.dumps(
            {"ok": False, "error": {"message": "程序结果超过20 MiB上限"}},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    offset = 0
    while offset < len(encoded):
        offset += os.write(_OUTPUT_FD, encoded[offset:])


def _build_frames(raw: dict[str, Any], required_fields: list[str]) -> MappingProxyType:
    fields = ("open", "high", "low", "close", "volume", "amount")
    output = {}
    for stock_code, rows in raw.items():
        columns: dict[str, Any] = {}
        dates = [str(row["trade_date"]) for row in rows]
        for field in fields:
            if field in required_fields:
                values = np.asarray([np.nan if row.get(field) is None else row[field] for row in rows], dtype=float)
                values.setflags(write=False)
                columns[field] = values
        valid = np.asarray([row.get("quality_valid") is True for row in rows], dtype=bool)
        valid.setflags(write=False)
        columns["valid"] = valid
        dates_tuple = tuple(dates)
        columns["trade_date"] = dates_tuple
        output[stock_code] = MappingProxyType(columns)
    return MappingProxyType(output)


def _execute(payload: dict[str, Any]) -> dict[str, Any]:
    source = payload["source_code"]
    namespace = {"__name__": "llm_screening_program", "np": np}
    exec(compile(source, "<screening-program>", "exec"), namespace)
    screen = namespace.get("screen")
    if not callable(screen):
        raise ValueError("源码必须定义 screen(context, frames, params)")

    context = dict(payload["context"])
    context["stock_codes"] = tuple(context["stock_codes"])
    context["required_fields"] = tuple(context["required_fields"])
    context["data_as_of"] = MappingProxyType(dict(context["data_as_of"]))
    frames = _build_frames(payload["frames"], context["required_fields"])
    params = MappingProxyType(dict(payload["params"]))
    value = screen(MappingProxyType(context), frames, params)
    if not isinstance(value, dict):
        raise ValueError("screen 必须返回对象")
    return value


def main() -> int:
    global _OUTPUT_FD
    if "--probe" in sys.argv[1:]:
        print(json.dumps({"ready": True, "backend": "local_python", "numpy": np.__version__}))
        return 0
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(1, os.O_BINARY)
    _OUTPUT_FD = os.dup(1)
    null_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(null_fd, 1)
    os.close(null_fd)
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        _write_result({"ok": False, "error": {"message": "程序输入超过64 MiB上限"}})
        return 0
    try:
        payload = json.loads(raw)
        result = _execute(payload)
        _write_result({"ok": True, "result": result})
    except BaseException as exc:
        message = " ".join(str(exc).split())[:500] or type(exc).__name__
        _write_result({"ok": False, "error": {"message": message}})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
