from datetime import datetime, timedelta

from scripts.profile_client_service import interval_seconds


def test_parallel_tool_waits_are_not_added_twice():
    start = datetime.fromisoformat('2026-11-16T08:00:00+00:00')
    intervals = [(start + timedelta(seconds=a), start + timedelta(seconds=b))
                 for a, b in [(0, 161), (0, 34), (190, 238), (191, 238), (190, 238), (250, 252), (252, 252)]]
    assert interval_seconds(intervals) == 211
    assert interval_seconds([]) == 0
