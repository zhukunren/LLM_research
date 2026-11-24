from datetime import date
import base64
import hashlib
import struct

from fastapi import APIRouter
from fastapi.responses import Response

from . import client_service as service
from . import celebration, opening_plans, rebalance_suggestions, stock_diagnosis
from .celebration_card import render_poster
from .client_service_contracts import GenerateCard, InstantBrief, PreviewCard, SaveCard, ServiceSettings
from .client_service_images import render_card, display_market
from .opening_plan_card import OpeningPlanPreview, PlanDate, render_opening_plan
from .rebalance_card import RebalanceCard, render_rebalance_card
from .rebalance_quotes import reference_price

router = APIRouter(prefix='/api/v1/client-service', tags=['对客服务'])


def _image_preview(data: bytes, regions: list) -> dict:
    width, height = struct.unpack('>II', data[16:24])
    return {'image': 'data:image/png;base64,' + base64.b64encode(data).decode('ascii'),
            'width': width, 'height': height, 'regions': regions, 'image_hash': hashlib.sha256(data).hexdigest()}


@router.post('/celebrations')
def create_celebration(payload: celebration.CelebrationRequest):
    report = celebration.collect(payload)
    return {**report, **_image_preview(render_poster(report), [])}


@router.get('/settings')
def settings():
    return service.settings()


@router.put('/settings')
def save_settings(payload: ServiceSettings):
    return service.save_settings(payload)


@router.get('/cards')
def cards(date: date):
    return {'items': service.list_cards(date)}


@router.post('/cards', status_code=202)
def generate(payload: GenerateCard):
    return service.start(payload)


@router.get('/cards/{card_id}')
def detail(card_id: str):
    return service.detail(card_id)


@router.put('/cards/{card_id}')
def save_card(card_id: str, payload: SaveCard):
    return service.save_card(card_id, payload)


@router.get('/cards/{card_id}/image.png')
def download(card_id: str):
    card = service.detail(card_id)
    return Response(render_card(card), media_type='image/png', headers={
        'Cache-Control': 'no-store',
        'Content-Disposition': f'attachment; filename="market-card-{card["service_date"]}-{card["slot_id"]}.png"',
    })


@router.post('/preview')
def preview(payload: PreviewCard, draft: bool = False):
    card = service.detail(payload.card_id) if payload.card_id else None
    if card and (card['service_date'] != payload.date.isoformat() or card['slot_id'] != payload.template.id):
        service.error(422, '预览日期或时点与市场数据不一致。')
    value = {'template': payload.template.model_dump(mode='json'), 'service_date': payload.date.isoformat(),
             'content': payload.content.model_dump(mode='json'), 'market': card['market'] if card else None}
    regions = []
    data = render_card(value, regions=regions, draft=draft)
    from .client_service_quality import layout_checks
    checks = layout_checks(display_market(value))
    result = {**_image_preview(data, regions), 'checks': checks, 'draft': draft}
    if draft and card and card['state'] == 'ready' and value['content'] == card['content']:
        # Visual reviews identify the saved card without the draft export mark.
        result['saved_image_hash'] = hashlib.sha256(render_card(card)).hexdigest()
    return result


@router.post('/briefs', status_code=202)
def instant_brief(payload: InstantBrief):
    return service.start_instant(payload)


@router.post('/stock-diagnoses', status_code=202)
def start_stock_diagnosis(payload: stock_diagnosis.DiagnosisRequest):
    return stock_diagnosis.start(payload)


@router.get('/stock-diagnoses/{request_id}')
def stock_diagnosis_status(request_id: str):
    return stock_diagnosis.get(request_id)


@router.post('/stock-diagnoses/{request_id}/cancel')
def cancel_stock_diagnosis(request_id: str):
    return stock_diagnosis.get(request_id, cancel=True)


@router.post('/rebalance-suggestions', status_code=202)
def collect_rebalance_suggestion(payload: rebalance_suggestions.SuggestionRequest):
    return rebalance_suggestions.start(payload)


@router.get('/rebalance-suggestions/quote')
def rebalance_reference_price(code: str):
    return reference_price(code)


@router.post('/rebalance-suggestions/preview')
def rebalance_card_preview(payload: RebalanceCard):
    regions = []
    return _image_preview(render_rebalance_card(payload, regions=regions), regions)


@router.get('/rebalance-suggestions/{request_id}')
def rebalance_suggestion_status(request_id: str):
    return rebalance_suggestions.get(request_id)


@router.post('/rebalance-suggestions/{request_id}/cancel')
def cancel_rebalance_suggestion(request_id: str):
    return rebalance_suggestions.get(request_id, cancel=True)


@router.post('/opening-plans', status_code=202)
def collect_opening_plan(payload: opening_plans.OpeningPlanRequest):
    return opening_plans.start(payload)


@router.get('/opening-plans/default-date')
def default_opening_plan_date():
    return opening_plans.default_date()


@router.get('/opening-plans/editor/{plan_date}')
def opening_plan_editor(plan_date: PlanDate):
    return opening_plans.editor(plan_date)


@router.put('/opening-plans/editor/{plan_date}')
def save_opening_plan(plan_date: PlanDate, payload: opening_plans.SaveOpeningPlan):
    return opening_plans.save_content(payload, plan_date=plan_date)


@router.put('/opening-plans/template')
def save_opening_template(payload: opening_plans.SaveOpeningTemplate):
    return opening_plans.save_content(payload)


@router.post('/opening-plans/preview')
def opening_plan_preview(payload: OpeningPlanPreview, draft: bool = False):
    regions = []
    data = render_opening_plan(payload, regions=regions, draft=draft)
    return {**_image_preview(data, regions), 'draft': draft}


@router.get('/opening-plans/{request_id}')
def opening_plan_status(request_id: str):
    return opening_plans.get(request_id)


@router.post('/opening-plans/{request_id}/cancel')
def cancel_opening_plan(request_id: str):
    return opening_plans.get(request_id, cancel=True)


from .client_service_robots import router as robots_router
router.include_router(robots_router)

from .client_service_reviews import router as review_router
router.include_router(review_router)
