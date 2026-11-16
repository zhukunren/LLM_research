from datetime import date
import base64
import struct

from fastapi import APIRouter
from fastapi.responses import Response

from . import client_service as service
from .client_service_contracts import GenerateCard, InstantBrief, PreviewCard, SaveCard, ServiceSettings
from .client_service_images import render_card

router = APIRouter(prefix='/api/v1/client-service', tags=['对客服务'])


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
def preview(payload: PreviewCard):
    card = service.detail(payload.card_id) if payload.card_id else None
    if card and (card['service_date'] != payload.date.isoformat() or card['slot_id'] != payload.template.id):
        service.error(422, '预览日期或时点与市场数据不一致。')
    value = {'template': payload.template.model_dump(mode='json'), 'service_date': payload.date.isoformat(),
             'content': payload.content.model_dump(mode='json'), 'market': card['market'] if card else None}
    regions = []
    data = render_card(value, regions=regions)
    width, height = struct.unpack('>II', data[16:24])
    return {'image': 'data:image/png;base64,' + base64.b64encode(data).decode('ascii'), 'width': width, 'height': height, 'regions': regions}


@router.post('/briefs', status_code=202)
def instant_brief(payload: InstantBrief):
    return service.start_instant(payload)


from .client_service_robots import router as robots_router
router.include_router(robots_router)
