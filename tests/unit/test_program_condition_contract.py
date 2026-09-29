from __future__ import annotations

import pytest
from pydantic import ValidationError

from apps.api.app import program_conditions


def test_chinese_metric_labels_preserve_numeric_validation():
    payload = {'decisions': {'600000.SH': True}, 'metrics': {'600000.SH': {'收盘价': 10.5, '20日均线': 10.0}}, 'units': {'收盘价': '元', '20日均线': '元'}}
    decisions, metrics, units = program_conditions.validate_result(payload, ['600000.SH'])
    assert decisions['600000.SH'] is True and metrics['600000.SH']['20日均线'] == 10.0
    assert units['收盘价'] == '元'
    payload['metrics']['600000.SH']['收盘价'] = float('nan')
    with pytest.raises(program_conditions.ProgramConditionError):
        program_conditions.validate_result(payload, ['600000.SH'])
from apps.api.app.screening_contracts import CustomProgram


def program(**changes):
    values = {
        "contract_version": "python-screen-v1",
        "source_code": "def screen(context, frames, params):\n    return {}\n",
        "required_fields": ["close"],
        "required_history_bars": 3,
        "parameters": {"window": 3},
        "parameter_specs": {"window": {"label": "观察周期", "type": "integer", "minimum": 2, "maximum": 20}},
    }
    values.update(changes)
    return CustomProgram.model_validate(values)


def test_custom_program_contract_accepts_standard_python_and_declared_inputs():
    source = "import numpy as np\ndef screen(context, frames, params):\n    return {'decisions': {code: True for code in context['stock_codes']}}\n"
    value = program(source_code=source)

    assert value.contract_version == "python-screen-v1"
    assert value.required_fields == ["close"]
    assert program_conditions.source_sha256(value)


def test_program_parameters_are_finite_typed_and_bounded():
    with pytest.raises(ValidationError, match="布尔值"):
        program(parameters={"window": True})
    with pytest.raises(ValidationError, match="整数"):
        program(parameters={"window": 2.5})
    with pytest.raises(ValidationError, match="上限"):
        program(parameters={"window": 21})
    with pytest.raises(ValidationError, match="每个"):
        program(parameter_specs={})

    value = program()
    assert program_conditions.merged_parameters(value, {"window": 5}) == {"window": 5}
    with pytest.raises(program_conditions.ProgramConditionError, match="下限"):
        program_conditions.merged_parameters(value, {"window": 1})
    with pytest.raises(program_conditions.ProgramConditionError, match="未声明"):
        program_conditions.merged_parameters(value, {"unknown": 5})


def test_program_result_must_cover_exact_universe_and_return_tristate_numeric_evidence():
    codes = ["600000.SH", "600001.SH"]
    decisions, metrics, units = program_conditions.validate_result(
        {
            "decisions": {"600000.SH": True, "600001.SH": None},
            "metrics": {"600000.SH": {"distance_pct": 2.1, "history": [1.8, 2.1]}},
            "units": {"distance_pct": "%", "history": "%"},
        },
        codes,
    )

    assert decisions == {"600000.SH": True, "600001.SH": None}
    assert metrics["600000.SH"]["history"] == [1.8, 2.1]
    assert units["distance_pct"] == "%"
    with pytest.raises(program_conditions.ProgramConditionError, match="冻结范围"):
        program_conditions.validate_result({"decisions": {"600000.SH": True}}, codes)
    with pytest.raises(program_conditions.ProgramConditionError, match="有限数值"):
        program_conditions.validate_result(
            {"decisions": {code: False for code in codes}, "metrics": {"600000.SH": {"x": float("nan")}}},
            codes,
        )


def test_frames_are_cut_to_declared_history_and_reject_future_or_unsorted_data():
    value = program()
    bars = [
        {"trade_date": f"2026-01-0{day}", "close": float(day), "quality_valid": True}
        for day in range(1, 6)
    ]
    frames, dates = program_conditions._runtime_frames(value, ["600000.SH"], {"600000.SH": bars}, "2026-01-05")
    assert [row["trade_date"] for row in frames["600000.SH"]] == ["2026-01-03", "2026-01-04", "2026-01-05"]
    assert dates["600000.SH"] == "2026-01-05"

    with pytest.raises(program_conditions.ProgramConditionError, match="乱序或超出截止日"):
        program_conditions._runtime_frames(
            value,
            ["600000.SH"],
            {"600000.SH": [{"trade_date": "2026-01-06", "close": 1, "quality_valid": True}]},
            "2026-01-05",
        )
