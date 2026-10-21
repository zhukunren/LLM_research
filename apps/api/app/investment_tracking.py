"""Personal watchlist monitoring, earnings expectations and portfolio ledger."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field, field_validator, model_validator

from . import financial_metrics, market
from .db import connect, utc_now
from .financial_contracts import ZONE, decimal_text
from .screening_contracts import ContractModel
from .security_context import AccessDenied, can_write, current_actor

router = APIRouter(prefix="/api/v1/investment-tracking", tags=["投资跟踪"])
STOCK_CODE = r"^\d{6}\.(SH|SZ|BJ)$"


def _actor_id(*, write: bool = False) -> str:
    actor = current_actor()
    if write and not can_write(actor):
        raise AccessDenied("当前账户只有查看权限")
    return actor.user_id


class MonitorPreference(ContractModel):
    price_move_threshold: Decimal = Field(gt=0, le=50)


class EventPatch(ContractModel):
    status: Literal["reviewed", "dismissed"]


class ExpectationInput(ContractModel):
    stock_code: str = Field(pattern=STOCK_CODE)
    report_period: date
    basis: Literal["annual", "cumulative", "quarter", "ttm"]
    metric_code: str = Field(min_length=1, max_length=80)
    expected_value: Decimal
    note: str = Field(default="", max_length=1000)

    @field_validator("stock_code", mode="before")
    @classmethod
    def canonical_code(cls, value):
        return value.strip().upper() if isinstance(value, str) else value

    @model_validator(mode="after")
    def validate_period(self):
        if (self.report_period.month, self.report_period.day) not in {(3, 31), (6, 30), (9, 30), (12, 31)}:
            raise ValueError("报告期请选择季末日期。")
        if self.basis == "annual" and (self.report_period.month, self.report_period.day) != (12, 31):
            raise ValueError("年度预期必须使用 12 月 31 日报告期。")
        return self


class PortfolioTransactionInput(ContractModel):
    trade_date: date
    stock_code: str = Field(pattern=STOCK_CODE)
    side: Literal["buy", "sell"]
    quantity: Decimal = Field(gt=0)
    price: Decimal = Field(gt=0)
    fees: Decimal = Field(default=Decimal("0"), ge=0)
    note: str = Field(default="", max_length=1000)

    @field_validator("stock_code", mode="before")
    @classmethod
    def canonical_code(cls, value):
        return value.strip().upper() if isinstance(value, str) else value

    @model_validator(mode="after")
    def validate_trade_date(self):
        if self.trade_date > datetime.now(ZONE).date():
            raise ValueError("交易日期不能晚于今天。")
        return self


@router.get("/monitor/preferences")
def monitor_preferences():
    owner = _actor_id()
    with connect() as connection:
        row = connection.execute("SELECT price_move_threshold,updated_at FROM investment_monitor_preferences WHERE owner_user_id=?", (owner,)).fetchone()
    return {"price_move_threshold": row[0] if row else 5, "updated_at": row[1] if row else None}


@router.put("/monitor/preferences")
def update_monitor_preferences(payload: MonitorPreference):
    owner = _actor_id(write=True)
    now = utc_now()
    with connect() as connection:
        connection.execute("""INSERT INTO investment_monitor_preferences VALUES(?,?,?)
            ON CONFLICT(owner_user_id) DO UPDATE SET price_move_threshold=excluded.price_move_threshold,updated_at=excluded.updated_at""",
            (owner, float(payload.price_move_threshold), now))
    return {"price_move_threshold": float(payload.price_move_threshold), "updated_at": now}


def _add_event(connection, owner: str, code: str, kind: str, source_key: str,
               event_date: str, title: str, summary: str, source_url: str | None = None) -> bool:
    cursor = connection.execute("""INSERT OR IGNORE INTO investment_monitor_events
        (id,owner_user_id,stock_code,event_kind,source_key,event_date,title,summary,source_url,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (str(uuid4()), owner, code, kind, source_key, event_date, title, summary, source_url, utc_now()))
    return cursor.rowcount == 1


