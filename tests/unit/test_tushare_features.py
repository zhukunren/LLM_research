from datetime import date, datetime

from apps.api.app import tushare_company_features as company
from apps.api.app import tushare_feature_rules as rules
from apps.api.app import tushare_market_features as market
from apps.api.app import tushare_observation_events as observation
from apps.api.app.screening_contracts import ChipConcentrationRule, EarningsRevisionRule
from apps.api.app.tushare_feature_data import SHANGHAI


def test_revisions_use_only_available_estimates_and_unique_brokers():
    def forecast(day, eps, broker="甲券商", updated=None, period="2026Q4"):
        return {"ts_code": "600519.SH", "quarter": period, "report_date": day,
                "org_name": broker, "eps": eps, "create_time": updated or f"{day[:4]}-{day[4:6]}-{day[6:]} 21:15:00"}

    class Reader:
        def read(self, *_args, **_params):
            return [
                forecast("20261001", 10), forecast("20261115", 11), forecast("20261115", 11),
                forecast("20261119", 8, updated="2026-11-21 09:15:00"),
                forecast("20261119", 2, period="2026Q3"),
                forecast("20261117", 7, broker="乙券商"),
            ]

    day = date(2026, 11, 20)
    cutoff = datetime(2026, 11, 20, 23, 59, tzinfo=SHANGHAI)
    rows = company.estimates(Reader(), date(2026, 9, 1), cutoff, {"600519.SH"})
    stats = company.revisions(rows, 2026, day, 30)
    assert (stats["brokers"], stats["comparable_brokers"], stats["up"], stats["down"]) == (2, 1, 1, 0)
    assert stats["consensus_eps"] == 9
    result = rules.evaluate(EarningsRevisionRule(year_offset=0, window_days=30, minimum_brokers=1),
                            rules.Inputs(day, day, earnings={"600519.SH": rows}), "600519.SH",
                            condition_id="earnings", reference_id="earnings-ref")
    assert result.state == "true"
    assert result.actual_values["上调预测的券商"] == 1


def test_chip_screen_uses_actual_costs_and_missing_is_unknown():
    rule = ChipConcentrationRule(max_spread_pct=20)
    day = date(2025, 11, 18)
    supplied = rules.Inputs(day, day, chips={"600519.SH": {"cost_5pct": 90, "cost_50pct": 100, "cost_95pct": 110}})
    result = rules.evaluate(rule, supplied, "600519.SH", condition_id="chips", reference_id="chip-ref")
    assert result.state == "true"
    assert result.actual_values["筹码成本区间宽度"] == 20
    unknown = rules.evaluate(rule, supplied, "000001.SZ", condition_id="chips", reference_id="chip-ref")
    assert unknown.state == "unknown"


def test_etf_uses_adjacent_session_and_keeps_unknown_prior_shares():
    class Reader:
        def days(self, *_args, **_params):
            return [date(2025, 11, 17), date(2025, 11, 18)]

        def sources(self):
            return []

        def read(self, endpoint, **params):
            if endpoint == "etf_basic":
                return [{"ts_code": "510300.SH", "extname": "沪深300ETF", "list_date": "20200101",
                         "index_code": "000300.SH", "index_name": "沪深300"}]
            if endpoint == "fund_daily":
                return [
                    {"ts_code": "510300.SH", "trade_date": "20251118", "amount": 100_000},
                    {"ts_code": "158008.OF", "trade_date": "20251118", "amount": 100},
                ]
            if params["trade_date"] == "20251117":
                return [{"ts_code": "510300.SH", "trade_date": "20251117", "etf_name": "ETF",
                         "total_size": 10_000, "total_share": 100}]
            return [
                {"ts_code": "510300.SH", "trade_date": "20251118", "etf_name": "ETF", "total_size": 12_000, "total_share": 105},
                {"ts_code": "510310.SH", "trade_date": "20251118", "etf_name": "ETF", "total_size": 8_000, "total_share": 90},
            ]

    response = market.etf_peers(Reader(), date(2025, 11, 18))
    assert response["previous_date"] == "2025-11-17"
    first, second = response["items"]
    assert (first["share_change_pct"], first["share_change_wan"], first["size_yi"], first["amount_yi"]) == (5, 5, 1.2, 1)
    assert second["share_change_pct"] is None


def test_observation_unlock_requires_announcement_by_cutoff_and_deduplicates_holders():
    class Reader:
        def read(self, *_args, **params):
            base = {"ts_code": "600519.SH", "float_date": params["float_date"], "float_share": 100, "float_ratio": 1}
            known = {**base, "ann_date": "20251110", "holder_name": "甲"}
            return [known, known, {**base, "ann_date": "20251120", "holder_name": "乙"}]

    events = observation._unlock_events(Reader(), date(2025, 11, 21), date(2025, 11, 18), {"600519.SH"})
    assert len(events) == 1
    assert (events[0]["shares"], events[0]["shareholders"], events[0]["ann_date"]) == (100, 1, "2025-11-10")


def test_closing_rotation_respects_frozen_cutoff():
    result = market.rotation(None, date(2026, 11, 20), cutoff=datetime(2026, 11, 20, 15, 10, tzinfo=SHANGHAI))
    assert result["trade_date"] is None
    assert result["issues"][0]["label"] == "盘面数据"
