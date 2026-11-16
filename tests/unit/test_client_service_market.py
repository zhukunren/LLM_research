from datetime import datetime, timedelta
import json
from types import SimpleNamespace

from apps.api.app import client_service_market as market

WHEN=datetime.fromisoformat('2026-11-16T10:30:00+08:00')


def quotes(observed=WHEN):
    return [market.quote(code,price,'3000',observed,'fixture',f'https://example.com/{code}',{'close':price})
            for code,price in zip(market.INDEXES,('2990','2980','2970'))]


def test_permission_denied_and_empty_daily_data_fall_back_to_dated_financial_quotes(monkeypatch):
    def denied(*args,**kwargs):raise ValueError('provider access denied')
    monkeypatch.setattr(market,'tushare_quotes',denied)
    monkeypatch.setattr(market,'tencent_quotes',quotes)
    monkeypatch.setattr(market,'akshare_quotes',lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('Unnecessary request')))
    value=market.collect(WHEN)
    assert not value['missing'] and len(value['metrics'])==3
    assert all('%' in item['value'] and item['raw'] for item in value['metrics'])
    assert [item['state'] for item in value['attempts']]==['unavailable','complete']


def test_future_quotes_are_replaced_by_minutes_before_fixed_cutoff(monkeypatch):
    monkeypatch.setattr(market,'tushare_quotes',lambda *args,**kwargs:[])
    monkeypatch.setattr(market,'tencent_quotes',lambda:quotes(WHEN+timedelta(minutes=20)))
    historic={item['code']:item for item in quotes(WHEN-timedelta(minutes=1))}
    monkeypatch.setattr(market,'tencent_minutes',lambda code,*args:[historic[code]])
    value=market.collect(WHEN)
    assert not value['missing']
    assert all(datetime.fromisoformat(item['observed_at'])<=WHEN for item in value['metrics'])


def test_akshare_fills_missing_indices_without_replacing_existing_valid_data(monkeypatch):
    first=quotes()[:1]
    monkeypatch.setattr(market,'tushare_quotes',lambda *args,**kwargs:first)
    monkeypatch.setattr(market,'tencent_quotes',lambda:[])
    monkeypatch.setattr(market,'akshare_quotes',lambda *args,**kwargs:quotes())
    value=market.collect(WHEN)
    assert not value['missing'] and value['metrics'][0]==first[0]
    assert value['attempts'][-1]['provider']=='AkShare'


def test_missing_data_remain_missing_and_no_other_trade_date_is_substituted(monkeypatch):
    monkeypatch.setattr(market,'tushare_quotes',lambda *args,**kwargs:[])
    monkeypatch.setattr(market,'tencent_quotes',lambda:quotes(WHEN-timedelta(days=3)))
    monkeypatch.setattr(market,'akshare_quotes',lambda *args,**kwargs:[])
    value=market.collect(WHEN)
    assert len(value['missing'])==3 and not value['metrics']


def test_tencent_parser_checks_code_timestamp_and_percentage_consistency(monkeypatch):
    row=['0']*42;row[2]='000001';row[3]='3600';row[4]='3636.36';row[30]='20261116103000';row[32]='-1.00';row[37]='10000'
    monkeypatch.setattr(market.requests,'get',lambda *args,**kwargs:SimpleNamespace(text='v_sh000001="'+'~'.join(row)+'";',raise_for_status=lambda:None))
    result=market.tencent_quotes()
    assert len(result)==1 and result[0]['value']=='3600.00点 -1.00%'
    row[32]='3.00'
    assert market.tencent_quotes()==[]


def test_akshare_adapter_is_bounded_and_preserves_provider_dates(monkeypatch):
    rows=[{'code':code,'observed_at':WHEN.isoformat(),'provider':'腾讯财经','source_url':'https://gu.qq.com/sh000001/zs','raw':{'close':'2990','pre_close':'3000'}} for code in market.INDEXES]
    calls=[]
    def run(args,**kwargs):calls.append((args,kwargs));return SimpleNamespace(returncode=0,stdout=json.dumps(rows))
    monkeypatch.setattr(market.subprocess,'run',run)
    result=market.akshare_quotes(WHEN,{})
    assert len(result)==3 and all(item['provider']=='AkShare · 腾讯财经' for item in result)
    assert calls[0][1]['timeout']==30 and '--' not in calls[0][0][2]
