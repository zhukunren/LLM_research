from __future__ import annotations

import pytest

from apps.api.app.ranking import evaluate_ranking
from apps.api.app.screening_contracts import ConditionDecision, ConditionDefinition, ConditionReference, RankingSpec


def rank(values, *, population=None, **changes):
    settings = dict(
        ranking_universe="all_a_shares", metric_reference_id="metric", metric_name="score",
        direction="descending", top_n=1, ties_policy="stable_code", missing_policy="unknown",
    )
    settings.update(changes)
    codes = list(values)
    metrics = {
        code: ConditionDecision(
            stock_code=code, condition_id="score", reference_id="metric",
            state="true", evaluation_status="completed", reason_code="condition_met",
            explanation="合成指标", actual_values={"score": value}, units={"score": "%"},
        ) for code, value in values.items()
    }
    return evaluate_ranking(
        RankingSpec(**settings),
        ConditionDefinition(
            condition_id="rank", library="ranking", source_quote="前列", description="指标前列",
            implementation_id="ranking-v1", implementation_version="ranking-v1",
        ),
        ConditionReference(reference_id="rank-ref", condition_id="rank"),
        codes, metrics, population or {code: "true" for code in codes},
    )


def test_full_population_and_filtered_population_have_different_winners():
    values = {"600000.SH": 100, "600001.SH": 90, "600002.SH": 80}
    full = rank(values)
    filtered = rank(
        values, population={"600000.SH": "false", "600001.SH": "true", "600002.SH": "true"},
        ranking_universe="after_filters", rank_after_filters=True,
        population_logic_tree={"op": "condition", "reference_id": "volume"},
    )
    assert [code for code, item in full.items() if item.state == "true"] == ["600000.SH"]
    assert [code for code, item in filtered.items() if item.state == "true"] == ["600001.SH"]
    assert full["600001.SH"].actual_values["population_size"] == 3
    assert filtered["600001.SH"].actual_values["population_size"] == 2


def test_ties_and_fraction_rounding_are_explicit_and_stable():
    values = {"600002.SH": 10, "600001.SH": 10, "600003.SH": 9}
    stable = rank(values)
    ties = rank(values, ties_policy="include_all")
    assert {code for code, item in stable.items() if item.state == "true"} == {"600001.SH"}
    assert {code for code, item in ties.items() if item.state == "true"} == {"600001.SH", "600002.SH"}
    assert ties["600002.SH"].actual_values["rank"] == 1
    fractional = rank(values, top_n=None, top_fraction=0.34, top_fraction_rounding="ceil")
    assert sum(item.state == "true" for item in fractional.values()) == 2
    ascending = rank(values, direction="ascending")
    assert ascending["600003.SH"].state == "true"


@pytest.mark.parametrize("missing", [None, float("nan"), float("inf"), True, [1, 2]])
def test_missing_metric_does_not_silently_shrink_strict_comparison(missing):
    values = {"600000.SH": 10, "600001.SH": missing}
    strict = rank(values)
    assert {item.state for item in strict.values()} == {"unknown"}
    assert all(item.actual_values["rank"] is None for item in strict.values())
    explicit = rank(values, missing_policy="exclude_with_notice")
    assert explicit["600000.SH"].state == "true"
    assert explicit["600001.SH"].state == "false"
    assert "排除1只" in explicit["600000.SH"].explanation


def test_unknown_population_membership_blocks_strict_ranking():
    result = rank(
        {"600000.SH": 10, "600001.SH": 5, "600002.SH": 2},
        population={"600000.SH": "unknown", "600001.SH": "true", "600002.SH": "false"},
        ranking_universe="after_filters", rank_after_filters=True,
        population_logic_tree={"op": "condition", "reference_id": "volume"},
    )
    assert [item.state for item in result.values()] == ["unknown", "unknown", "false"]
