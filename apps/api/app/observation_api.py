from datetime import date
from statistics import mean, median
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import Field, model_validator

from . import conversation_store, market, observation_market, screening_service, security_catalog
from .db import connect, json_dump, json_load, utc_now
from .screening_contracts import ContractModel, ScreeningTaskRevision, UniverseScope, validate_executable_task
from . import research_observations

router = APIRouter(prefix="/api/v1/observation", tags=["选股与观察池"])


@router.post('/quick-add')
def quick_add_candidate(payload: research_observations.QuickCandidateInput):
    try:
        return research_observations.quick_add(payload)
    except research_observations.CandidateError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.post("/research-candidates")
def add_research_candidate(payload: research_observations.CandidateInput):
    try:
        return research_observations.create(payload)
    except research_observations.CandidateError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.get("/research-candidates")
def list_research_candidates(query: str = "", status: research_observations.WatchStatus | None = None,
                            offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100),
                            sort: Literal["updated", "priority", "name", "verification"] = "updated", needs_verification: bool = False):
    return research_observations.list_candidates(query, status, offset, limit, sort, needs_verification)


@router.get("/research-candidates/{candidate_id}")
def get_research_candidate(candidate_id: str):
    try:
        return research_observations.get(candidate_id)
    except research_observations.CandidateError as exc:
        raise HTTPException(exc.status_code, {"code": "research_candidate_error", "message": str(exc)}) from exc


@router.patch("/research-candidates/{candidate_id}")
def update_research_candidate(candidate_id: str, payload: research_observations.CandidatePatch):
    try:
        return research_observations.patch(candidate_id, payload)
    except research_observations.CandidateError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


def _task_name(task):
    return "；".join(c.get("source_quote") or c["description"] for c in task["conditions"])[:100] or "对话选股方案"


_OBSERVATION_ENTRIES = """
WITH entries AS (
    SELECT 'candidate' kind,c.id entry_id,c.id candidate_id,NULL run_id,
           c.stock_code,coalesce(s.name,'') name,c.status,c.note,c.verification,c.updated_at,
           c.origin_kind owner_type,
           CASE WHEN c.origin_kind='manual' THEN 'manual'
                WHEN c.project_id IS NULL THEN 'inbox' ELSE 'project:'||c.project_id END owner_key,
           CASE WHEN c.origin_kind='manual' THEN '手动关注'
                WHEN c.project_id IS NULL THEN '研究收件箱' ELSE coalesce(p.name,'研究项目') END owner_label,
           '' search_extra,'' snapshot_json,c.created_at joined_at,
           date(c.created_at,'+8 hours') basis_date,0 exact_base
      FROM observation_candidate_index c
      LEFT JOIN security_catalog s ON s.stock_code=c.stock_code
      LEFT JOIN research_projects p ON p.id=c.project_id
    UNION ALL
    SELECT 'screening',r.id||':'||d.stock_code,NULL,r.id,
           d.stock_code,coalesce(s.name,''),coalesce(n.status,'watching'),coalesce(n.note,''),'',
           coalesce(n.updated_at,r.created_at),'screening','run:'||r.id,
           coalesce(e.name,json_extract(r.snapshot_json,'$.observation.name'),'选股批次')||' · '||r.as_of,
           '',r.snapshot_json,r.created_at,
           coalesce(json_extract(r.snapshot_json,'$.effective_market_date'),r.as_of),1
      FROM screening_task_decisions d
      JOIN screening_task_runs r ON r.id=d.run_id
      LEFT JOIN observation_notes n ON n.run_id=d.run_id AND n.stock_code=d.stock_code
      LEFT JOIN observation_executions e ON e.conversation_id=r.conversation_id
      LEFT JOIN security_catalog s ON s.stock_code=d.stock_code
      WHERE d.state='true'
)
"""