def _events_since(connection, owner: str, code: str, since: str) -> int:
    created = 0
    rows = connection.execute("""SELECT DISTINCT r.id,f.report_period,f.family,r.first_observed_at
        FROM financial_facts f JOIN financial_source_records r ON r.id=f.record_id
        WHERE f.stock_code=? AND r.first_observed_at>=? ORDER BY r.first_observed_at DESC""",
        (code, since)).fetchall()
    for row in rows:
        created += _add_event(connection, owner, code, "financial_update", row["id"],
            row["first_observed_at"][:10], "新增财务数据：" + row["report_period"],
            "已观察到新的 " + row["family"] + " 数据版本。可在财务页核对来源、单位和报告期。")
    rows = connection.execute("""SELECT v.id,v.created_at,json_extract(m.metadata_json,'$.title') title,
            json_extract(m.metadata_json,'$.report_period') report_period,
            json_extract(m.metadata_json,'$.document_type') document_type,
            json_extract(m.metadata_json,'$.publication_date') publication_date
        FROM disclosure_versions v JOIN disclosure_metadata m ON m.version_id=v.id
          AND m.revision=(SELECT MAX(n.revision) FROM disclosure_metadata n WHERE n.version_id=v.id)
        WHERE json_extract(m.metadata_json,'$.stock_code')=?
          AND json_extract(m.metadata_json,'$.confirmed')=1 AND v.created_at>=?
        ORDER BY v.created_at DESC""", (code, since)).fetchall()
    for row in rows:
        title = row["title"] or "公司披露"
        publication_date = row["publication_date"] or row["created_at"][:10]
        created += _add_event(connection, owner, code, "new_disclosure", row["id"],
            publication_date, "新增披露：" + title,
            (row["report_period"] or "报告期未确认") + " · " + (row["document_type"] or "其他材料"),
            "/api/v1/disclosures/versions/" + row["id"] + "/pdf")
    return created


@router.post("/monitor/check")
def check_monitor_updates():
    owner = _actor_id(write=True)
    with connect() as connection:
        preference = connection.execute("SELECT price_move_threshold FROM investment_monitor_preferences WHERE owner_user_id=?", (owner,)).fetchone()
        threshold = float(preference[0]) if preference else 5.0
        codes = [row[0] for row in connection.execute("""SELECT DISTINCT stock_code FROM observation_candidate_index
            WHERE status IN ('watching','priority') ORDER BY stock_code""")]
        states = {row["stock_code"]: row["checked_at"] for row in connection.execute(
            "SELECT stock_code,checked_at FROM investment_monitor_state WHERE owner_user_id=?", (owner,))}
    profile = market.cached_profile()
    latest_date = profile.get("last_date")
    now = utc_now()
    created = 0
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        for code in codes:
            previous_check = states.get(code)
            if previous_check:
                created += _events_since(connection, owner, code, previous_check)
            if latest_date:
                bars = [bar for bar in market.get_bars(code, latest_date, limit=3) if bar["quality_valid"]]
                if len(bars) >= 2 and bars[-1]["trade_date"] == latest_date and bars[-2]["close"] > 0:
                    previous, latest = bars[-2], bars[-1]
                    change = (latest["close"] / previous["close"] - 1) * 100
                    if abs(change) >= threshold:
                        direction = "上涨" if change > 0 else "下跌"
                        created += _add_event(connection, owner, code, "price_move", latest["trade_date"],
                            "单日" + direction + f" {change:+.2f}%",
                            f"{previous['trade_date']} 收盘 {previous['close']:.4f}，{latest['trade_date']} 收盘 {latest['close']:.4f}。阈值 {threshold:g}%。",
                            "/api/v1/securities/" + code + "/bars?as_of=" + latest["trade_date"])
            connection.execute("""INSERT INTO investment_monitor_state(owner_user_id,stock_code,checked_at) VALUES(?,?,?)
                ON CONFLICT(owner_user_id,stock_code) DO UPDATE SET checked_at=excluded.checked_at""",
                (owner, code, now))
    return {"checked": len(codes), "created": created, "checked_at": now, "latest_market_date": latest_date,
            "note": "首次检查建立财务和披露基线；行情提醒按单日收盘变动阈值生成。"}


