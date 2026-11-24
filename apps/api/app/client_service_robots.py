"""Workspace-owned WeCom webhooks. Secrets never leave the server in responses."""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, UTC
import hashlib
from io import BytesIO
import re
from typing import Literal
from urllib.parse import urlsplit, parse_qs
from uuid import uuid4

import requests
from fastapi import APIRouter
from pydantic import Field, SecretStr
from PIL import Image

from . import client_service as service
from .client_service_archive import available_rooms, chat_overview
from .client_service_contracts import StrictModel
from .client_service_disclosure import FIXED_DISCLOSURE
from .client_service_images import render_card, display_market
from .client_service_text import contains_return_promise, without_web_links
from .db import connect, utc_now, json_dump
from .rebalance_card import RebalanceCard, render_rebalance_card

router = APIRouter(prefix='/robots')


class RobotInput(StrictModel):
    name: str = Field(min_length=1, max_length=40)
    webhook: SecretStr | None = None
    enabled: bool = True
    revision: int = Field(default=0, ge=0)
    archive_room_id: str | None = Field(default=None, pattern=r'^[A-Za-z0-9_-]{1,128}$')


class RobotRevision(StrictModel):
    revision: int = Field(ge=0)


class DeliveryInput(StrictModel):
    request_id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$')
    kind: Literal['test', 'text', 'image']
    robot_revision: int | None = Field(default=None, ge=0)
    card_id: str | None = Field(default=None, pattern=r'^[a-f0-9-]{36}$')
    revision: int | None = Field(default=None, ge=0)
    content_text: str | None = Field(default=None, max_length=6000)
    suggestion: RebalanceCard | None = None


class ReviewInput(StrictModel):
    text: str = Field(max_length=6000)
    kind: Literal['text', 'image'] = 'text'


def webhook_key(value: str) -> str:
    try:
        url = urlsplit(value.strip())
        query = parse_qs(url.query, strict_parsing=True)
        keys = query.get('key', [])
        if (url.scheme == 'https' and url.netloc == 'qyapi.weixin.qq.com'
                and url.path == '/cgi-bin/webhook/send' and not url.fragment
                and set(query) == {'key'} and len(keys) == 1 and re.fullmatch(r'[A-Za-z0-9_-]{8,200}', keys[0])):
            return keys[0]
    except ValueError:
        pass
    service.error(422, '请填写企业微信群机器人提供的完整 HTTPS Webhook 地址。')


def public_robot(row):
    return {key: row[key] for key in ('id', 'name', 'revision', 'created_at', 'updated_at', 'archive_room_id')} | {
        'enabled': bool(row['enabled']), 'webhook_configured': bool(row['webhook_key']),
        'webhook_hint': '已配置 · 密钥不回显',
    }


@router.get('')
def list_robots():
    with connect() as db:
        rows = db.execute('SELECT * FROM client_service_robots WHERE archived=0 ORDER BY created_at,id').fetchall()
    return {
        'items': [public_robot(row) for row in rows],
        'archive_rooms': [{'id': room, 'name': name} for room, name in available_rooms().items()],
    }


@router.get('/deliveries')
def deliveries():
    with connect() as db:
        rows = db.execute('SELECT id,robot_id,robot_name,kind,card_id,state,message,created_at,updated_at FROM client_service_deliveries ORDER BY created_at DESC,id DESC LIMIT 50').fetchall()
    return {'items': [delivery_status(dict(row)) for row in rows]}


@router.get('/risks')
def monitor_delivery_risks(robot_id: str | None = None):
    with connect() as db:
        scope = " AND robot_id=?" if robot_id else ""
        args = (robot_id,) if robot_id else ()
        rows = db.execute(
            f"""SELECT id,robot_id,robot_name,kind,card_id,state,message,created_at,updated_at FROM client_service_deliveries
                WHERE state IN ('failed','unknown','sending'){scope} ORDER BY created_at DESC,id DESC LIMIT 50""",
            args,
        ).fetchall()
        paused_scope = " AND id=?" if robot_id else ""
        paused = db.execute(
            f"SELECT id,name FROM client_service_robots WHERE archived=0 AND enabled=0{paused_scope} ORDER BY name", args,
        ).fetchall()
    return {"items": [delivery_status(dict(row)) for row in rows], "paused": [dict(row) for row in paused]}