def _entry_payload(row, metrics=None, latest_date=None):
    item = dict(row)
    if item['kind'] == 'screening' and item['owner_label'].startswith('选股批次 · '):
        snapshot = json_load(item['snapshot_json'])
        item['owner_label'] = _task_name(snapshot['task']) + ' · ' + snapshot.get('effective_market_date', '')
    item.pop('snapshot_json')
    item.pop('search_extra')
    item.pop('exact_base')
    if metrics is not None:
        item.update(metrics.get(item['entry_id'], {
            'return_latest': None, 'max_drawdown': None, 'base_date': None, 'price_date': None,
            'metric_reason': '起算日之后暂无行情' if latest_date and item['basis_date'] > latest_date else '缺少有效行情',
        }))
    return item


@router.get('/entries')
def list_entries(query: str = "", status: Literal['watching', 'priority', 'ended'] | None = None,
                 owner: str = "", sort: Literal['updated', 'priority', 'name'] = 'updated',
                 offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100),
                 include_metrics: bool = True):
    """One paginated list across research, manual, and screening observations."""
    clauses, args = [], []
    query = query.strip()[:100]
    if query:
        clauses.append("instr(lower(stock_code||' '||name||' '||note||' '||owner_label||' '||search_extra),lower(?))>0")
        args.append(query)
    if status:
        clauses.append('status=?')
        args.append(status)
    if owner:
        if owner in {'research', 'manual', 'screening'}:
            clauses.append('owner_type=?')
            args.append(owner)
        elif owner == 'inbox' or owner.startswith(('project:', 'run:')):
            clauses.append('owner_key=?')
            args.append(owner)
        else:
            raise HTTPException(422, '无效的所属筛选。')
    where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    order = {
        'updated': 'updated_at DESC,entry_id',
        'priority': "(status='priority') DESC,updated_at DESC,entry_id",
        'name': "coalesce(nullif(name,''),stock_code),stock_code,entry_id",
    }[sort]
    with connect() as connection:
        total = connection.execute(_OBSERVATION_ENTRIES + 'SELECT count(*) FROM entries' + where, args).fetchone()[0]
        rows = connection.execute(_OBSERVATION_ENTRIES + 'SELECT * FROM entries' + where + f' ORDER BY {order} LIMIT ? OFFSET ?', (*args, limit, offset)).fetchall()
        if not include_metrics:
            return {'items': [_entry_payload(row) for row in rows], 'total': total}
        filtered = connection.execute(_OBSERVATION_ENTRIES + 'SELECT entry_id,owner_type,status FROM entries' + where, args).fetchall()
        metric_inputs = connection.execute(_OBSERVATION_ENTRIES + 'SELECT entry_id,stock_code,basis_date,exact_base FROM entries').fetchall()
    profile = market.cached_profile()
    latest_date = profile.get('last_date')
    try:
        metrics = observation_market.entry_metrics((tuple(row) for row in metric_inputs), latest_date)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    usable = [metrics[row['entry_id']] for row in filtered if metrics.get(row['entry_id'], {}).get('return_latest') is not None]
    movements = [item['return_latest'] for item in usable]
    drawdowns = [item['max_drawdown'] for item in usable]
    summary = {
        'total': total,
        'research_count': sum(row['owner_type'] in {'research', 'manual'} for row in filtered),
        'screening_count': sum(row['owner_type'] == 'screening' for row in filtered),
        'priced_count': len(usable),
        'average_return': mean(movements) if movements else None,
        'worst_drawdown': min(drawdowns) if drawdowns else None,
        'positive_rate': 100 * sum(value > 0 for value in movements) / len(movements) if movements else None,
    }
    metric_note = '汇总按观察记录计算，同一股票在不同所属中分别计入；涨跌幅按有效收盘价计算，不含分红和交易费用，最大回撤采用收盘价峰谷。'
    if profile.get('price_basis') not in {'forward_adjusted', 'back_adjusted'}:
        metric_note += ' 复权口径未确认，除权除息可能影响数值。'
    return {'items': [_entry_payload(row, metrics, latest_date) for row in rows], 'total': total,
            'summary': summary, 'metric_note': metric_note,
            'latest_date': latest_date}