@router.get("/monitor/events")
def list_monitor_events(status: Literal["open", "reviewed", "dismissed"] | None = "open",
                        offset: int = Query(0, ge=0), limit: int = Query(1, ge=1, le=100)):
    owner = _actor_id()
    where = "owner_user_id=?" + (" AND status=?" if status else "")
    args = (owner, status) if status else (owner,)
    with connect() as connection:
        total = connection.execute("SELECT count(*) FROM investment_monitor_events WHERE " + where, args).fetchone()[0]
        rows = connection.execute("SELECT * FROM investment_monitor_events WHERE " + where +
            " ORDER BY event_date DESC,created_at DESC LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
        last_check = connection.execute("SELECT max(checked_at) FROM investment_monitor_state WHERE owner_user_id=?", (owner,)).fetchone()[0]
    return {"items": [dict(row) for row in rows], "total": total, "last_checked_at": last_check}


@router.patch("/monitor/events/{event_id}")
def update_monitor_event(event_id: str, payload: EventPatch):
    owner = _actor_id(write=True)
    with connect() as connection:
        cursor = connection.execute("UPDATE investment_monitor_events SET status=? WHERE id=? AND owner_user_id=?",
                                    (payload.status, event_id, owner))
        if cursor.rowcount != 1:
            raise HTTPException(404, "找不到此提醒。")
        row = connection.execute("SELECT * FROM investment_monitor_events WHERE id=?", (event_id,)).fetchone()
    return dict(row)


def _metric_catalog() -> dict[str, dict]:
    return {item["code"]: item for item in financial_metrics.catalog()}


def _expectation_result(row, actual: dict | None, metric: dict) -> dict:
    value = dict(row)
    expected = Decimal(value.pop("expected_value"))
    value["expected_value"] = decimal_text(expected)
    value["metric_label"] = metric["label"]
    value["unit"] = metric["unit"]
    point = actual or {"value": None, "status": "no_record", "reason": "未取得该期财务数据"}
    value["actual_value"] = point.get("value")
    value["actual_status"] = point.get("status")
    value["actual_reason"] = point.get("reason")
    value["surprise"] = None
    value["surprise_percent"] = None
    if point.get("status") == "ok" and point.get("value") is not None:
        difference = Decimal(str(point["value"])) - expected
        value["surprise"] = decimal_text(difference)
        if expected != 0:
            value["surprise_percent"] = decimal_text(difference / abs(expected) * Decimal("100"))
    return value


@router.get("/expectations")
def list_expectations(stock_code: str | None = None, limit: int = Query(100, ge=1, le=300)):
    owner = _actor_id()
    if stock_code and not __import__("re").fullmatch(STOCK_CODE, stock_code.upper()):
        raise HTTPException(422, "证券代码格式无效。")
    with connect() as connection:
        rows = connection.execute("SELECT * FROM earnings_expectations WHERE owner_user_id=?" +
            (" AND stock_code=?" if stock_code else "") + " ORDER BY report_period DESC,stock_code,metric_code LIMIT ?",
            (owner, stock_code.upper(), limit) if stock_code else (owner, limit)).fetchall()
    catalog = _metric_catalog()
    groups: dict[tuple[str, str, str], list] = {}
    for row in rows:
        groups.setdefault((row["stock_code"], row["basis"], row["report_period"][:4]), []).append(row)
    actuals = {}
    today = datetime.now(ZONE).date()
    for (code, basis, year), items in groups.items():
        if int(year) > today.year:
            reason = "报告期尚未到来"
            actuals.update({(code, basis, item["report_period"], item["metric_code"]):
                {"value": None, "status": "not_available", "reason": reason} for item in items})
            continue
        if int(year) < today.year - 10:
            reason = "超出当前财务序列查询范围"
            actuals.update({(code, basis, item["report_period"], item["metric_code"]):
                {"value": None, "status": "not_available", "reason": reason} for item in items})
            continue
        query = financial_metrics.FinancialQuery(stock_code=code, as_of=today, start_year=int(year), basis=basis,
            metrics=sorted({item["metric_code"] for item in items}))
        result = financial_metrics.calculate(query)
        actuals.update({(code, basis, period, metric): point
            for row in result["rows"] for period, values in [(row["period"], row["values"])]
            for metric, point in values.items()})
    return {"items": [_expectation_result(row, actuals.get((row["stock_code"], row["basis"], row["report_period"], row["metric_code"])),
            catalog[row["metric_code"]]) for row in rows if row["metric_code"] in catalog],
            "metrics": list(catalog.values())}


@router.post("/expectations")
def save_expectation(payload: ExpectationInput):
    owner = _actor_id(write=True)
    catalog = _metric_catalog()
    if payload.metric_code not in catalog:
        raise HTTPException(422, "指标不在已验证的财务指标目录中。")
    with connect() as connection:
        if not connection.execute("SELECT 1 FROM security_catalog WHERE stock_code=?", (payload.stock_code,)).fetchone():
            raise HTTPException(422, "请使用证券目录中已确认的股票代码。")
        existing = connection.execute("""SELECT id FROM earnings_expectations WHERE owner_user_id=? AND stock_code=?
            AND report_period=? AND basis=? AND metric_code=?""",
            (owner, payload.stock_code, payload.report_period.isoformat(), payload.basis, payload.metric_code)).fetchone()
        expectation_id = existing[0] if existing else str(uuid4())
        now = utc_now()
        connection.execute("""INSERT INTO earnings_expectations
            (id,owner_user_id,stock_code,report_period,basis,metric_code,expected_value,note,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,stock_code,report_period,basis,metric_code)
            DO UPDATE SET expected_value=excluded.expected_value,note=excluded.note,updated_at=excluded.updated_at""",
            (expectation_id, owner, payload.stock_code, payload.report_period.isoformat(), payload.basis,
             payload.metric_code, decimal_text(payload.expected_value), payload.note, now, now))
        row = connection.execute("SELECT * FROM earnings_expectations WHERE id=?", (expectation_id,)).fetchone()
    result = list_expectations(stock_code=payload.stock_code)
    return next(item for item in result["items"] if item["id"] == row["id"])


@router.delete("/expectations/{expectation_id}", status_code=204)
def delete_expectation(expectation_id: str):
    owner = _actor_id(write=True)
    with connect() as connection:
        cursor = connection.execute("DELETE FROM earnings_expectations WHERE id=? AND owner_user_id=?", (expectation_id, owner))
        if cursor.rowcount != 1:
            raise HTTPException(404, "找不到此业绩预期。")


def _transaction_rows(connection, owner: str):
    return connection.execute("""SELECT * FROM portfolio_transactions WHERE owner_user_id=?
        ORDER BY trade_date,CASE side WHEN 'buy' THEN 0 ELSE 1 END,created_at,id""", (owner,)).fetchall()


def _ledger(rows) -> tuple[dict[str, dict], Decimal]:
    positions: dict[str, dict] = {}
    realized = Decimal(0)
    for row in rows:
        item = positions.setdefault(row["stock_code"], {"quantity": Decimal(0), "cost_basis": Decimal(0), "realized_profit": Decimal(0)})
        quantity, price, fees = Decimal(row["quantity"]), Decimal(row["price"]), Decimal(row["fees"])
        if row["side"] == "buy":
            item["quantity"] += quantity
            item["cost_basis"] += quantity * price + fees
        else:
            if quantity > item["quantity"]:
                raise ValueError("卖出数量超过该交易日的累计持仓，不能形成融券或负持仓。")
            average_cost = item["cost_basis"] / item["quantity"]
            realized += quantity * price - fees - average_cost * quantity
            item["realized_profit"] += quantity * price - fees - average_cost * quantity
            item["quantity"] -= quantity
            item["cost_basis"] -= average_cost * quantity
    return positions, realized


@router.get("/portfolio")
def read_portfolio():
    owner = _actor_id()
    with connect() as connection:
        rows = _transaction_rows(connection, owner)
    try:
        state, realized = _ledger(rows)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    profile = market.cached_profile()
    latest_market_date = profile.get("last_date")
    positions = []
    market_value = Decimal(0)
    cost_basis = Decimal(0)
    for code, item in state.items():
        quantity = item["quantity"]
        if quantity <= 0:
            continue
        bars = market.get_bars(code, latest_market_date, limit=3) if latest_market_date else []
        valid = [bar for bar in bars if bar["quality_valid"]]
        latest = valid[-1] if valid else None
        value = Decimal(str(latest["close"])) * quantity if latest else None
        basis = item["cost_basis"]
        unrealized = value - basis if value is not None else None
        positions.append({"stock_code": code, "name": _stock_name(code), "quantity": decimal_text(quantity),
            "average_cost": decimal_text(basis / quantity), "cost_basis": decimal_text(basis),
            "latest_close": decimal_text(Decimal(str(latest["close"]))) if latest else None,
            "latest_date": latest["trade_date"] if latest else None,
            "market_value": decimal_text(value) if value is not None else None,
            "unrealized_profit": decimal_text(unrealized) if unrealized is not None else None,
            "realized_profit": decimal_text(item["realized_profit"])})
        cost_basis += basis
        if value is not None:
            market_value += value
    positions.sort(key=lambda item: item["stock_code"])
    all_priced = all(item["market_value"] is not None for item in positions)
    return {"positions": positions, "transactions": [dict(row) for row in reversed(rows[-300:])],
        "summary": {"market_value": decimal_text(market_value) if all_priced else None, "cost_basis": decimal_text(cost_basis),
            "unrealized_profit": decimal_text(market_value - cost_basis) if all_priced else None,
            "realized_profit": decimal_text(realized),
            "total_profit": decimal_text(realized + market_value - cost_basis) if all_priced else None,
            "positions": len(positions)}, "latest_market_date": latest_market_date,
        "cost_method": "移动加权平均，买入手续费计入成本，卖出手续费计入已实现盈亏；同日按先买入后卖出计算。"}


def _stock_name(code: str) -> str:
    with connect() as connection:
        row = connection.execute("SELECT name FROM security_catalog WHERE stock_code=?", (code,)).fetchone()
    return row[0] if row else ""


@router.post("/portfolio/transactions", status_code=201)
def create_portfolio_transaction(payload: PortfolioTransactionInput):
    owner = _actor_id(write=True)
    with connect() as connection:
        if not connection.execute("SELECT 1 FROM security_catalog WHERE stock_code=?", (payload.stock_code,)).fetchone():
            raise HTTPException(422, "请使用证券目录中已确认的股票代码。")
        transaction_id, now = str(uuid4()), utc_now()
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("""INSERT INTO portfolio_transactions
            (id,owner_user_id,trade_date,stock_code,side,quantity,price,fees,note,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""", (transaction_id, owner, payload.trade_date.isoformat(), payload.stock_code,
                payload.side, decimal_text(payload.quantity), decimal_text(payload.price), decimal_text(payload.fees), payload.note, now))
        try:
            _ledger(_transaction_rows(connection, owner))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        row = connection.execute("SELECT * FROM portfolio_transactions WHERE id=?", (transaction_id,)).fetchone()
    return dict(row)


@router.delete("/portfolio/transactions/{transaction_id}", status_code=204)
def delete_portfolio_transaction(transaction_id: str):
    owner = _actor_id(write=True)
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute("SELECT 1 FROM portfolio_transactions WHERE id=? AND owner_user_id=?", (transaction_id, owner)).fetchone()
        if not existing:
            raise HTTPException(404, "找不到此组合流水。")
        connection.execute("DELETE FROM portfolio_transactions WHERE id=? AND owner_user_id=?", (transaction_id, owner))
        try:
            _ledger(_transaction_rows(connection, owner))
        except ValueError as exc:
            raise HTTPException(409, "删除这笔买入会造成后续卖出超过持仓，请先修正后续流水。") from exc
