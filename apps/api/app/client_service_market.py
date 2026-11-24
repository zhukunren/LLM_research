"""Acquire dated index quotes before composing a client brief; keep numeric evidence server-owned."""
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
import re
import subprocess
import sys
from zoneinfo import ZoneInfo

import requests

from .db import connect, json_dump, json_load, utc_now
from .settings import PROJECT_ROOT

TZ = ZoneInfo('Asia/Shanghai')
INDEXES = {'000001.SH': ('上证指数','sh000001'), '399001.SZ': ('深证成指','sz399001'), '399006.SZ': ('创业板指','sz399006')}


def number(value):
    try:
        result=Decimal(str(value).replace(',',''))
        return result if result.is_finite() else None
    except (InvalidOperation,ValueError): return None


def quote(code,price,previous,observed,provider,url,raw,change=None):
    price,previous=number(price),number(previous)
    pct=number(change)
    if price is None or price<=0:return None
    if pct is None and previous is not None and previous>0:pct=(price/previous-1)*100
    if pct is None or abs(pct)>30:return None
    # Provider percentages and prices must describe the same quote.
    if previous is not None and previous>0 and abs(pct-(price/previous-1)*100)>Decimal('.08'):return None
    return {'code':code,'label':INDEXES[code][0],'value':f'{price:.2f}点 {pct:+.2f}%',
            'price':str(price),'pct_chg':str(pct),'pre_close':str(previous) if previous else None,
            'observed_at':observed.isoformat(),'source_url':url,'provider':provider,'raw':raw}


def eligible(item,cutoff,*,preopen=False):
    if not item:return False
    try:observed=datetime.fromisoformat(item['observed_at']).astimezone(TZ)
    except (ValueError,TypeError):return False
    if observed>cutoff:return False
    if preopen:return cutoff.date()-timedelta(days=10)<=observed.date()<cutoff.date()
    return observed.date()==cutoff.date()


def tencent_quote_rows(symbols):
    url='https://qt.gtimg.cn/'
    response=requests.get(url,params={'q':','.join(symbols)},timeout=8)
    response.raise_for_status()
    return {symbol: value.split('~') for symbol, value in re.findall(r'v_([a-z0-9]+)="([^"]+)"', response.text)}


def tencent_quotes():
    rows = tencent_quote_rows([symbol for _, symbol in INDEXES.values()])
    values=[]
    for code,(_,symbol) in INDEXES.items():
        row=rows.get(symbol, [])
        if len(row)<39 or row[2]!=code[:6]:continue
        try:observed=datetime.strptime(row[30],'%Y%m%d%H%M%S').replace(tzinfo=TZ)
        except ValueError:continue
        value=quote(code,row[3],row[4],observed,'腾讯财经',f'https://gu.qq.com/{symbol}/zs','~'.join(row),row[32])
        if value:
            value['amount_yuan']=str(number(row[37])*10000) if number(row[37]) is not None else None
            values.append(value)
    return values


def tencent_minutes(code,cutoff,reference):
    symbol=INDEXES[code][1]
    response=requests.get('https://web.ifzq.gtimg.cn/appstock/app/minute/query',params={'code':symbol},timeout=8)
    response.raise_for_status()
    body=response.json()['data'][symbol]['data']
    day=datetime.strptime(str(body['date']).replace('-',''),'%Y%m%d').date()
    if day!=cutoff.date():return []
    values=[]
    for line in body.get('data',[]):
        parts=line.split()
        if len(parts)<2 or not re.fullmatch(r'\d{4}',parts[0]):continue
        observed=datetime.combine(day,datetime.strptime(parts[0],'%H%M').time(),TZ)
        if observed>cutoff:continue
        value=quote(code,parts[1],reference['pre_close'],observed,'腾讯财经分时',f'https://gu.qq.com/{symbol}/zs',line)
        if value:
            value['amount_yuan']=str(number(parts[3])) if len(parts)>3 and number(parts[3]) is not None else None
            values.append(value)
    return values[-1:]


def tushare_quotes(cutoff,*,live=False,preopen=False):
    from .tushare_sync import create_client, _payload_rows
    client=create_client();client._timeout=min(client._timeout,8);client._retries=0
    values=[]
    if live:
        rows=_payload_rows(client.raw_query('rt_idx_k',ts_code=','.join(INDEXES)),'rt_idx_k')
        for row in rows:
            code=str(row.get('ts_code',''))
            if code not in INDEXES:continue
            stamp=row.get('trade_time') or row.get('time') or row.get('datetime')
            if not stamp:continue
            try:observed=datetime.fromisoformat(str(stamp)).replace(tzinfo=TZ)
            except ValueError:continue
            values.append(quote(code,row.get('close'),row.get('pre_close'),observed,'Tushare rt_idx_k','https://tushare.pro/document/2?doc_id=403',row,row.get('pct_chg')))
    elif preopen or cutoff.hour>=15:
        end=cutoff.date()-timedelta(days=int(preopen))
        for code in INDEXES:
            rows=_payload_rows(client.raw_query('index_daily',ts_code=code,start_date=(end-timedelta(days=10)).strftime('%Y%m%d'),end_date=end.strftime('%Y%m%d')),'index_daily')
            for row in sorted(rows,key=lambda item:str(item.get('trade_date','')),reverse=True):
                try:observed=datetime.strptime(str(row['trade_date']),'%Y%m%d').replace(hour=15,tzinfo=TZ)
                except (ValueError,KeyError):continue
                if observed<=cutoff:
                    values.append(quote(code,row.get('close'),row.get('pre_close'),observed,'Tushare index_daily','https://tushare.pro/document/2?doc_id=95',row,row.get('pct_chg')));break
    else:
        # Historical minute data have their own entitlement; unavailable access
        # is handled by the same provider fallback as an empty response.
        for code in INDEXES:
            rows=_payload_rows(client.raw_query('idx_mins',ts_code=code,freq='1min',start_date=cutoff.strftime('%Y-%m-%d 09:00:00'),end_date=cutoff.strftime('%Y-%m-%d %H:%M:%S')),'idx_mins')
            daily=_payload_rows(client.raw_query('index_daily',ts_code=code,trade_date=cutoff.strftime('%Y%m%d')),'index_daily')
            previous=daily[0].get('pre_close') if daily else None
            for row in sorted(rows,key=lambda item:str(item.get('trade_time','')),reverse=True):
                observed=datetime.fromisoformat(str(row['trade_time'])).replace(tzinfo=TZ)
                if observed<=cutoff:
                    values.append(quote(code,row.get('close'),previous,observed,'Tushare idx_mins','https://tushare.pro/document/2?doc_id=419',row));break
    return [item for item in values if item]


