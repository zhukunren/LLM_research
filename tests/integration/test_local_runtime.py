from __future__ import annotations

import os
from pathlib import Path
import time

import psutil
import pytest

from apps.api.app import runtime_executor


def execute(source, **kwargs):
    return runtime_executor.execute_program(
        source_code=source,
        context=dict(contract_version="python-screen-v1", as_of="2026-01-03",
                     effective_market_date="2026-01-03", stock_codes=["600000.SH"],
                     required_fields=["close"], required_history_bars=3,
                     data_as_of={"600000.SH": "2026-01-03"}),
        frames={"600000.SH": [dict(trade_date=f"2026-01-0{day}", close=float(day), quality_valid=True)
                              for day in range(1, 4)]}, params={}, **kwargs,
    )


def test_real_local_numpy_program_returns_hand_calculated_slope_and_independent_pid():
    assert runtime_executor.readiness()["ready"]
    result = execute('''
import os
from statistics import mean
def screen(context, frames, params):
    print("诊断输出不能污染结果JSON")
    values = frames["600000.SH"]["close"]
    slope = float(np.polyfit(np.arange(len(values)), values, 1)[0])
    return {"decisions": {"600000.SH": slope > 0},
            "metrics": {"600000.SH": {"slope": slope, "mean": mean(values), "pid": os.getpid()}},
            "units": {"slope": "price/day"}}
''')
    assert result["decisions"] == {"600000.SH": True}
    metrics = result["metrics"]["600000.SH"]
    assert metrics["slope"] == pytest.approx(1)
    assert metrics["mean"] == 2
    assert metrics["pid"] != os.getpid()


def test_program_error_is_reported_without_retry_or_formula_replacement():
    with pytest.raises(runtime_executor.ProgramExecutionError, match="division by zero"):
        execute("def screen(context, frames, params):\n    return 1 / 0")


def test_wall_clock_timeout_stops_real_infinite_loop(monkeypatch):
    monkeypatch.setattr(runtime_executor, "WALL_CLOCK_SECONDS", 1)
    start = time.monotonic()
    with pytest.raises(runtime_executor.ProgramExecutionError, match="运行时限"):
        execute("def screen(context, frames, params):\n    while True:\n        pass")
    assert time.monotonic() - start < 12


def test_cancel_stops_program_and_its_spawned_child(tmp_path):
    marker = tmp_path / "child.pid"
    source = f'''
import subprocess, sys, time
from pathlib import Path
def screen(context, frames, params):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    Path({str(marker)!r}).write_text(str(child.pid))
    time.sleep(30)
'''
    with pytest.raises(runtime_executor.RuntimeCancelled):
        execute(source, is_active=lambda: not marker.exists())
    assert marker.exists()
    assert not psutil.pid_exists(int(marker.read_text()))


def test_output_and_memory_limits_are_enforced(monkeypatch):
    monkeypatch.setattr(runtime_executor, "MAX_OUTPUT_BYTES", 256)
    with pytest.raises(runtime_executor.ProgramExecutionError, match="输出超过"):
        execute("def screen(context, frames, params):\n    return {'large': 'x' * 4096}")
    monkeypatch.setattr(runtime_executor, "MAX_MEMORY_BYTES", 1)
    with pytest.raises(runtime_executor.ProgramExecutionError, match="内存"):
        execute("import time\ndef screen(context, frames, params):\n    time.sleep(20)")


def test_process_limit_stops_spawned_child(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_executor, "MAX_PROCESSES", 1)
    marker = tmp_path / "limited-child.pid"
    source = f'''
import subprocess, sys, time
from pathlib import Path
def screen(context, frames, params):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    Path({str(marker)!r}).write_text(str(child.pid))
    time.sleep(30)
'''
    with pytest.raises(runtime_executor.ProgramExecutionError, match="进程数量"):
        execute(source)
    if marker.exists():
        assert not psutil.pid_exists(int(marker.read_text()))
