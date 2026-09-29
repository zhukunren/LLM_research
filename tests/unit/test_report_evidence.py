from apps.api.app import report_evidence


def test_report_evidence_requires_a_quote_that_exists_on_the_cited_page(monkeypatch) -> None:
    criteria = [{"id": "fundamental_improvement", "label": "基本面改善"}]
    pages = [{"page": 2, "text": "公司本期毛利率同比提升 4.2 个百分点，订单保持增长。"}]
    monkeypatch.setattr(report_evidence, "_completion", lambda *_: {
        "subject_name": "示例公司",
        "criteria_results": [{
            "criterion_id": "fundamental_improvement", "state": "true", "summary": "经营指标有所改善",
            "evidence": [{"page": 2, "quote": "本期毛利率同比提升 4.2 个百分点", "evidence_type": "reported_fact", "period": "本期", "claim": "毛利率提升"}],
        }],
    })
    result = report_evidence.evaluate_report(criteria, "all", pages)
    assert result["state"] == "true"
    assert result["criteria"][0]["evidence"][0]["page"] == 2
    assert result["coverage"]["complete"] is True


def test_unverifiable_quote_cannot_produce_true(monkeypatch) -> None:
    criteria = [{"id": "industry_improvement", "label": "行业改善"}]
    monkeypatch.setattr(report_evidence, "_completion", lambda *_: {
        "criteria_results": [{
            "criterion_id": "industry_improvement", "state": "true", "summary": "改善",
            "evidence": [{"page": 1, "quote": "本报告没有的原文内容", "evidence_type": "reported_fact", "period": None, "claim": "行业改善"}],
        }],
    })
    result = report_evidence.evaluate_report(criteria, "all", [{"page": 1, "text": "行业需求稳定。"}])
    assert result["state"] == "unknown"
    assert result["criteria"][0]["evidence"] == []


def test_false_requires_explicit_counter_evidence(monkeypatch) -> None:
    criteria = [{"id": "fundamental_improvement", "label": "基本面改善"}]
    monkeypatch.setattr(report_evidence, "_completion", lambda *_: {
        "criteria_results": [{
            "criterion_id": "fundamental_improvement", "state": "false", "summary": "没有改善",
            "evidence": [{"page": 1, "quote": "公司收入同比持平，利润率稳定。", "evidence_type": "reported_fact", "period": "本期", "claim": "指标持平"}],
        }],
    })
    result = report_evidence.evaluate_report(criteria, "all", [{"page": 1, "text": "公司收入同比持平，利润率稳定。"}])
    assert result["state"] == "unknown"
    assert "反向证据" in result["criteria"][0]["summary"]


def test_false_is_downgraded_when_report_coverage_is_incomplete(monkeypatch) -> None:
    criteria = [{"id": "industry_improvement", "label": "行业改善"}]
    monkeypatch.setattr(report_evidence, "_completion", lambda *_: {
        "criteria_results": [{
            "criterion_id": "industry_improvement", "state": "false", "summary": "行业需求下滑",
            "evidence": [{"page": 1, "quote": "行业订单同比下降 30%", "evidence_type": "counter_evidence", "period": "本期", "claim": "订单下降"}],
        }],
    })
    result = report_evidence.evaluate_report(criteria, "all", [
        {"page": 1, "text": "行业订单同比下降 30%。"}, {"page": 2, "text": ""},
    ])
    assert result["state"] == "unknown"
    assert result["criteria"][0]["state"] == "unknown"
