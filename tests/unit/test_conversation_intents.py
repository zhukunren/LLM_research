from apps.api.app.conversation_service import _revision_changes, _task_gap
from apps.api.app.screening_contracts import (
    ConditionDefinition,
    ConditionReference,
    ScreeningTaskRevision,
    TaskScope,
    UniverseScope,
)


def task(*, revision=1, scope=None, window=20):
    return ScreeningTaskRevision(
        task_id="conversation-1",
        revision=revision,
        original_user_messages=["收盘价高于20日均线且成交量大于5日均量"],
        conditions=[
            ConditionDefinition(
                condition_id="ma-close",
                library="technical",
                source_quote="收盘价高于20日均线",
                expression={"op": "indicator_compare", "window": window},
                description="收盘价高于20日均线",
            ),
            ConditionDefinition(
                condition_id="volume-average",
                library="technical",
                source_quote="成交量大于5日均量",
                expression={"op": "volume_compare", "window": 5},
                description="成交量大于5日均量",
            ),
        ],
        references=[
            ConditionReference(reference_id="r-ma", condition_id="ma-close"),
            ConditionReference(reference_id="r-volume", condition_id="volume-average"),
        ],
        logic_tree={
            "op": "all",
            "children": [
                {"op": "condition", "reference_id": "r-ma"},
                {"op": "condition", "reference_id": "r-volume"},
            ],
        },
        scope=scope or TaskScope(
            universe=UniverseScope(kind="all_a_shares"),
            as_of="2026-09-14",
        ),
    )


def test_parameter_edit_summary_names_the_changed_target_and_values():
    before = task()
    after = task(revision=2, window=30)

    changes = _revision_changes(before, after)

    assert len(changes) == 1
    assert "调整条件参数（收盘价高于20日均线）" in changes[0]
    assert '"window":20' in changes[0]
    assert '"window":30' in changes[0]
    assert "成交量大于5日均量" not in changes[0]


def test_execution_gap_asks_scope_before_cutoff_date():
    no_scope = task(scope=TaskScope())
    cutoff_only = task(scope=TaskScope(universe=UniverseScope(kind="all_a_shares")))

    assert _task_gap(no_scope) == "筛选范围是全部A股、自选池，还是指定的股票？"
    assert _task_gap(cutoff_only) == "这次筛选以哪一天作为数据截止日？"
