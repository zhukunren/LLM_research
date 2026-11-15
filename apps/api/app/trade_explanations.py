"""Public-source Codex communication research, independent of strategy upstreams."""
from __future__ import annotations
import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Literal
from fastapi import HTTPException
from pydantic import BaseModel, Field, ConfigDict
from . import conversation_store, research_turn_service, codex_runtime
from .db import connect, json_dump, json_load, utc_now
from .screening_contracts import ResearchScope
from .security_catalog import names

class ExplainRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$')
    code: str = Field(pattern=r'^\d{6}\.(SH|SZ|BJ)$')
    date: date
    side: Literal['buy','sell']


def technical_snapshot(history: dict) -> dict:
    bars = history['items']; last = bars[-1]
    def average(key, count, previous=False):
        rows = bars[-count-1:-1] if previous else bars[-count:]
        values = [r.get(key) for r in rows]
        return sum(values) / count if len(values) == count and all(isinstance(v,(float,int)) for v in values) else None
    def change(days):
        old = bars[-days-1]['close'] if len(bars)>days else None
        return (last['close']/old-1)*100 if old else None
    volume_mean = average('volume',20,True)
    return {'requested_count':180,'sample_count':len(bars),'data_start':bars[0]['trade_date'],'data_end':last['trade_date'],
        'close':last['close'],'ma5':average('close',5),'ma20':average('close',20),'ma60':average('close',60),
        'change_5d_pct':change(5),'change_20d_pct':change(20),'volume':last.get('volume'),
        'volume_unit':history['volume_unit'],'volume_vs_previous_20d':last['volume']/volume_mean if volume_mean and last.get('volume') is not None else None,
        'source':history['source'],'price_basis':history.get('price_basis','未复权'),'recent_bars':bars[-20:]}


def _prompt(payload, stock_name, technical):
    side = '买入' if payload.side=='buy' else '卖出'
    return f'''任务：仅向客户解释{stock_name or payload.code}（{payload.code}）的{side}操作考虑与合理性。
这不是查找上游量化策略触发原因，也不是要求给出新的交易指令。不要访问策略回测平台、策略接口或策略源码，不引用策略胜率、年化收益作为个股获利概率。
研究截止日：{payload.date.isoformat()}。先使用 Codex 原生网页搜索检索该公司公开资料，并打开至少一条相关原文；优先交易所/公司公告及可信财经来源。资料发布时间必须不晚于截止日，不能用之后的信息或之后股价倒推操作合理性。无法确认时点或公开资料不足时明确列为限制，不编造利好、利空、资金流、持仓成本或客户身份。
结合下方经服务端计算的量价事实分析趋势、动量、成交量及风险。不把一般框架说成已命中的策略条件，不虚构已经成交。若事实不足以支持某一判断，应如实说明；不能为了替操作辩护而筛选性取证。
客户文案约200至350字，直接面向客户解释{side}考虑，可用“这次操作可以从……角度理解”等措辞，不为未知决策动机作事实背书。不要把“无法确认客户是否成交、动机或成本”等内部核验提示写入client_copy，这些仅放limitations；也不要虚构这些客户信息。未提供操作时刻时，不把当日盘后消息说成操作前已知事实。使用客户易懂语言。不要承诺收益、预测必涨必跌、给具体买卖价位或断言适合某位客户。保留必要的风险提示，不反复堆叠免责声明。无需生成报告、PDF或其他文件。
最终只输出一个JSON对象，不要代码围栏：{{"client_copy":"可复制客户文案","analysis":"公开信息与技术面的内部核对说明","sources":[{{"title":"原文标题","url":"实际打开的http(s)地址","published_at":"YYYY-MM-DD或null"}}],"limitations":["实质信息缺口"]}}。
量价事实（均不晚于截止日；data_end早于截止日时不能当作当日行情）：
{json.dumps(technical,ensure_ascii=False)}'''


