"""Report discovery must preserve provenance and historical screening boundaries."""

from contextlib import contextmanager
from dataclasses import replace
from datetime import date
import hashlib
from io import BytesIO
import math
from pathlib import Path
import shutil

from fastapi.testclient import TestClient
from pypdf import PdfWriter
import pytest

from apps.api.app import db, documents, main, report_catalog, research_tools
from apps.api.app.report_parser import ParsedReport
from apps.api.app.screening_tools import (
    SearchReportPagesArgs,
    ToolContext,
    _search_report_pages,
)


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "reports.db")
    db.init_db()


def add_report(
    report_id: str,
    pages: list[str],
    *,
    stock_code: str | None = "600000.SH",
    binding: str = "confirmed",
    available: str | None = "2026-09-10",
    availability: str = "confirmed",
    published: str | None = None,
    title: str | None = None,
) -> None:
    with db.connect() as connection:
        connection.execute(
            """INSERT INTO documents(
                id,sha256,filename,title,publication_date,market,stock_code,pages,
                extracted_chars,parse_status,source_path,imported_at,
                stock_code_status,available_at,available_at_status)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                report_id,
                f"sha-{report_id}",
                f"{report_id}.pdf",
                title or report_id,
                published or available,
                "SH",
                stock_code,
                len(pages),
                sum(map(len, pages)),
                "indexed",
                "synthetic",
                db.utc_now(),
                binding,
                available,
                availability,
            ),
        )
        connection.executemany(
            "INSERT INTO document_pages(document_id,page_number,text) VALUES(?,?,?)",
            [(report_id, number, text) for number, text in enumerate(pages, 1)],
        )


def context(**changes) -> ToolContext:
    base = ToolContext(
        conversation_id="retrieval-test",
        turn_id="retrieval-turn",
        task_revision=0,
        as_of="2026-09-14",
        universe_kind="explicit",
        stock_codes=frozenset({"600000.SH"}),
        report_lookback_calendar_days=30,
    )
    return replace(base, **changes)


def test_chinese_and_width_normalization_keeps_original_page_and_excerpt(library):
    raw = "背景说明。" * 140 + "ＡＩ 芯\n片采用高速\n连接器支持ＧＰＵ。"
    add_report("normalized", [raw])

    result = documents.search("AI，芯片；高速连接器 GPU", mode="exact")
    assert result["total"] == 1
    assert set(result["query_terms"]) == {"ai", "芯片", "高速连接器", "gpu"}
    hit = result["items"][0]
    assert hit["document_id"] == "normalized"
    assert hit["page_number"] == 1
    assert hit["match_type"] == "normalized_same_page_keyword"
    assert set(hit["matched_terms"]) == {"ai", "芯片", "高速连接器", "gpu"}
    assert hit["source_sha256"] == "sha-normalized"
    assert hit["semantic_support_verified"] is False
    assert math.isfinite(hit["relevance_score"])
    assert "ＡＩ 芯\n片" in hit["snippet"]
    assert "高速\n连接器" in hit["snippet"]
    page = documents.read_page("normalized", 1, max_chars=None)
    assert page["text"] == raw


def test_normalized_combining_character_hit_is_located_in_original_excerpt(library):
    raw = "背景说明。" * 140 + "Cafe\u0301 开始新增产能。"
    add_report("combining", [raw])
    hit = documents.search_pages("café")[0]
    assert "Cafe\u0301" in hit["snippet"]
    assert documents.read_page("combining", 1, max_chars=None)["text"] == raw


def test_long_chinese_phrase_uses_trigram_index_and_short_terms_still_work(library):
    add_report("one", ["高速连接器订单增长，铜价格稳定。"])
    add_report("two", ["订单增长。", "营业收入增长。"])
    add_report("three", ["订单与营业收入均增长。"])

    long_hits = documents.search_pages("高速连接器")
    assert [hit["document_id"] for hit in long_hits] == ["one"]
    assert "fts5" in long_hits[0]["retrieval_method"]
    assert {hit["document_id"] for hit in documents.search_pages("订单")} == {
        "one", "two", "three"
    }
    assert [hit["document_id"] for hit in documents.search_pages("铜")] == ["one"]
    assert [hit["document_id"] for hit in documents.search_pages("订单 营业收入")] == ["three"]
    assert documents.search_pages(" ，； \n ") == []


def test_exact_mode_treats_fts_operators_as_text_and_keeps_latin_word_spaces(library):
    add_report("literal", ['研发记录为 "alpha" OR beta，machine learning。'])
    add_report("other", ["只有 beta，machinelearning。"])
    assert [hit["document_id"] for hit in documents.search_pages("OR")] == ["literal"]
    assert [hit["document_id"] for hit in documents.search_pages("machinelearning")] == ["other"]
    assert documents.search_pages("不存在*词") == []


def test_smart_related_word_discovery_is_explicit_and_does_not_claim_semantic_support(library):
    add_report("synonym", ["公司营收同比增长，但本段未核验其原因。"])
    assert documents.search_pages("营业收入", mode="exact") == []

    result = documents.search("营业收入", mode="smart")
    assert [hit["document_id"] for hit in result["items"]] == ["synonym"]
    assert result["mode"] == "smart"
    assert result["expanded_terms"]
    hit = result["items"][0]
    assert hit["expanded_terms"]
    assert hit["exact_query_match"] is False
    assert hit["semantic_support_verified"] is False
    assert math.isfinite(hit["relevance_score"])
    assert result["coverage_note"]


def test_index_tracks_page_inserts_updates_deletes_without_manual_fts_writes(library):
    add_report("mutable", ["高速连接器需求增加。"])
    assert len(documents.search_pages("高速连接器")) == 1
    with db.connect() as connection:
        connection.execute(
            "UPDATE document_pages SET text=? WHERE document_id=? AND page_number=1",
            ("先进封装产能增加。", "mutable"),
        )
    assert documents.search_pages("高速连接器") == []
    assert len(documents.search_pages("先进封装")) == 1
    with db.connect() as connection:
        connection.execute("DELETE FROM documents WHERE id=?", ("mutable",))
    assert documents.search_pages("先进封装") == []


@pytest.mark.parametrize("mode", ["exact", "smart"])
def test_historical_security_and_source_filters_apply_before_limit(library, mode):
    for report_id, options in [
        ("future", {"available": "2026-09-15"}),
        ("unconfirmed-date", {"availability": "filename_candidate"}),
        ("missing-date", {"available": None}),
        ("other-stock", {"stock_code": "600001.SH"}),
        ("unbound", {"stock_code": None, "binding": "filename_candidate"}),
        ("candidate-binding", {"binding": "filename_candidate"}),
        ("old", {"available": "2025-01-01"}),
        ("outside-source", {}),
    ]:
        add_report(report_id, ["高速连接器" * 8], **options)
    add_report("eligible", ["高速连接器"], available="2026-09-14")

    result = documents.search(
        "高速连接器",
        as_of="2026-09-14",
        stock_code="600000.SH",
        limit=1,
        mode=mode,
        allowed_source_ids=frozenset({"eligible", "candidate-binding", "old"}),
        confirmed_security_only=True,
        available_after="2026-08-15",
    )
    assert result["total"] == 1
    assert [hit["document_id"] for hit in result["items"]] == ["eligible"]
    assert result["next_offset"] is None
    hit = result["items"][0]
    assert hit["available_at"] == "2026-09-14"
    assert hit["availability_status"] == "confirmed"
    assert hit["security_binding_status"] == "confirmed"


def test_screening_search_limits_after_frozen_scope_and_lookback(library):
    for number in range(35):
        add_report(f"outside-{number}", ["高速连接器" * 8])
    add_report("old", ["高速连接器" * 8], available="2025-01-01")
    add_report("candidate", ["高速连接器" * 8], binding="filename_candidate")
    add_report("allowed", ["高速连接器产能增加。"], available="2026-09-09")

    result = _search_report_pages(
        SearchReportPagesArgs(query="高速连接器", stock_code=None, limit=1),
        context(allowed_document_ids=frozenset({"allowed", "old", "candidate"})),
    )
    assert [hit["document_id"] for hit in result["items"]] == ["allowed"]
    assert result["as_of"] == "2026-09-14"
    assert result["items"][0]["semantic_support_verified"] is False


def test_pagination_is_stable_and_preserves_total_and_provenance(library):
    for number in range(3):
        add_report(f"report-{number}", ["高速连接器产能提升。"])

    first = documents.search("高速连接器", mode="exact", limit=1)
    second = documents.search("高速连接器", mode="exact", limit=1, offset=first["next_offset"])
    third = documents.search("高速连接器", mode="exact", limit=1, offset=second["next_offset"])
    assert first["total"] == second["total"] == third["total"] == 3
    assert len({page["items"][0]["document_id"] for page in [first, second, third]}) == 3
    assert first["offset"] == 0 and third["next_offset"] is None
    assert documents.search("高速连接器", mode="exact", limit=1) == first
    assert documents.search("高速连接器", mode="exact", offset=3)["items"] == []


def test_count_and_page_share_a_snapshot_when_another_connection_imports(library, monkeypatch):
    add_report("initial", ["高速连接器需求。"])
    original_connect = db.connect
    inserted = False

    @contextmanager
    def interleaved_connect():
        with original_connect() as connection:
            def insert_between_reads(sql):
                nonlocal inserted
                if not inserted and "SELECT d.id,d.filename,d.title" in sql:
                    inserted = True
                    add_report("concurrent", ["高速连接器需求。"])

            connection.set_trace_callback(insert_between_reads)
            yield connection

    monkeypatch.setattr(db, "connect", interleaved_connect)
    response = documents.search("高速连接器", mode="exact", limit=100)
    assert inserted is True
    assert response["total"] == len(response["items"]) == 1
    assert response["items"][0]["document_id"] == "initial"
    assert documents.search("高速连接器", mode="exact")["total"] == 2


def test_api_exposes_search_metadata_and_rejects_invalid_filters(library):
    add_report("api-report", ["高速连接器需求增加。"])
    with TestClient(main.app) as client:
        response = client.post("/api/v1/documents/search", json={
            "query": "高速连接器", "mode": "exact", "as_of": "2026-09-14",
            "stock_code": "600000.SH", "limit": 1, "offset": 0,
        })
        assert response.status_code == 200
        result = response.json()
        assert result["total"] == 1 and result["next_offset"] is None
        assert result["query_terms"] == ["高速连接器"]
        assert result["items"][0]["source_sha256"] == "sha-api-report"
        assert result["items"][0]["semantic_support_verified"] is False
        for update in [
            {"as_of": "2026-02-30"}, {"stock_code": "600000"},
            {"mode": "semantic_verified"}, {"offset": -1}, {"limit": 0},
        ]:
            assert client.post("/api/v1/documents/search", json={
                "query": "高速连接器", **update,
            }).status_code == 422


def test_research_catalog_deduplicates_pages_before_counting_and_paging(library):
    add_report("many-pages", ["高速连接器需求。", "高速连接器产能。"])
    add_report("one-page", ["高速连接器需求。"])
    add_report("future", ["高速连接器需求。"], available="2026-09-15")
    add_report("other-stock", ["高速连接器需求。"], stock_code="600001.SH")
    add_report("unbound", ["高速连接器需求。"], stock_code=None, binding="filename_candidate")

    def search(offset):
        return research_tools.search_sources(
            research_tools.SearchSourcesArgs(
                kind="report", query="高速连接器", stock_code="600000.SH",
                as_of=date(2026, 9, 14), offset=offset, limit=1,
            ),
            context(),
        )

    first, second = search(0), search(1)
    assert first["total"] == second["total"] == 2
    assert {first["items"][0]["id"], second["items"][0]["id"]} == {
        "many-pages", "one-page"
    }
    assert search(2)["items"] == []
    without_cutoff = research_tools.search_sources(
        research_tools.SearchSourcesArgs(
            kind="report", query="高速连接器", stock_code="600000.SH",
            as_of=None, offset=0, limit=100,
        ),
        context(),
    )
    assert {item["id"] for item in without_cutoff["items"]} == {
        "many-pages", "one-page", "future"
    }


def test_upgrade_backfills_existing_pages_and_is_repeatable(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "legacy.db")
    migrations = Path(db.MIGRATIONS_DIR)
    legacy_migrations = tmp_path / "legacy-migrations"
    legacy_migrations.mkdir()
    for migration in migrations.glob("*.sql"):
        if migration.name < "026":
            shutil.copyfile(migration, legacy_migrations / migration.name)
    monkeypatch.setattr(db, "MIGRATIONS_DIR", legacy_migrations)
    db.init_db()
    add_report("legacy", ["高速\n连接器需求增加。"])

    monkeypatch.setattr(db, "MIGRATIONS_DIR", migrations)
    db.init_db()
    first = documents.search_pages("高速连接器")
    db.init_db()
    assert documents.search_pages("高速连接器") == first
    assert len(first) == 1 and first[0]["document_id"] == "legacy"
    assert "fts5" in first[0]["retrieval_method"]
    assert documents.read_page("legacy", 1, max_chars=None)["text"] == "高速\n连接器需求增加。"


def test_failed_page_write_rolls_back_source_and_indexes_then_retry_is_idempotent(library, tmp_path, monkeypatch):
    report_root = tmp_path / "local-reports"
    report_root.mkdir()
    (report_root / "rollback.pdf").write_bytes(b"%PDF-1.7\nsynthetic")
    monkeypatch.setattr(documents, "REPORT_DIR", report_root)
    monkeypatch.setattr(documents, "REPORT_UPLOAD_DIR", tmp_path / "no-uploads")
    monkeypatch.setattr(report_catalog, "enqueue", lambda: None)
    monkeypatch.setattr(documents, "parse_report", lambda *args, **kwargs: ParsedReport(
        ["高速连接器需求。", "先进封装产能。"], {"backend": "test"},
    ))
    with db.connect() as connection:
        connection.execute("""CREATE TRIGGER fail_second_page BEFORE INSERT ON document_pages
            WHEN new.page_number=2 BEGIN SELECT RAISE(ABORT,'forced page failure'); END""")

    failed = documents.import_local_reports()
    assert failed["imported"] == 0 and failed["failed"] == 1
    assert "forced page failure" in failed["results"][0]["reason"]
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM document_pages").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM document_pages_search").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM document_pages_fts").fetchone()[0] == 0
        connection.execute("DROP TRIGGER fail_second_page")

    retried = documents.import_local_reports()
    duplicate = documents.import_local_reports()
    assert retried["imported"] == 1 and retried["failed"] == 0
    assert duplicate["imported"] == 0 and duplicate["failed"] == 0
    assert duplicate["results"][0]["status"] == "already_imported"
    assert duplicate["results"][0]["id"] == retried["results"][0]["id"]
    assert len(documents.search_pages("高速连接器")) == 1
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM document_pages").fetchone()[0] == 2


def test_same_filename_upload_returns_the_document_for_the_uploaded_content(library, tmp_path, monkeypatch):
    upload_root = tmp_path / "uploads"
    monkeypatch.setattr(main, "REPORT_UPLOAD_DIR", upload_root)
    monkeypatch.setattr(documents, "REPORT_UPLOAD_DIR", upload_root)
    monkeypatch.setattr(documents, "REPORT_DIR", tmp_path / "no-local-reports")
    monkeypatch.setattr(report_catalog, "enqueue", lambda: None)
    monkeypatch.setattr(documents, "parse_report", lambda *args, **kwargs: ParsedReport(
        ["高速连接器需求。"], {"backend": "test"},
    ))

    def pdf_bytes(title):
        output = BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=72, height=72)
        writer.add_metadata({"/Title": title})
        writer.write(output)
        return output.getvalue()

    first_data, second_data = pdf_bytes("first"), pdf_bytes("second")
    with TestClient(main.app) as client:
        names = iter(range(100))
        monkeypatch.setattr(main, "uuid4", lambda: f"upload-{next(names):04d}")
        first = client.post("/api/v1/documents/upload", files={
            "file": ("same.pdf", first_data, "application/pdf"),
        })
        second = client.post("/api/v1/documents/upload", files={
            "file": ("same.pdf", second_data, "application/pdf"),
        })
        repeat = client.post("/api/v1/documents/upload", files={
            "file": ("same.pdf", second_data, "application/pdf"),
        })
    assert first.status_code == second.status_code == repeat.status_code == 200
    first_result, second_result, repeat_result = (
        response.json()["result"] for response in [first, second, repeat]
    )
    assert second_result["id"] != first_result["id"]
    assert second_result["sha256"] == hashlib.sha256(second_data).hexdigest()
    assert repeat_result["id"] == second_result["id"]
    assert repeat_result["status"] == "already_imported"
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 2


def test_upload_reports_the_selected_file_parser_failure(library, tmp_path, monkeypatch):
    upload_root = tmp_path / "uploads"
    monkeypatch.setattr(main, "REPORT_UPLOAD_DIR", upload_root)
    monkeypatch.setattr(documents, "REPORT_UPLOAD_DIR", upload_root)
    monkeypatch.setattr(documents, "REPORT_DIR", tmp_path / "no-local-reports")
    monkeypatch.setattr(report_catalog, "enqueue", lambda: None)

    def unavailable_parser(*args, **kwargs):
        raise ValueError("selected parser unavailable")

    monkeypatch.setattr(documents, "parse_report", unavailable_parser)
    data = b"%PDF-1.7\nsynthetic-parser-failure"
    with TestClient(main.app) as client:
        response = client.post("/api/v1/documents/upload", files={
            "file": ("failure.pdf", data, "application/pdf"),
        })
    assert response.status_code == 200
    result = response.json()["result"]
    assert result["filename"] == "failure.pdf"
    assert result["sha256"] == hashlib.sha256(data).hexdigest()
    assert result["status"] == "failed"
    assert "selected parser unavailable" in result["reason"]
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