@router.get('/{robot_id}/chat')
def robot_chat(robot_id: str):
    with connect() as db:
        robot = db.execute('SELECT archive_room_id FROM client_service_robots WHERE id=? AND archived=0', (robot_id,)).fetchone()
    if robot is None:
        service.error(404, '找不到此群机器人。')
    return chat_overview(robot['archive_room_id'])


def review_content(text: str, *, kind: str = 'text') -> dict:
    issues = []
    if not text.split("风险提示", 1)[0].strip():
        issues.append({"code": "empty", "message": "补充要发送的正文。"})
    if not all(fragment in text for fragment in ("风险提示", "R4", "市场有风险", "投资需谨慎")):
        issues.append({"code": "disclosure", "message": "补齐 R4 风险提示及市场风险说明。"})
    if not all(FIXED_DISCLOSURE[key] in text for key in ("adviser", "license", "institution")):
        issues.append({"code": "signature", "message": "补齐当前投顾姓名、执业编码和机构落款。"})
    if without_web_links(text) != text:
        issues.append({"code": "link", "message": "从群发文案中去掉网址。"})
    if contains_return_promise(text):
        issues.append({"code": "promise", "message": "核对并改写保证收益、保本或必涨等确定性表述。"})
    if re.search(r'草稿[ ·・]*[待未]核对', text):
        issues.append({"code": "draft", "message": "核对完成后再使用成品文案。"})
    size = len(text.encode("utf-8"))
    if kind == "text" and size > 2048:
        issues.append({"code": "text_limit", "message": "单条企业微信文案上限为 2048 字节，请精简或使用图片。"})
    return {"passed": not issues, "issues": issues, "bytes": size}


@router.post('/review')
def review_outgoing_content(payload: ReviewInput):
    return review_content(payload.text, kind=payload.kind)


def save_robot(payload, robot_id=None):
    name = payload.name.strip()
    if not name:
        service.error(422, '请填写机器人名称。')
    key = webhook_key(payload.webhook.get_secret_value()) if payload.webhook and payload.webhook.get_secret_value().strip() else None
    room = payload.archive_room_id
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        previous = None
        if robot_id:
            previous = db.execute('SELECT * FROM client_service_robots WHERE id=? AND archived=0', (robot_id,)).fetchone()
            if not previous:
                service.error(404, '找不到此机器人。')
            if previous['revision'] != payload.revision:
                service.error(409, '机器人配置已变化，请重新读取后编辑。')
            if 'archive_room_id' not in payload.model_fields_set:
                room = previous['archive_room_id']
        if room and (previous is None or room != previous['archive_room_id']):
            if room not in available_rooms():
                service.error(422, '请选择已授权的企业微信存档群聊。')
            if db.execute('SELECT 1 FROM client_service_robots WHERE archived=0 AND archive_room_id=?', (room,)).fetchone():
                service.error(409, '该群已绑定机器人，请编辑现有配置。')
        if key and (previous is None or key != previous['webhook_key']):
            if db.execute('SELECT 1 FROM client_service_robots WHERE archived=0 AND webhook_key=?', (key,)).fetchone():
                service.error(409, '这个 Webhook 已配置，请编辑现有群机器人。')
        if previous is not None:
            db.execute(
                """UPDATE client_service_robots SET name=?,webhook_key=?,enabled=?,archive_room_id=?,
                   revision=revision+1,updated_at=? WHERE id=?""",
                (name, key or previous['webhook_key'], int(payload.enabled), room, utc_now(), robot_id),
            )
        else:
            if not key:
                service.error(422, '新增机器人时需要填写 Webhook 地址。')
            if db.execute('SELECT COUNT(*) FROM client_service_robots WHERE archived=0').fetchone()[0] >= 30:
                service.error(422, '最多可配置 30 个机器人。')
            robot_id = str(uuid4())
            db.execute(
                """INSERT INTO client_service_robots(id,name,webhook_key,enabled,created_at,updated_at,archive_room_id)
                   VALUES(?,?,?,?,?,?,?)""",
                (robot_id, name, key, int(payload.enabled), utc_now(), utc_now(), room),
            )
        row = db.execute('SELECT * FROM client_service_robots WHERE id=?', (robot_id,)).fetchone()
    return public_robot(row)


@router.post('', status_code=201)
def create_robot(payload: RobotInput):
    return save_robot(payload)


@router.put('/{robot_id}')
def update_robot(robot_id: str, payload: RobotInput):
    return save_robot(payload, robot_id)


