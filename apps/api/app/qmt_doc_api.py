"""Read-only views of the bundled QMT references, handbook and examples."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from . import qmt_docs


router = APIRouter(prefix="/api/v1/qmt-docs", tags=["QMT 参考资料"])


@router.get("")
def search_qmt_docs(query: str = Query(default="", max_length=300),
                    kind: Literal["all", "official_reference", "manual", "example"] = "all",
                    offset: int = Query(default=0, ge=0, le=10000),
                    limit: int = Query(default=12, ge=1, le=12)):
    try:
        return qmt_docs.search_docs(qmt_docs.SearchQmtDocsArgs(query=query, kind=kind, offset=offset, limit=limit))
    except qmt_docs.QmtReferenceError as exc:
        raise HTTPException(503, {"code": "qmt_reference_unavailable", "message": str(exc)}) from exc


@router.get("/{doc_id}")
def read_qmt_doc(doc_id: str, offset: int = Query(default=0, ge=0, le=100000),
                 limit: int = Query(default=6000, ge=1, le=8000),
                 expected_sha256: str | None = Query(default=None, pattern=r"^[0-9a-f]{64}$")):
    from pydantic import ValidationError
    try:
        return qmt_docs.read_doc(qmt_docs.ReadQmtDocArgs(doc_id=doc_id, offset=offset, limit=limit, expected_sha256=expected_sha256))
    except ValidationError as exc:
        raise HTTPException(404, {"code": "qmt_document_not_found", "message": "找不到 QMT 资料条目。"}) from exc
    except qmt_docs.QmtReferenceError as exc:
        raise HTTPException(exc.status, {"code": "qmt_reference_error", "message": str(exc)}) from exc