def start_explanation(payload: ExplainRequest):
    if payload.date > datetime.now(timezone(timedelta(hours=8))).date():
        raise HTTPException(422, {'message':'不能解释未来日期的操作。'})
    fingerprint = hashlib.sha256(json_dump(payload.model_dump(mode='json',exclude={'request_id'})).encode()).hexdigest()
    with connect() as db:
        previous = db.execute('SELECT * FROM trade_explanations WHERE request_id=?',(payload.request_id,)).fetchone()
    if previous:
        if previous['request_hash'] != fingerprint:
            raise HTTPException(409, {'message':'同一请求不能更换股票、日期或方向。'})
        research_turn_service.enqueue_turn(previous['conversation_id'], previous['turn_id'])
        return explanation_status(payload.request_id)
    available=codex_runtime.availability()
    if not available.get('available') or not available.get('web_search',{}).get('enabled') or available.get('web_search',{}).get('mode','live') != 'live':
        raise HTTPException(503, {'message':'Codex 原生搜索暂不可用，请检查模型配置。'})
    from .daily_signals_api import chart_history
    technical=technical_snapshot(chart_history(payload.code,payload.date))
    stock_name=names().get(payload.code,'')
    content=_prompt(payload,stock_name,technical)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        previous=db.execute('SELECT * FROM trade_explanations WHERE request_id=?',(payload.request_id,)).fetchone()
        if previous:
            if previous['request_hash'] != fingerprint:
                raise HTTPException(409, {'message':'请求内容已变化。'})
            conversation_id,turn_id=previous['conversation_id'],previous['turn_id']
        else:
            conversation=conversation_store.create_conversation('news',workflow_type='research',_connection=db)
            conversation_id=conversation['id']
            scope=ResearchScope(as_of=payload.date).model_dump(mode='json')
            db.execute('UPDATE conversations SET research_scope_json=?,title=? WHERE id=?',
                (json_dump(scope),f"{'买入' if payload.side=='buy' else '卖出'}说明 · {stock_name or payload.code}",conversation_id))
            message=conversation_store.add_user_message(conversation_id,'trade-copy:'+payload.request_id,0,content,
                research_scope_revision=0,assistant_revision=0,_connection=db)
            turn_id=message['turn_id']
            db.execute('INSERT INTO trade_explanations VALUES(?,?,?,?,?,?)',
                (payload.request_id,fingerprint,conversation_id,turn_id,json_dump(payload.model_dump(mode='json')),utc_now()))
    research_turn_service.enqueue_turn(conversation_id,turn_id)
    return explanation_status(payload.request_id)


def explanation_status(request_id: str):
    with connect() as db:
        row=db.execute('SELECT * FROM trade_explanations WHERE request_id=?',(request_id,)).fetchone()
    if not row:
        raise HTTPException(404, {'message':'找不到这份操作说明。'})
    turn=conversation_store.get_turn(row['conversation_id'],row['turn_id'])
    result={'request_id':request_id,'conversation_id':row['conversation_id'],'turn_id':row['turn_id'],
        'state':turn['state'],'message':(turn.get('job') or {}).get('message') or '等待 Codex 研究',
        'side':json_load(row['payload_json'])['side']}
    if turn['state']=='succeeded':
        text=turn.get('response_text') or ''
        try:
            parsed=json.loads(re.sub(r'^```(?:json)?\s*|\s*```$','',text.strip()))
            if not isinstance(parsed,dict) or not isinstance(parsed.get('client_copy'),str) or not parsed['client_copy'].strip():
                raise ValueError()
        except (ValueError,TypeError):
            result.update(state='failed',message='Codex 返回的客户说明格式不完整，请重新生成。')
            return result
        with connect() as db:
            events=[json_load(r['payload_json']).get('item',{}) for r in db.execute(
                "SELECT payload_json FROM codex_turn_events WHERE conversation_id=? AND app_turn_id=? AND method='item/completed'",
                (row['conversation_id'],row['turn_id']))]
        searched=False;opened=set()
        for item in events:
            if not isinstance(item,dict):continue
            kind=re.sub('[^a-z]','',str(item.get('type','')).lower())
            if kind not in {'websearch','websearchcall'}:continue
            action=item.get('action') or {}
            if action.get('type')=='search' or any(re.search(r'turn\d+search\d+',str(v.get('ref_id',''))) for v in item.get('results') or [] if isinstance(v,dict)):
                searched=True
            if action.get('type') in {'openPage','open_page'} and isinstance(action.get('url'),str):opened.add(action['url'])
            for value in item.get('results') or []:
                if isinstance(value,dict) and re.fullmatch(r'turn\d+view\d+',str(value.get('ref_id',''))) and isinstance(value.get('url'),str):opened.add(value['url'])
        sources=[]
        for source in parsed.get('sources',[]) if isinstance(parsed.get('sources'),list) else []:
            if not isinstance(source,dict) or not isinstance(source.get('url'),str) or source['url'] not in opened or not source['url'].startswith(('https://','http://')):continue
            published=source.get('published_at')
            if published:
                try:
                    if date.fromisoformat(str(published)[:10])>date.fromisoformat(json_load(row['payload_json'])['date']):continue
                except ValueError:continue
            sources.append({'title':str(source.get('title') or source['url']),'url':source['url'],'published_at':published})
        if not searched or not opened or not sources:
            result.update(state='failed',message='未取得实际检索并打开的公开来源，请重新生成。')
            return result
        result.update(client_copy=parsed['client_copy'],analysis=str(parsed.get('analysis') or ''),sources=sources,
            limitations=[str(x) for x in parsed.get('limitations',[]) if isinstance(x,str)] if isinstance(parsed.get('limitations'),list) else [])
    elif turn['state'] in {'failed','cancelled','awaiting_user'}:
        result['message']=turn.get('response_text') or '研究未完成，可重新生成。'
    return result


def cancel_explanation(request_id: str):
    status=explanation_status(request_id)
    from .conversation_api import cancel_research_turn
    cancel_research_turn(status['conversation_id'],status['turn_id'])
    return explanation_status(request_id)


def is_explanation(conversation_id: str, turn_id: str) -> bool:
    with connect() as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trade_explanations'").fetchone():
            return False
        return db.execute('SELECT 1 FROM trade_explanations WHERE conversation_id=? AND turn_id=?',(conversation_id,turn_id)).fetchone() is not None