@router.post('/{robot_id}/archive')
def archive_robot(robot_id: str, payload: RobotRevision):
    with connect() as db:
        changed = db.execute('UPDATE client_service_robots SET archived=1,enabled=0,webhook_key=\'\',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND archived=0',
                             (utc_now(), robot_id, payload.revision)).rowcount
        if not changed:
            service.error(409, '机器人配置已变化，请重新读取。')
    return {'archived': True}


def card_text(card):
    from .client_service_disclosure import disclosure_lines
    from .client_service_quality import TZ, publication_notes
    from .client_service_text import card_copy_content, without_web_links

    content, template = card_copy_content(card['content']), card['template']
    market = display_market(card)
    lines = [f"【{content['brand']} · {content.get('headline') or without_web_links(template['title'])}】"]
    if cutoff := card.get('cutoff'):
        cutoff_time = datetime.fromisoformat(cutoff).astimezone(TZ).strftime('%Y-%m-%d %H:%M')
        lines.append(f'资料截止 {cutoff_time}（北京时间）')
    else:
        lines.append(f"服务时点 {card['service_date']} {template['time']}（北京时间）")
    if generated_at := market.get('generated_at'):
        generated = datetime.fromisoformat(generated_at).astimezone(TZ).strftime('%Y-%m-%d %H:%M')
        lines.append(f'生成时间 {generated}')
    lines.append(market.get('summary', ''))
    lines += [f"{item['label']}：{item['value']}" for item in market.get('metrics', [])]
    for key, label in [('conclusion', '今日判断'), ('action', '行动安排'), ('focus', '观察重点'), ('service', '服务说明')]:
        if content.get(key):
            lines.append(f"{label}：{content[key]}")
    lines.extend(publication_notes(market))
    names = dict.fromkeys(without_web_links(item.get('title') or '').strip() for item in market.get('sources', []))
    lines += [f"来源：{name}" for name in names if name]
    if content.get('market_overrides'):
        lines.append('展示说明：市场展示文字含手工编辑，原始采集记录可在工作台来源中核对。')
    lines.extend(disclosure_lines())
    return '\n'.join(line for line in lines if line)


def message_payload(payload):
    if payload.kind == 'test':
        if payload.card_id is not None or payload.content_text is not None or payload.suggestion is not None:
            service.error(422, '测试消息不接受卡片内容。')
        return {'msgtype': 'text', 'text': {'content': '投研工作台：企业微信机器人连接测试。收到此消息表示推送通道已连通。'}}
    if payload.content_text is not None or payload.suggestion is not None:
        if payload.card_id is not None or payload.revision is not None or (payload.content_text is not None and payload.suggestion is not None):
            service.error(422, '每次群发只能选择一种内容。')
        if payload.suggestion is not None:
            if payload.kind != 'image' or not payload.suggestion.ready():
                service.error(422, '请先填齐调仓卡片再群发图片。')
            text = payload.suggestion.text()
        else:
            if payload.kind != 'text':
                service.error(422, '请选择文案格式。')
            text = payload.content_text.strip()
        review = review_content(text, kind=payload.kind)
        if not review["passed"]:
            service.error(422, " ".join(issue["message"] for issue in review["issues"]))
        if payload.kind == "image":
            return _image_payload(render_rebalance_card(payload.suggestion))
        return {'msgtype': 'text', 'text': {'content': text}}
    if not payload.card_id or payload.revision is None:
        service.error(422, '请先选择已保存的卡片。')
    card = service.detail(payload.card_id)
    if card['revision'] != payload.revision:
        service.error(409, '卡片已有更新，请重新核对后发送。')
    if card['state'] != 'ready' or not card['market']:
        service.error(422, '请等待市场采集完成并核对卡片后发送。')
    if payload.kind == 'text':
        value = card_text(card)
        if len(value.encode('utf-8')) > 2048:
            service.error(422, '文案超过企业微信 2048 字节限制，请精简内容或改发图片。')
        return {'msgtype': 'text', 'text': {'content': value}}
    return _image_payload(render_card(card))