def akshare_quotes(cutoff,references,*,preopen=False):
    # AKShare's providers do not all accept a timeout. Run a fixed adapter in a
    # bounded child so an upstream stall cannot occupy the research worker.
    request={'cutoff':cutoff.isoformat(),'preopen':preopen}
    result=subprocess.run([sys.executable,'-m','apps.api.app.client_service_market_akshare',json.dumps(request)],
        cwd=PROJECT_ROOT,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=30,
        env={**os.environ,'PYTHONIOENCODING':'utf-8'},creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    if result.returncode:raise ValueError('AkShare 数据源暂未返回有效记录')
    rows=json.loads(result.stdout);values=[]
    for row in rows:
        code=row['code'];raw=row['raw'];observed=datetime.fromisoformat(row['observed_at'])
        previous=raw.get('pre_close') or (references.get(code) or {}).get('pre_close')
        value=quote(code,raw.get('close'),previous,observed,'AkShare · '+row.get('provider','东方财富'),row.get('source_url') or f'https://quote.eastmoney.com/zs{code[:6]}.html',raw,raw.get('pct_chg'))
        if value:values.append(value)
    return values


def collect(cutoff):
    cutoff=(datetime.fromisoformat(cutoff) if isinstance(cutoff,str) else cutoff).astimezone(TZ)
    preopen=(cutoff.hour,cutoff.minute)<(9,30)
    found={};attempts=[];references={}
    def accept(values):
        for item in values:
            if eligible(item,cutoff,preopen=preopen):found.setdefault(item['code'],item)
    try:accept(tushare_quotes(cutoff,preopen=preopen));attempts.append({'provider':'Tushare','state':'complete' if len(found)==3 else 'empty'})
    except Exception as exc:attempts.append({'provider':'Tushare','state':'unavailable','reason':type(exc).__name__})
    if len(found)<3:
        try:
            references={item['code']:item for item in tencent_quotes()}
            accept(references.values())
            for code in INDEXES.keys()-found.keys():
                reference=references.get(code)
                if reference and datetime.fromisoformat(reference['observed_at']).date()==cutoff.date() and not preopen:
                    accept(tencent_minutes(code,cutoff,reference))
            attempts.append({'provider':'腾讯财经','state':'complete' if len(found)==3 else 'partial'})
        except Exception as exc:attempts.append({'provider':'腾讯财经','state':'unavailable','reason':type(exc).__name__})
    if len(found)<3:
        try:accept(akshare_quotes(cutoff,references,preopen=preopen));attempts.append({'provider':'AkShare','state':'complete' if len(found)==3 else 'partial'})
        except Exception as exc:attempts.append({'provider':'AkShare','state':'unavailable','reason':type(exc).__name__})
    metrics=[found[code] for code in INDEXES if code in found]
    return {'cutoff':cutoff.isoformat(),'metrics':metrics,'sources':[{'title':item['provider'],'url':item['source_url'],'published_at':None} for item in metrics],
            'missing':[INDEXES[code][0] for code in INDEXES if code not in found], 'attempts':attempts}


def read(conversation_id,turn_id):
    with connect() as c:row=c.execute('SELECT payload_json FROM client_service_market_snapshots WHERE conversation_id=? AND turn_id=?',(conversation_id,turn_id)).fetchone()
    return json_load(row['payload_json']) if row else None


def prepare(conversation_id,turn_id):
    with connect() as c:card=c.execute('SELECT cutoff FROM client_service_cards WHERE conversation_id=? AND turn_id=?',(conversation_id,turn_id)).fetchone()
    if not card:return None
    previous=read(conversation_id,turn_id)
    if previous:return previous
    snapshot=collect(card['cutoff'])
    snapshot['sha256']=hashlib.sha256(json_dump(snapshot).encode()).hexdigest()
    with connect() as c:
        c.execute('INSERT OR IGNORE INTO client_service_market_snapshots VALUES(?,?,?,?,?)',(turn_id,conversation_id,snapshot['cutoff'],json_dump(snapshot),utc_now()))
    return read(conversation_id,turn_id)
