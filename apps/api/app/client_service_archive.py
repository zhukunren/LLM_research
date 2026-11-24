"""Sync authorized WeCom group text into the owning workspace."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import os
from pathlib import Path
import re
import time

from .client_service_text import contains_return_promise
from .db import connect, database_path, ensure_initialized
from .security_context import LOCAL_ACTOR, AccessDenied, actor_scope, auth_mode, can_write, current_actor
from .settings import _read_config
from .wecom_finance import ArchiveError, FinanceArchive

DAY = 24 * 60 * 60
RECENT_LIMIT = 500
NEED = re.compile(r"[？?]|请问|能否|能不能|能帮|想了解|想咨询|希望|需要|有无|有没有|如何|怎么|建议|反馈|投诉")
TOPICS = (
    ("行情与持仓", re.compile(r"行情|大盘|指数|持仓|仓位|涨|跌")),
    ("产品与调仓", re.compile(r"产品|基金|组合|策略|调仓|加仓|减仓")),
    ("收益与风险", re.compile(r"收益|回撤|波动|风险|亏损|止损|保本")),
    ("账户与流程", re.compile(r"账户|交易|赎回|申购|开户|手续费|佣金|到账|流程")),
)


@dataclass(frozen=True)
class ArchiveSettings:
    corp_id: str
    library: Path
    key_dir: Path
    secret_env: str
    rooms: dict[str, str]

    @property
    def scope(self) -> str:
        return hashlib.sha256(json.dumps([self.corp_id, sorted(self.rooms)]).encode()).hexdigest()


def archive_settings() -> ArchiveSettings | None:
    config = _read_config()
    if not config.has_section("wecom_archive"):
        return None
    section = config["wecom_archive"]
    corp_id = section.get("corp_id", "").strip()
    if not corp_id:
        return None
    actor = current_actor()
    if actor.tenant_id != section.get("tenant_id", "local").strip() or actor.user_id != section.get("user_id", "local-admin").strip():
        return None
    try:
        rooms = json.loads(section.get("room_names_json", "{}"))
        if not isinstance(rooms, dict) or not all(
            re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key)
            and isinstance(name, str) and 0 < len(name.strip()) <= 80
            for key, name in rooms.items()
        ):
            raise ValueError
    except ValueError:
        raise ArchiveError("服务端的企业微信存档群聊配置有误。") from None
    return ArchiveSettings(
        corp_id, Path(section.get("sdk_library", "")).expanduser(),
        Path(section.get("private_key_dir", "")).expanduser(),
        section.get("secret_env", "WECOM_ARCHIVE_SECRET").strip(), rooms,
    )


def available_rooms() -> dict[str, str]:
    try:
        config = archive_settings()
    except ArchiveError:
        return {}
    return config.rooms if config else {}


def _text_records(scope: str, rooms: dict[str, str], messages: list[dict], minimum: int, maximum: int):
    for message in messages:
        room = message.get("roomid")
        if not isinstance(room, str) or room not in rooms:
            continue
        if message.get("action") != "send" or message.get("msgtype") != "text":
            continue
        body = message.get("text")
        text = body.get("content") if isinstance(body, dict) else None
        message_id, sender, sent_at = message.get("msgid"), message.get("from"), message.get("msgtime")
        if not all(isinstance(value, str) and value.strip() for value in (message_id, sender, text)):
            raise ArchiveError("企业微信返回的群消息字段不完整。")
        if type(sent_at) is not int or not 0 < sent_at <= maximum:
            raise ArchiveError("企业微信返回的群消息时间无效。")
        if sent_at >= minimum:
            yield (scope, message_id, room, sender, sent_at, text.strip())


def sync_archive(config: ArchiveSettings, *, clock: int | None = None) -> None:
    attempted = int(time.time()) if clock is None else clock
    scope = config.scope
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute("SELECT * FROM client_service_wecom_sync WHERE scope=?", (scope,)).fetchone()
        if previous is not None and attempted - previous["attempted_at"] < 45:
            return
        db.execute(
            """INSERT INTO client_service_wecom_sync(scope,attempted_at) VALUES(?,?)
               ON CONFLICT(scope) DO UPDATE SET attempted_at=excluded.attempted_at""",
            (scope, attempted),
        )
    cursor = int(previous["cursor"]) if previous else 0
    keep_since = (attempted - 7 * DAY) * 1000
    try:
        secret = os.environ.get(config.secret_env, "").strip()
        if not secret or not config.library.is_file() or not config.key_dir.is_dir():
            raise ArchiveError("请在服务端配置会话存档 Secret、C SDK 和私钥目录。")
        with FinanceArchive(config.library, config.corp_id, secret, config.key_dir) as provider:
            next_cursor, messages = provider.read(cursor)
        rows = list(_text_records(scope, config.rooms, messages, keep_since, (attempted + DAY) * 1000))
    except ArchiveError as exc:
        with connect() as db:
            db.execute("UPDATE client_service_wecom_sync SET error=? WHERE scope=? AND attempted_at=?",
                       (str(exc), scope, attempted))
        return
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        updated = db.execute(
            """UPDATE client_service_wecom_sync SET cursor=?, synced_at=?, error=''
               WHERE scope=? AND attempted_at=? AND cursor=?""",
            (str(next_cursor), attempted, scope, attempted, str(cursor)),
        )
        if not updated.rowcount:
            return
        db.executemany(
            """INSERT INTO client_service_wecom_messages(scope,message_id,room_id,sender,sent_at,content)
               VALUES(?,?,?,?,?,?) ON CONFLICT(scope,message_id) DO NOTHING""",
            rows,
        )
        db.execute("DELETE FROM client_service_wecom_messages WHERE sent_at<?", (keep_since,))


def scheduler_tick() -> None:
    ini = _read_config()
    if not ini.get("wecom_archive", "corp_id", fallback="").strip():
        return
    try:
        actor = LOCAL_ACTOR
        if auth_mode() == "oidc":
            from .identity import actor_for_user
            actor = actor_for_user(
                ini.get("wecom_archive", "user_id", fallback="local-admin").strip(),
                ini.get("wecom_archive", "tenant_id", fallback="local").strip(),
            )
        with actor_scope(actor):
            config = archive_settings()
            if can_write(actor) and config and config.rooms and database_path().is_file():
                ensure_initialized()
                sync_archive(config)
    except (AccessDenied, ArchiveError):
        # Invalid configuration is surfaced in the authorized workspace.
        return


def _customer(sender: str) -> bool:
    return sender.startswith(("wo", "wm"))


def _topic(text: str) -> str:
    return next((name for name, pattern in TOPICS if pattern.search(text)), "")


def chat_overview(room: str | None) -> dict:
    try:
        config = archive_settings()
    except ArchiveError as exc:
        return {"state": "error", "message": str(exc)}
    if not config or not config.rooms:
        return {"state": "unconfigured", "message": "请先在服务端接入企业微信会话内容存档。"}
    if room not in config.rooms:
        return {"state": "unbound", "message": "请编辑当前机器人，选择对应的存档群聊。"}
    now = int(time.time())
    since = (now - DAY) * 1000
    scope = config.scope
    with connect() as db:
        status = db.execute("SELECT synced_at,error FROM client_service_wecom_sync WHERE scope=?", (scope,)).fetchone()
        total, people = db.execute(
            """SELECT COUNT(*), COUNT(DISTINCT sender) FROM client_service_wecom_messages
               WHERE scope=? AND room_id=? AND sent_at>=?""", (scope, room, since),
        ).fetchone()
        rows = db.execute(
            """SELECT message_id,sender,sent_at,content FROM client_service_wecom_messages
               WHERE scope=? AND room_id=? AND sent_at>=? ORDER BY sent_at DESC,message_id LIMIT ?""",
            (scope, room, since, RECENT_LIMIT),
        ).fetchall()
    topics: Counter[str] = Counter()
    highlights, alerts, needs = [], [], []
    seen_needs: set[tuple[str, str]] = set()
    for row in rows:
        text = row["content"]
        topic = _topic(text)
        item = {
            "id": row["message_id"], "sender": row["sender"], "text": text,
            "sent_at": datetime.fromtimestamp(row["sent_at"] / 1000, UTC).isoformat(),
        }
        if topic:
            topics[topic] += 1
            if len(highlights) < 6 and all(entry["topic"] != topic for entry in highlights):
                highlights.append({**item, "topic": topic})
        if _customer(row["sender"]):
            key = (row["sender"], re.sub(r"\s+", "", text))
            if len(needs) < 20 and NEED.search(text) and key not in seen_needs:
                seen_needs.add(key)
                needs.append({**item, "topic": topic or "其他需求"})
        elif len(alerts) < 20 and not row["sender"].startswith("wb") and contains_return_promise(text):
            alerts.append({**item, "topic": "疑似确定性收益表述"})
    if not highlights:
        highlights = [
            {"id": row["message_id"], "sender": row["sender"], "text": row["content"],
             "sent_at": datetime.fromtimestamp(row["sent_at"] / 1000, UTC).isoformat()}
            for row in rows[:3]
        ]
    synced = status["synced_at"] if status else None
    error = status["error"] if status else ""
    return {
        "state": "error" if error else "ready" if synced is not None else "waiting",
        "message": error,
        "room_name": config.rooms[room],
        "synced_at": datetime.fromtimestamp(synced, UTC).isoformat() if synced is not None else None,
        "total": total,
        "people": people,
        "analyzed": len(rows),
        "topics": [{"label": label, "count": count} for label, count in topics.most_common()],
        "highlights": highlights,
        "needs": needs,
        "alerts": alerts,
    }