@router.get('/owners')
def observation_owners():
    """Only offer filters that currently contain observation entries."""
    with connect() as connection:
        candidates = connection.execute("""SELECT c.origin_kind,c.project_id,p.name,count(*) count
            FROM observation_candidate_index c LEFT JOIN research_projects p ON p.id=c.project_id
            GROUP BY c.origin_kind,c.project_id ORDER BY p.name""").fetchall()
        runs = connection.execute("""SELECT r.id,e.name,r.snapshot_json,r.as_of,count(*) count
            FROM screening_task_decisions d JOIN screening_task_runs r ON r.id=d.run_id
            LEFT JOIN observation_executions e ON e.conversation_id=r.conversation_id
            WHERE d.state='true' GROUP BY r.id ORDER BY r.created_at DESC""").fetchall()
    items = []
    for row in candidates:
        if row['origin_kind'] == 'manual':
            items.append({'value': 'manual', 'label': '手动关注', 'group': 'research', 'count': row['count']})
        elif row['project_id']:
            items.append({'value': 'project:' + row['project_id'], 'label': row['name'] or '研究项目', 'group': 'research', 'count': row['count']})
        else:
            items.append({'value': 'inbox', 'label': '研究收件箱', 'group': 'research', 'count': row['count']})
    for row in runs:
        snapshot = json_load(row['snapshot_json'])
        name = row['name'] or snapshot.get('observation', {}).get('name') or _task_name(snapshot['task'])
        items.append({'value': 'run:' + row['id'], 'label': name + ' · ' + row['as_of'],
                      'group': 'screening', 'count': row['count']})
    return {'items': items}


class ExecuteSaved(ContractModel):
    request_id: str = Field(min_length=1, max_length=100)
    version: int = Field(ge=1)
    as_of: date
    universe: UniverseScope | None = None


class NoteInput(ContractModel):
    status: Literal["watching", "priority", "ended"] = "watching"
    note: str = Field(default="", max_length=2000)


class NotePatch(ContractModel):
    status: Literal["watching", "priority", "ended"] | None = None
    note: str | None = Field(default=None, max_length=2000)
    expected_note: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def validate_changes(self):
        changes = self.model_fields_set & {"status", "note"}
        if not changes or any(getattr(self, field) is None for field in changes):
            raise ValueError("请选择要修改的状态或备注。")
        return self


@router.patch('/runs/{run_id}/notes/{stock_code}')
def patch_observation_note(run_id: str, stock_code: str, payload: NotePatch):
    with connect() as connection:
        connection.execute('BEGIN IMMEDIATE')
        if not connection.execute("SELECT 1 FROM screening_task_decisions WHERE run_id=? AND stock_code=? AND state='true'", (run_id, stock_code)).fetchone():
            raise HTTPException(404, '这次选股没有该股票的入选记录。')
        previous = connection.execute('SELECT status,note FROM observation_notes WHERE run_id=? AND stock_code=?', (run_id, stock_code)).fetchone()
        note = previous['note'] if previous else ''
        if 'note' in payload.model_fields_set and payload.expected_note is not None and note != payload.expected_note:
            raise HTTPException(409, '备注已在其他地方修改，请核对最新记录后再保存。')
        status = payload.status if 'status' in payload.model_fields_set else previous['status'] if previous else 'watching'
        note = payload.note if 'note' in payload.model_fields_set else note
        now = utc_now()
        connection.execute('''INSERT INTO observation_notes VALUES(?,?,?,?,?)
            ON CONFLICT(run_id,stock_code) DO UPDATE SET status=excluded.status,note=excluded.note,updated_at=excluded.updated_at''',
            (run_id, stock_code, status, note, now))
    return {'status': status, 'note': note, 'updated_at': now}


