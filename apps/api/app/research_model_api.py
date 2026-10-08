from fastapi import APIRouter, HTTPException

from . import research_models

router = APIRouter(prefix="/api/v1/research-models", tags=["研究模型"])


@router.get("")
def get_research_models():
    try:
        return research_models.catalog()
    except ValueError as exc:
        raise HTTPException(503, {"code": "research_model_configuration", "message": "研究模型配置无效，请联系管理员"}) from exc
