"""Run directly: python tests/isolated/pattern_research_checks.py.

Real scorer, real SQLite and endpoint functions; unavailable market IO and image
libraries are substituted before import. This is not an HTTP/application test.
"""
import contextlib
import pathlib
import sqlite3
import sys
import tempfile
import types
import unittest
from datetime import date, timedelta
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
sys.modules.setdefault("cv2", types.ModuleType("cv2"))
market_stub = types.ModuleType("apps.api.app.market")
market_stub.PRICE_BASIS = "unadjusted"
sys.modules["apps.api.app.market"] = market_stub
from apps.api.app import pattern_examples as examples, pattern_research as research
from apps.api.app.models import PatternInput
from apps.api.app.security_context import ActorContext, actor_scope
from fastapi import HTTPException

ROOT = pathlib.Path(__file__).resolve().parents[2]


class ResearchChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temp.name) / "research.db"
        @contextlib.contextmanager
        def connection():
            conn = sqlite3.connect(self.path)
            conn.row_factory = sqlite3.Row
            try:
                with conn:
                    yield conn
            finally:
                conn.close()
        self.connection = connection
        with connection() as conn:
            conn.executescript((ROOT / "apps/api/migrations/053_pattern_search_runs.sql").read_text())
            # A repeated migration is safe and preserves saved records.
            conn.executescript((ROOT / "apps/api/migrations/053_pattern_search_runs.sql").read_text())
            conn.execute("CREATE TABLE pattern_examples(cache_key TEXT PRIMARY KEY,result_json TEXT)")
        self.patchers = [patch.object(examples, "connect", connection), patch.object(research, "connect", connection),
                        patch.object(market_stub, "source_fingerprint", lambda: ("private/path", 42, 1), create=True),
                        patch.object(market_stub, "latest_market_date", lambda as_of: as_of, create=True)]
        for p in self.patchers:
            p.start()
        self.template = {"name": "test", "input_type": "drawing", "representation": "price_path", "target_bars": 10,
                         "points": list(range(10)), "algorithm_version": "path-window-v2", "params": {"min_similarity": 99}}
        self.rows = [{"trade_date": (date(2026, 1, 1) + timedelta(days=i)).isoformat(), "open": i + 1., "high": i + 3.,
                      "low": i + .5, "close": i + 2., "quality_valid": True} for i in range(20)]

    def tearDown(self):
        for p in self.patchers[::-1]:
            p.stop()
        self.temp.cleanup()

    def scan(self, rows=None, cutoff="2026-01-15", template=None):
        with patch.object(market_stub, "iter_recent_bars", lambda *args: iter([("600000.SH", self.rows if rows is None else rows)]), create=True):
            return examples.find_example(template or self.template, limit=12, as_of=cutoff)

    def test_future_cutoff_rejected_and_future_bars_removed(self):
        with self.assertRaises(ValueError):
            self.scan(cutoff="2999-01-01")
        with self.assertRaises(ValueError):
            self.scan(cutoff="not-a-date")
        result = self.scan()
        self.assertEqual(result["items"][0]["end_date"], "2026-01-15")
        self.assertTrue(all(bar["trade_date"] <= result["as_of"] for item in result["items"] for bar in item["bars"]))
        self.assertNotIn("private/path", result["source_fingerprint"])
        self.assertEqual(result["template_timing"], "unknown")
        self.assertEqual(result["price_basis"], "unadjusted")
        self.assertIn("distance_components", result["items"][0])

    def test_missing_and_invalid_data_preserve_coverage(self):
        result = self.scan(rows=self.rows[:3])
        self.assertEqual((result["scanned_securities"], result["valid_securities"]), (1, 0))
        self.assertEqual(result["state"], "unknown")
        with patch.object(market_stub, "source_fingerprint", lambda: None):
            result = self.scan()
            self.assertEqual(result["items"], [])
            self.assertEqual(result["requested_as_of"], "2026-01-15")

    def test_historical_template_warning_and_source_exclusion(self):
        template = {**self.template, "market_source": {"stock_code": "600001.SH", "end_date": "2026-01-16"}}
        self.assertEqual(self.scan(template=template)["template_timing"], "post_hoc")
        template["market_source"]["end_date"] = "2026-01-14"
        self.assertEqual(self.scan(template=template)["template_timing"], "verified")
        template["market_source"]["stock_code"] = "600000.SH"
        self.assertEqual(self.scan(template=template)["items"], [])

    def test_age_is_relative_to_loaded_cutoff_not_window_tail(self):
        rows = [dict(row) for row in self.rows]
        for row in rows[10:]:
            row["close"] = 100 - rows.index(row) if row in rows else 100
        result = self.scan(rows=rows)
        candidate = result["items"][0]
        self.assertGreater(candidate["match_age_bars"], 0)
        self.assertEqual(candidate["match_age_bars"], sum(candidate["end_date"] < row["trade_date"] <= result["as_of"] for row in rows))
        self.assertFalse(candidate["is_current"])

    def test_cache_does_not_confuse_requested_days(self):
        with patch.object(market_stub, "latest_market_date", lambda day: "2026-01-15"):
            first = self.scan(cutoff="2026-01-16")
            second = self.scan(cutoff="2026-01-17")
            self.assertEqual(first["items"], second["items"])
            self.assertEqual(second["requested_as_of"], "2026-01-17")

    def test_record_immutable_result_and_annotations_isolated_by_actor(self):
        owner = ActorContext("a", "tenant", legacy=True)
        other = ActorContext("b", "tenant", legacy=True)
        with actor_scope(owner):
            result = self.scan()
            saved = research.save_search(self.template, result, {"limit": 12})
            identifier = saved["search_run_id"]
            key = result["items"][0]["stock_code"] + "@" + result["items"][0]["start_date"]
            updated = research.annotate_search_run(identifier, research.SearchAnnotation(note="研究备注", selected_key=key))
            self.assertEqual(updated["result"]["items"], result["items"])
            self.assertEqual(updated["note"], "研究备注")
            with self.assertRaises(HTTPException) as error:
                research.annotate_search_run(identifier, research.SearchAnnotation(selected_key="fake@date"))
            self.assertEqual(error.exception.status_code, 422)
        with actor_scope(other):
            self.assertEqual(research.list_search_runs()["items"], [])
            with self.assertRaises(HTTPException) as error:
                research.get_search_run(identifier)
            self.assertEqual(error.exception.status_code, 404)
            with self.assertRaises(HTTPException):
                research.annotate_search_run(identifier, research.SearchAnnotation(note="overwrite"))
        with actor_scope(owner):
            self.assertEqual(research.get_search_run(identifier)["note"], "研究备注")
            self.assertEqual(len(research.list_search_runs()["items"]), 1)

    def test_viewer_never_writes_and_empty_record_still_saved(self):
        with actor_scope(ActorContext("reader", "t", role="viewer", legacy=True)):
            self.assertIsNone(research.save_search(self.template, {}, {})["search_run_id"])
            self.assertEqual(research.list_search_runs()["items"], [])
        with actor_scope(ActorContext("a", "t", legacy=True)):
            saved = research.save_search(self.template, {"items": []}, {})
            self.assertEqual(research.get_search_run(saved["search_run_id"])["result"]["items"], [])

    def test_old_input_default_note_and_note_limit(self):
        payload = {key: value for key, value in self.template.items() if key != "algorithm_version"}
        self.assertEqual(PatternInput(**payload).note, "")
        with self.assertRaises(ValueError):
            PatternInput(**payload, note="x" * 4001)


if __name__ == "__main__":
    unittest.main(verbosity=2)
