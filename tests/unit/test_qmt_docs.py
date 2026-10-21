import ast
import hashlib
import runpy
import shutil
from types import SimpleNamespace

import pytest

from apps.api.app import qmt_docs, qmt_scripts


def test_offline_search_finds_symbols_and_chinese_topics_without_network(monkeypatch):
    import requests
    monkeypatch.setattr(requests, "get", lambda *a, **k: pytest.fail("reference retrieval must be offline"))
    assert qmt_docs.search_docs(qmt_docs.SearchQmtDocsArgs(query="C.get_market_data_ex"))["items"][0]["id"] == "official-market-data"
    assert qmt_docs.search_docs(qmt_docs.SearchQmtDocsArgs(query="放量突破", kind="example"))["items"][0]["id"] == "example-volume-breakout"
    assert not qmt_docs.search_docs(qmt_docs.SearchQmtDocsArgs(query="nonexistent_xyz_1234"))["items"]
    assert qmt_docs.search_docs(qmt_docs.SearchQmtDocsArgs())["items"][0]["id"] == "strategy-handbook"


def test_pagination_reassembles_exact_document_and_records_hash():
    source = next(item for item in qmt_docs.library()["documents"] if item["id"] == "strategy-handbook")
    chunks, offset = [], 0
    while True:
        result = qmt_docs.read_doc(qmt_docs.ReadQmtDocArgs(doc_id=source["id"], offset=offset, limit=200, expected_sha256=source["sha256"]))
        chunks.append(result["text"])
        offset = result["next_offset"]
        if offset is None:
            break
    assert "".join(chunks) == source["content"]
    assert hashlib.sha256("".join(chunks).encode("utf-8")).hexdigest() == source["sha256"]


def test_modified_document_cannot_silently_keep_old_catalog_version(tmp_path, monkeypatch):
    root = tmp_path / "qmt"
    shutil.copytree(qmt_docs.REFERENCE_ROOT, root)
    monkeypatch.setattr(qmt_docs, "REFERENCE_ROOT", root)
    (root / "official" / "context.md").write_text("Changed", encoding="utf-8")
    with pytest.raises(qmt_docs.QmtReferenceError, match="版本目录不符"):
        qmt_docs.library()


def test_windows_checkout_line_endings_do_not_break_reference_identity(tmp_path, monkeypatch):
    expected = qmt_docs.library()["bundle_sha256"]
    root = tmp_path / "windows-checkout"
    shutil.copytree(qmt_docs.REFERENCE_ROOT, root)
    for path in root.rglob("*"):
        if path.is_file():
            path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
    monkeypatch.setattr(qmt_docs, "REFERENCE_ROOT", root)
    assert qmt_docs.library()["bundle_sha256"] == expected


def test_document_path_cannot_escape_the_curated_package():
    for path in ("../private.md", "C:/private.py", "official/../context.md", "official\\context.md"):
        with pytest.raises(qmt_docs.QmtReferenceError):
            qmt_docs._file(path)


class Frame:
    def __init__(self, rows):
        self.rows = rows

    def to_dict(self, orientation):
        assert orientation == "records"
        return [dict(row) for row in self.rows]


class Context:
    stockcode, market, period, barpos = "000001", "SZ", "1d", 21
    do_back_test = True

    def __init__(self, rows):
        self.rows, self.requests = rows, []

    def set_universe(self, symbols):
        assert symbols == ["000001.SZ"]

    def get_bar_timetag(self, position):
        return 22

    def get_market_data_ex(self, fields, symbols, **kwargs):
        self.requests.append(kwargs)
        return {"000001.SZ": Frame(self.rows)}


def data(down=False):
    return [{"time": i + 1, "open": 11, "close": (20 if down else 10), "high": 21 if down else 10, "volume": 100}
            for i in range(20)] + [
                {"time": 21, "open": 11, "close": 10 if down else 20, "high": 21, "volume": 200},
                {"time": 22, "open": 11, "close": 9999, "high": 9999, "volume": 9999},
            ]


def example(filename, **injected):
    path = qmt_docs.REFERENCE_ROOT / "examples" / filename
    source = path.read_text(encoding="utf-8")
    ast.parse(source, feature_version=(3, 6))
    assert qmt_scripts.inspect_script(qmt_scripts.QmtScriptArgs(code=source))[0]["valid"]
    namespace = runpy.run_path(str(path), init_globals={"timetag_to_datetime": lambda tag, fmt: str(tag), **injected})
    return namespace["handlebar"].__globals__


@pytest.mark.parametrize("filename,signal", [("ma_signal.py", "BUY_SIGNAL"), ("volume_breakout.py", "BREAKOUT_SIGNAL")])
def test_signal_examples_use_prior_completed_bar_and_emit_once(filename, signal, capsys):
    namespace = example(filename)
    context = Context(data())
    # A future row accidentally supplied by a provider cannot change the decision.
    context.rows.append({"time": 23, "close": -9999, "high": -9999, "volume": -9999})
    namespace["init"](context)
    namespace["handlebar"](context)
    namespace["handlebar"](context)
    output = capsys.readouterr().out
    assert output.count(signal) == 1
    assert "decision_time 21 observed_at 22" in output
    assert context.requests[0]["end_time"] == "22"
    assert context.requests[0]["subscribe"] is False and context.requests[0]["fill_data"] is False


@pytest.mark.parametrize("filename", ["ma_signal.py", "volume_breakout.py", "backtest_ma.py"])
def test_examples_do_not_turn_nan_or_short_history_into_signal(filename, capsys):
    namespace = example(filename)
    context = Context(data()[:10])
    namespace["init"](context)
    namespace["handlebar"](context)
    assert "insufficient" in capsys.readouterr().out
    context.rows = data()
    context.rows[-2]["close"] = float("nan")
    namespace["handlebar"](context)
    output = capsys.readouterr().out
    assert "skip" in output and "BUY_SIGNAL" not in output and "BREAKOUT_SIGNAL" not in output


def test_backtest_example_defaults_to_no_orders_and_rejects_live_or_unknown_mode(capsys):
    calls = []
    namespace = example("backtest_ma.py", passorder=lambda *a: calls.append(a),
                        get_trade_detail_data=lambda *a: pytest.fail("disabled strategy must not query accounts"))
    context = Context(data())
    namespace["init"](context)
    namespace["handlebar"](context)
    assert not calls and "orders disabled" in capsys.readouterr().out
    for mode in (False, None):
        context.do_back_test = mode
        with pytest.raises(RuntimeError, match="restricted"):
            namespace["init"](context)
        with pytest.raises(RuntimeError, match="required"):
            namespace["handlebar"](context)


@pytest.mark.parametrize("down", [False, True])
def test_backtest_example_checks_cash_or_sellable_volume_and_never_uses_current_close(down):
    orders = []
    holding = SimpleNamespace(m_strInstrumentID="000001", m_strExchangeID="SZ", m_nVolume=200, m_nCanUseVolume=100)
    def details(account, account_type, kind):
        return ([holding] if down else []) if kind == "POSITION" else [SimpleNamespace(m_dAvailable=100000)]
    namespace = example("backtest_ma.py", passorder=lambda *a: orders.append(a), get_trade_detail_data=details)
    namespace["ENABLE_BACKTEST_ORDERS"] = True
    context = Context(data(down))
    namespace["init"](context)
    namespace["handlebar"](context)
    namespace["handlebar"](context)
    assert len(orders) == 1
    assert orders[0][0] == (24 if down else 23)
    assert orders[0][1] == 1101 and orders[0][4:7] == (11, 11.0, 100)
    assert orders[0][8] == 0 and orders[0][-1] is context
