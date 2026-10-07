from datetime import date

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import ValidationError

from . import news_sources
from . import news_library
from .news_companies import chart_companies
from .model_client import ModelRequestError

router = APIRouter(prefix="/api/v1/news", tags=["本地资讯"])


def _error(exc: news_sources.NewsError):
    raise HTTPException(exc.status, {"code": exc.code, "message": str(exc)}) from exc


@router.get("")
def browse_news(query: str = Query(default="", max_length=300), stock_code: str | None = None,
                start_date: date | None = None, end_date: date | None = None,
                offset: int = Query(default=0, ge=0), limit: int = Query(default=30, ge=1, le=50)):
    try:
        return news_sources.browse(query=query, stock_code=stock_code, start_date=start_date,
                                   end_date=end_date, offset=offset, limit=limit)
    except news_sources.NewsError as exc:
        _error(exc)


@router.post("/import", status_code=201)
def import_news(request: news_sources.NewsImport):
    try:
        return news_sources.import_items(request)
    except news_sources.NewsError as exc:
        _error(exc)


@router.post("/import-url", status_code=201)
def import_news_url(request: news_library.UrlImport):
    try:
        return news_library.import_url(request)
    except news_sources.NewsError as exc:
        _error(exc)
    except ModelRequestError as exc:
        raise HTTPException(502, {"message": str(exc), "code": "news_model_failed"}) from exc


@router.post("/import-text", status_code=201)
def import_news_text(request_id: str, title: str, source: str,
                     text: str = Body(media_type="text/plain"), stock_codes: str = "",
                     published_at: str | None = None, available_at: str | None = None):
    try:
        request = news_sources.NewsImport(request_id=request_id, items=[news_sources.NewsItemInput(
            title=title, body=text, source=source, stock_codes=[item.strip() for item in stock_codes.split(",") if item.strip()],
            published_at=published_at, available_at=available_at,
        )])
        return news_sources.import_items(request)
    except ValidationError as exc:
        raise HTTPException(422, {"code": "invalid_news", "message": "资讯字段无效，请检查日期时区及证券代码。"}) from exc
    except news_sources.NewsError as exc:
        _error(exc)


@router.get("/{item_id}")
def get_news(item_id: str):
    try:
        item = news_sources.get_item(item_id)
        return {**item, "chart_companies": chart_companies(item)}
    except news_sources.NewsError as exc:
        _error(exc)


@router.post("/{item_id}/revisions", status_code=201)
def revise_news(item_id: str, request: news_sources.NewsRevision):
    try:
        return news_sources.import_items(news_sources.NewsImport(request_id=request.request_id, items=[request.item]), base_id=item_id)
    except news_sources.NewsError as exc:
        _error(exc)