def _run(run_id):
    with connect() as connection:
        row = connection.execute("SELECT * FROM screening_task_runs WHERE id=?", (run_id,)).fetchone()
    if not row:
        raise HTTPException(404, "找不到这次选股记录。")
    return dict(row), json_load(row["snapshot_json"])


@router.post("/saved-tasks/{asset_id}/execute", status_code=202)
def execute_saved(asset_id: str, payload: ExecuteSaved):
    request_json = json_dump({"asset_id": asset_id, **payload.model_dump(mode="json")})
    try:
        # Persist the button's execution request atomically. Retrying a lost response
        # resumes this same authorized turn, including after enqueue validation fails.
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute("SELECT * FROM observation_executions WHERE request_id=?", (payload.request_id,)).fetchone()
            if existing:
                if existing["request_json"] != request_json:
                    raise HTTPException(409, "相同执行请求不能更换条件、版本或日期。")
                execution = dict(existing)
            else:
                saved = connection.execute("SELECT * FROM saved_screening_tasks WHERE id=? AND version=?", (asset_id, payload.version)).fetchone()
                if not saved:
                    raise HTTPException(404, "找不到已保存方案的这个版本。")
                raw = json_load(saved["task_json"])
                cid, now = str(uuid4()), utc_now()
                raw.update(task_id=cid, revision=1)
                raw["scope"]["as_of"] = payload.as_of.isoformat()
                if payload.universe:
                    raw["scope"]["universe"] = payload.universe.model_dump(mode="json")
                task = ScreeningTaskRevision.model_validate(raw)
                validate_executable_task(task)
                connection.execute("INSERT INTO conversations(id,entry_scope,workflow_type,research_mode,created_at,updated_at) VALUES(?,'screening','screening','screening',?,?)", (cid, now, now))
                message = conversation_store.add_user_message(cid, payload.request_id, 0,
                    f"执行已保存方案“{saved['name']}”第{payload.version}版，行情截止{payload.as_of.isoformat()}。",
                    _connection=connection)
                conversation_store.save_task_revision(cid, 0, message["message_id"], task, _connection=connection)
                conversation_store.finish_turn(cid, message["turn_id"], 1, "succeeded", "已记录选股页的执行请求。", {
                    "intent": "execute", "task_revision": 1, "execution_authorized": True,
                    "ready_to_execute": True, "execution_authorization_message_id": message["message_id"],
                }, pending_execute_message_id=message["message_id"], _connection=connection)
                connection.execute("INSERT INTO observation_executions VALUES(?,?,?,?,?,?,?,?)",
                    (payload.request_id, request_json, asset_id, payload.version, saved["name"], cid, message["turn_id"], now))
                execution = {"conversation_id": cid, "turn_id": message["turn_id"], "name": saved["name"]}
        result = screening_service.enqueue_turn(execution["conversation_id"], execution["turn_id"], observation={
            "asset_id": asset_id, "asset_version": payload.version, "name": execution["name"],
        })
        return {**result, "conversation_id": execution["conversation_id"]}
    except screening_service.ScreeningServiceError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    except (ValueError, conversation_store.ConversationStoreError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/runs")
def list_runs(offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=200), query: str = ""):
    # Includes existing conversation runs; obsolete manual watchlists are not imported.
    with connect() as connection:
        clause = "(?='' OR coalesce(e.name,r.snapshot_json) LIKE ?)"
        params = (query, f"%{query[:100]}%")
        total = connection.execute(f"SELECT count(*) FROM screening_task_runs r LEFT JOIN observation_executions e ON e.conversation_id=r.conversation_id WHERE {clause}", params).fetchone()[0]
        rows = connection.execute(f"""SELECT r.*,e.name,e.asset_version FROM screening_task_runs r
            LEFT JOIN observation_executions e ON e.conversation_id=r.conversation_id
            WHERE {clause} ORDER BY r.created_at DESC,r.rowid DESC LIMIT ? OFFSET ?""", (*params, limit, offset)).fetchall()
    items = []
    for row in rows:
        snapshot = json_load(row["snapshot_json"])
        items.append({"id": row["id"], "conversation_id": row["conversation_id"], "as_of": row["as_of"],
            "signal_date": snapshot.get("effective_market_date", row["as_of"]), "created_at": row["created_at"],
            "status": row["status"], "version": row["asset_version"] or row["task_revision"],
            "name": row["name"] or _task_name(snapshot["task"]),
            "counts": json_load(row["result_json"]).get("coverage", {})})
    return {"items": items, "total": total}


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    row, snapshot = _run(run_id)
    result = screening_service.get_task_run(row["conversation_id"], run_id)
    metadata = snapshot.get("observation", {})
    return {**result, "name": metadata.get("name") or _task_name(result["task"]),
        "version": metadata.get("asset_version", row["task_revision"]),
        "historical_replay": metadata.get("historical_replay", False),
        "signal_date": snapshot.get("effective_market_date", row["as_of"]),
        "reference_prices": metadata.get("reference_prices", {})}


