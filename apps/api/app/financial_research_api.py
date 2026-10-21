from datetime import date
from typing import Literal
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import Field, ValidationError
from .screening_contracts import ContractModel
from . import financial_evidence, financial_metrics, financial_research, disclosures, documents
from . import research_projects

router = APIRouter(prefix="/api/v1", tags=["财务研究依据"])


def _call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except (financial_evidence.EvidenceError, disclosures.DisclosureError) as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except research_projects.ProjectError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except financial_metrics.CalculationChanged as exc:
        raise HTTPException(409, str(exc)) from exc
    except documents.DocumentIntegrityError as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "保存的原始文件不可用") from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/financial-facts/{fact_id}/original-evidence")
def original_links(fact_id: str, as_of: date | None = None, mode: Literal["as_of", "latest"] = "latest"):
    return {"items": financial_evidence.links(fact_id, as_of=as_of.isoformat() if as_of else None, mode=mode)}


@router.post("/financial-facts/{fact_id}/original-evidence")
def create_link(fact_id: str, payload: financial_evidence.LinkRequest):
    return _call(financial_evidence.link, fact_id, payload)


class FinancialCitationRequest(ContractModel):
    query: financial_metrics.FinancialQuery
    expected_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    metric: str = Field(max_length=100)
    period: date


@router.post("/research-evidence/financial")
def freeze_financial(payload: FinancialCitationRequest):
    def operation():
        result = financial_metrics.freeze(payload.query, expected_id=payload.expected_id)
        return financial_evidence.financial(result["calculation_id"], payload.metric, payload.period.isoformat())
    return _call(operation)


@router.get("/research-evidence/{evidence_id}")
def read_evidence(evidence_id: str):
    return _call(financial_evidence.read, evidence_id)


@router.get("/research-evidence/{evidence_id}/view", response_class=HTMLResponse)
def view_evidence(evidence_id: str):
    return HTMLResponse(_call(financial_evidence.view, evidence_id), headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/research-evidence/{evidence_id}/pdf")
def evidence_pdf(evidence_id: str, link_id: str | None = None):
    return FileResponse(_call(financial_evidence.pdf_path, evidence_id, link_id), media_type="application/pdf")


@router.get("/financial-data/compare")
def compare_financials(stock_codes: str, as_of: date, start_year: int | None = None, basis: str = "annual",
                       mode: str = "as_of", metrics: str = "revenue,parent_net_profit,operating_cashflow,assets",
                       project_id: str | None = None):
    try:
        request = financial_research.ComparisonRequest(stock_codes=stock_codes.split(","), as_of=as_of,
            start_year=start_year, basis=basis, mode=mode, metrics=metrics.split(","), project_id=project_id)
    except ValidationError as exc:
        raise HTTPException(422, "比较范围或指标无效") from exc
    return _call(financial_research.compare, request)


@router.get("/financial-data/comparisons")
def list_comparisons(project_id: str | None = None):
    from .db import connect
    import json
    with connect() as connection:
        if project_id:
            _call(research_projects._require_project, connection, project_id)
        rows = connection.execute("SELECT id,request_json,created_at FROM financial_comparisons WHERE project_id IS ? ORDER BY rowid DESC LIMIT 30", (project_id,)).fetchall()
    return {"items": [{"id": row["id"], "request": json.loads(row["request_json"]), "created_at": row["created_at"]} for row in rows]}


class SavedPoint(ContractModel):
    metric: str = Field(min_length=1, max_length=100)
    period: date


@router.post("/financial-data/calculations/{calculation_id}/evidence")
def saved_point(calculation_id: str, payload: SavedPoint):
    financial_evidence.writable()
    return _call(financial_evidence.financial, calculation_id, payload.metric, payload.period.isoformat())


@router.post("/financial-data/comparisons/preview")
def preview_compare(payload: financial_research.ComparisonRequest):
    return _call(financial_research.compare, payload)


@router.post("/financial-data/comparisons")
def save_compare(payload: financial_research.ComparisonRequest, expected_id: str | None = Query(None, pattern=r"^[a-f0-9]{64}$")):
    return _call(financial_research.save_comparison, payload, expected_id)


@router.get("/financial-data/comparisons/{comparison_id}")
def read_compare(comparison_id: str):
    return _call(financial_research.read_comparison, comparison_id)