def _image_payload(data: bytes):
    if len(data) > 2 * 1024 * 1024:
        # Artwork is textured; JPEG keeps the full-resolution text while meeting WeCom's cap.
        with Image.open(BytesIO(data)) as image:
            for quality in (90, 80, 70):
                stream = BytesIO(); image.convert('RGB').save(stream, format='JPEG', quality=quality, optimize=True)
                data = stream.getvalue()
                if len(data) <= 2 * 1024 * 1024:
                    break
    if len(data) > 2 * 1024 * 1024:
        service.error(422, '图片超过企业微信 2 MB 限制，请缩短卡片内容。')
    return {'msgtype': 'image', 'image': {'base64': base64.b64encode(data).decode('ascii'), 'md5': hashlib.md5(data, usedforsecurity=False).hexdigest()}}


def delivery_status(value):
    # An interrupted process cannot prove non-delivery. Never resend automatically.
    if value['state'] == 'sending' and datetime.fromisoformat(value['created_at']) < datetime.now(UTC) - timedelta(minutes=2):
        return {**value, 'state': 'unknown', 'message': '发送结果未确认，请先查看目标群，避免重复发送。'}
    return value


def public_delivery(row):
    return delivery_status({key: row[key] for key in ('id', 'robot_id', 'robot_name', 'kind', 'card_id', 'state', 'message', 'created_at', 'updated_at')})


@router.post('/{robot_id}/send')
def send(robot_id: str, payload: DeliveryInput):
    excluded = {'request_id'}
    excluded.update(field for field in ('content_text', 'suggestion', 'robot_revision') if getattr(payload, field) is None)
    fingerprint = hashlib.sha256(json_dump({'robot_id': robot_id, **payload.model_dump(exclude=excluded)}).encode()).hexdigest()
    with connect() as db:
        previous = db.execute('SELECT * FROM client_service_deliveries WHERE request_id=?', (payload.request_id,)).fetchone()
    if previous:
        if previous['request_hash'] != fingerprint:
            service.error(409, '同一发送请求不能更换目标或内容。')
        return public_delivery(previous)
    body = message_payload(payload)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        previous = db.execute('SELECT * FROM client_service_deliveries WHERE request_id=?', (payload.request_id,)).fetchone()
        if previous:
            if previous['request_hash'] != fingerprint:
                service.error(409, '同一发送请求不能更换目标或内容。')
            return public_delivery(previous)
        robot = db.execute('SELECT * FROM client_service_robots WHERE id=? AND archived=0', (robot_id,)).fetchone()
        if not robot:
            service.error(404, '找不到此机器人。')
        if payload.robot_revision is not None and robot['revision'] != payload.robot_revision:
            service.error(409, '目标群配置已有变化，请刷新后重新确认。')
        if not robot['enabled']:
            service.error(422, '此机器人已停用，请先启用。')
        since = (datetime.now(UTC) - timedelta(minutes=1)).isoformat(timespec='seconds')
        if db.execute('SELECT COUNT(*) FROM client_service_deliveries WHERE robot_id=? AND created_at>=?', (robot_id, since)).fetchone()[0] >= 20:
            service.error(429, '此机器人发送过于频繁，请一分钟后再试。')
        delivery_id = str(uuid4())
        db.execute('INSERT INTO client_service_deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                   (delivery_id, payload.request_id, fingerprint, robot_id, robot['name'], payload.kind, payload.card_id, 'sending', '发送中', utc_now(), utc_now()))
    state, message = 'unknown', '发送结果未确认，请先查看目标群，避免重复发送。'
    try:
        from .security_context import current_actor
        current_actor()  # Recheck authorization immediately before transmission.
        with requests.Session() as session:
            session.trust_env = False
            response = session.post('https://qyapi.weixin.qq.com/cgi-bin/webhook/send', params={'key': robot['webhook_key']},
                                    json=body, timeout=(5, 10), allow_redirects=False)
        if response.status_code == 200:
            result = response.json()
            code = result.get('errcode')
            if type(code) is int:
                state = 'sent' if code == 0 else 'failed'
                message = '企业微信已接收' if code == 0 else f'企业微信拒绝消息（错误码 {code}），请检查机器人配置。'
    except (requests.RequestException, ValueError, TypeError, AttributeError):
        pass  # Never log provider exceptions: their URL can contain the webhook secret.
    with connect() as db:
        db.execute('UPDATE client_service_deliveries SET state=?,message=?,updated_at=? WHERE id=?', (state, message, utc_now(), delivery_id))
        value = db.execute('SELECT * FROM client_service_deliveries WHERE id=?', (delivery_id,)).fetchone()
    return public_delivery(value)