@router.get("/runs/{run_id}/decisions")
def decisions(run_id: str, state: str = "true", query: str = "", offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100)):
    row, _ = _run(run_id)
    try:
        return screening_service.list_task_decisions(row["conversation_id"], run_id, state=state, query=query, offset=offset, limit=limit)
    except screening_service.ScreeningServiceError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.get("/runs/{run_id}/snapshot")
def export_snapshot(run_id: str):
    row, snapshot = _run(run_id)
    if row["status"] in {"queued", "running"}:
        raise HTTPException(409, "选股尚未完成，请稍后导出。")
    with connect() as connection:
        rows = connection.execute("SELECT stock_code,decision_json FROM screening_task_decisions WHERE run_id=? ORDER BY stock_code", (run_id,)).fetchall()
    return JSONResponse({"run_id": run_id, "executed_at": row["created_at"], "finished_at": row["finished_at"],
        "as_of": row["as_of"], "status": row["status"], "snapshot": snapshot,
        "summary": json_load(row["result_json"]), "results": {item["stock_code"]: json_load(item["decision_json"]) for item in rows}},
        headers={"Content-Disposition": f'attachment; filename="screening-{run_id}.json"'})


def _stats(values):
    known = [value for value in values if value is not None]
    return {"count": len(known), "average": mean(known) if known else None,
            "median": median(known) if known else None,
            "positive_rate": 100 * sum(value > 0 for value in known) / len(known) if known else None}


@router.get("/runs/{run_id}/performance")
def performance(run_id: str):
    row, snapshot = _run(run_id)
    signal = snapshot.get("effective_market_date", row["as_of"])
    with connect() as connection:
        selected = connection.execute("""SELECT d.stock_code,n.status,n.note,n.updated_at
            FROM screening_task_decisions d LEFT JOIN observation_notes n
            ON n.run_id=d.run_id AND n.stock_code=d.stock_code
            WHERE d.run_id=? AND d.state='true' ORDER BY d.stock_code""", (run_id,)).fetchall()
    codes = [item["stock_code"] for item in selected]
    profile = market.cached_profile()
    latest = profile.get("last_date")
    basis = profile.get("price_basis", "unknown")
    comparable = basis in {"forward_adjusted", "back_adjusted"}
    try:
        cohort = observation_market.cohort_prices(codes, signal, latest)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    names = security_catalog.names()
    frozen = snapshot.get("observation", {}).get("reference_prices", {})
    items = []
    for selected_row in selected:
        code = selected_row["stock_code"]
        prices = cohort["prices"].get(code, {})
        base = prices.get("base_close")
        reason = "复权口径未确认" if not comparable else "信号日行情缺失或异常" if not base else ""
        def change(value):
            return (value / base - 1) * 100 if not reason and value is not None else None
        returns = {str(n): change(prices.get(f"close_{n}")) for n in (5, 10, 20)}
        fresh = prices.get("latest_date") == latest
        items.append({"stock_code": code, "name": names.get(code, ""), "status": selected_row["status"] or "watching",
            "note": selected_row["note"] or "", "updated_at": selected_row["updated_at"],
            "reference_close": frozen.get(code, {}).get("close"), "reference_date": frozen.get(code, {}).get("trade_date"),
            "calculation_base": base, "latest_close": prices.get("latest_close"), "latest_date": prices.get("latest_date"),
            "days": cohort["days"], "observed_days": prices.get("observed_days", 0),
            "return_latest": change(prices.get("latest_close")) if fresh and cohort["days"] > 0 else None,
            "returns": returns, "peak_return": change(prices.get("peak")) if not prices.get("invalid_bars") else None,
            "trough_return": change(prices.get("trough")) if not prices.get("invalid_bars") else None,
            "reason": reason or ("最新交易日缺行情，可能停牌或数据缺失" if not fresh else ""),
            "invalid_bars": prices.get("invalid_bars", 0)})
    return {"items": items, "latest_date": latest, "signal_date": signal, "price_basis": basis,
        "warning": "价格复权口径尚未确认，暂不计算涨跌幅；入选参考价、最新价和观察备注仍可查看。" if not comparable else "涨跌幅以当前同一复权序列的信号日收盘价计算。原入选参考价单独保留。",
        "summary": {"selected": len(items), "latest": _stats([item["return_latest"] for item in items]),
            **{str(n): _stats([item["returns"][str(n)] for item in items]) for n in (5, 10, 20)}}}


