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
from .client_service_contracts import StrictModel
from .client_service_images import render_card, display_market
from .db import connect, utc_now, json_dump

router = APIRouter(prefix='/robots')


class RobotInput(StrictModel):
    name: str = Field(min_length=1, max_length=40)
    webhook: SecretStr | None = None
    enabled: bool = True
    revision: int = Field(default=0, ge=0)


class RobotRevision(StrictModel):
    revision: int = Field(ge=0)


class DeliveryInput(StrictModel):
    request_id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$')
    kind: Literal['test', 'text', 'image']
    card_id: str | None = Field(default=None, pattern=r'^[a-f0-9-]{36}$')
    revision: int | None = Field(default=None, ge=0)


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
    return {key: row[key] for key in ('id', 'name', 'revision', 'created_at', 'updated_at')} | {
        'enabled': bool(row['enabled']), 'webhook_configured': bool(row['webhook_key']),
        'webhook_hint': '已配置 · 密钥不回显',
    }


@router.get('')
def list_robots():
    with connect() as db:
        rows = db.execute('SELECT * FROM client_service_robots WHERE archived=0 ORDER BY created_at,id').fetchall()
    return {'items': [public_robot(row) for row in rows]}


@router.get('/deliveries')
def deliveries():
    with connect() as db:
        rows = db.execute('SELECT id,robot_id,robot_name,kind,card_id,state,message,created_at,updated_at FROM client_service_deliveries ORDER BY created_at DESC,id DESC LIMIT 50').fetchall()
    return {'items': [delivery_status(dict(row)) for row in rows]}


def save_robot(payload, robot_id=None):
    name = payload.name.strip()
    if not name:
        service.error(422, '请填写机器人名称。')
    key = webhook_key(payload.webhook.get_secret_value()) if payload.webhook and payload.webhook.get_secret_value().strip() else None
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if robot_id:
            previous = db.execute('SELECT * FROM client_service_robots WHERE id=? AND archived=0', (robot_id,)).fetchone()
            if not previous:
                service.error(404, '找不到此机器人。')
            if previous['revision'] != payload.revision:
                service.error(409, '机器人配置已变化，请重新读取后编辑。')
            db.execute('UPDATE client_service_robots SET name=?,webhook_key=?,enabled=?,revision=revision+1,updated_at=? WHERE id=?',
                       (name, key or previous['webhook_key'], int(payload.enabled), utc_now(), robot_id))
        else:
            if not key:
                service.error(422, '新增机器人时需要填写 Webhook 地址。')
            if db.execute('SELECT COUNT(*) FROM client_service_robots WHERE archived=0').fetchone()[0] >= 30:
                service.error(422, '最多可配置 30 个机器人。')
            robot_id = str(uuid4())
            db.execute('INSERT INTO client_service_robots(id,name,webhook_key,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                       (robot_id, name, key, int(payload.enabled), utc_now(), utc_now()))
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
    content, template = card['content'], card['template']
    market = display_market(card)
    lines = [f"【{content['brand']} · {content.get('headline') or template['title']}】",
             f"{card['service_date']} {template['time']}（北京时间）", market.get('summary', '')]
    lines += [f"{item['label']}：{item['value']}" for item in market.get('metrics', [])]
    for key, label in [('conclusion', '今日判断'), ('action', '行动安排'), ('focus', '观察重点'), ('service', '服务说明')]:
        if content.get(key):
            lines.append(f"{label}：{content[key]}")
    if market.get('limitations'):
        lines.append('数据说明：' + '；'.join(market['limitations']))
    lines += [f"来源：{item['title']} {item['url']}" for item in market.get('sources', [])]
    if content.get('market_overrides'):
        lines.append('展示说明：市场展示文字含手工编辑，原始采集记录可在工作台来源中核对。')
    lines.extend(disclosure_lines())
    return '\n'.join(line for line in lines if line)


def message_payload(payload):
    if payload.kind == 'test':
        if payload.card_id is not None:
            service.error(422, '测试消息不接受卡片内容。')
        return {'msgtype': 'text', 'text': {'content': '投研工作台：企业微信机器人连接测试。收到此消息表示推送通道已连通。'}}
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
    data = render_card(card)
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
    fingerprint = hashlib.sha256(json_dump({'robot_id': robot_id, **payload.model_dump(exclude={'request_id'})}).encode()).hexdigest()
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