@router.put("/runs/{run_id}/notes/{stock_code}")
def save_note(run_id: str, stock_code: str, payload: NoteInput):
    with connect() as connection:
        if not connection.execute("SELECT 1 FROM screening_task_decisions WHERE run_id=? AND stock_code=? AND state='true'", (run_id, stock_code)).fetchone():
            raise HTTPException(404, "这次选股没有该股票的入选记录。")
        now = utc_now()
        connection.execute("""INSERT INTO observation_notes VALUES(?,?,?,?,?)
            ON CONFLICT(run_id,stock_code) DO UPDATE SET status=excluded.status,note=excluded.note,updated_at=excluded.updated_at""",
            (run_id, stock_code, payload.status, payload.note, now))
    return {"status": payload.status, "note": payload.note, "updated_at": now}


@router.get("/runs/{run_id}/chart/{stock_code}")
def chart(run_id: str, stock_code: str, view: Literal["selection", "observation"] = "observation"):
    row, snapshot = _run(run_id)
    with connect() as connection:
        decision = connection.execute("SELECT decision_json,state FROM screening_task_decisions WHERE run_id=? AND stock_code=?", (run_id, stock_code)).fetchone()
        if not decision:
            raise HTTPException(404, "本批次没有该股票的判断记录。")
        events = connection.execute("""SELECT r.id,r.as_of,r.created_at,r.snapshot_json,e.name FROM screening_task_runs r
            JOIN screening_task_decisions d ON d.run_id=r.id
            LEFT JOIN observation_executions e ON e.conversation_id=r.conversation_id
            WHERE d.stock_code=? AND d.state='true' ORDER BY r.as_of,r.created_at""", (stock_code,)).fetchall()
    signal = snapshot.get("effective_market_date", row["as_of"])
    cutoff = signal if view == "selection" else market.cached_profile().get("last_date") or signal
    bars = observation_market.chart_bars(stock_code, signal, cutoff)
    marks = []
    dates = {bar["trade_date"] for bar in bars}
    for event in events:
        event_snapshot = json_load(event["snapshot_json"])
        day = event_snapshot.get("effective_market_date", event["as_of"])
        if day in dates:
            marks.append({"run_id": event["id"], "date": day, "executed_at": event["created_at"],
                "name": event["name"] or "历史选股", "current": event["id"] == run_id})
    return {"bars": bars, "markers": marks, "signal_date": signal, "cutoff": cutoff,
            "decision": json_load(decision["decision_json"])}
