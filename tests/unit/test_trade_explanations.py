import json
from datetime import date
from unittest.mock import Mock
import pytest
from fastapi import HTTPException
from apps.api.app import db, trade_explanations as service, daily_signals_api, research_models, codex_store

@pytest.fixture
def configured(tmp_path, monkeypatch):
    monkeypatch.setattr(db,'DB_PATH',tmp_path/'test.db')
    monkeypatch.setattr(research_models,'llm_settings',lambda:{'configured':True,'model':'gpt-6-luna','reasoning_effort':'high'})
    monkeypatch.setattr(research_models,'_discover',lambda _:({'gpt-6-luna'},'verified'))
    monkeypatch.setattr(service.codex_runtime,'availability',lambda:{'available':True,'web_search':{'enabled':True}})
    monkeypatch.setattr(service,'names',lambda:{'300001.SZ':'测试公司'})
    monkeypatch.setattr(service.research_turn_service,'enqueue_turn',lambda cid,tid:None)
    history=Mock(return_value={'items':[{'trade_date':'2026-11-11','open':10,'high':11,'low':9,'close':10,'volume':100},
        {'trade_date':'2026-11-12','open':10,'high':12,'low':9,'close':11,'volume':120}], 'volume_unit':'手','source':'test'})
    monkeypatch.setattr(daily_signals_api,'chart_history',history)
    db.init_db()
    return history


def request(**values):
    return service.ExplainRequest(request_id='request-1',code='300001.SZ',date='2026-11-12',side='buy',**values)


def test_explanation_is_idempotent_and_contains_public_research_instead_of_strategy_rules(configured):
    one=service.start_explanation(request());two=service.start_explanation(request())
    assert one['turn_id']==two['turn_id']
    assert configured.call_count==1
    with db.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM conversations').fetchone()[0]==1
        prompt=conn.execute("SELECT content FROM conversation_messages WHERE role='user'").fetchone()[0]
    assert '原生网页搜索' in prompt and '买入操作' in prompt
    assert '不要访问策略回测平台' in prompt and '2026-11-12' in prompt
    assert '"close": 11' in prompt
    changed=service.ExplainRequest(**{**request().model_dump(mode='json'),'side':'sell'})
    with pytest.raises(HTTPException) as exc:service.start_explanation(changed)
    assert exc.value.status_code==409


def finish(result, body, events):
    with db.connect() as conn:
        conn.execute("UPDATE conversation_turns SET state='succeeded',response_text=? WHERE id=?",(json.dumps(body),result['turn_id']))
    for index,item in enumerate(events):
        codex_store.append_event(result['conversation_id'],result['turn_id'],'thread','turn',index,'item/completed',{'item':item})


def test_only_actual_search_and_opened_public_sources_are_accepted(configured):
    result=service.start_explanation(request())
    source={'title':'公开公告','url':'https://www.szse.cn/disclosure/example','published_at':'2026-11-11'}
    body={'client_copy':'操作考虑，存在价格波动风险。','analysis':'技术面核对','sources':[source],'limitations':[]}
    finish(result,body,[])
    assert service.explanation_status('request-1')['state']=='failed'
    events=[{'type':'webSearch','action':{'type':'search'},'results':[{'ref_id':'turn0search0','url':source['url']}]},
        {'type':'webSearch','action':{'type':'other'},'results':[{'ref_id':'turn1view0','url':source['url']}]}]
    finish(result,body,events)
    value=service.explanation_status('request-1')
    assert value['state']=='succeeded' and value['sources']==[source]
    body['sources'][0]['published_at']='2026-11-13'
    with db.connect() as conn:conn.execute('UPDATE conversation_turns SET response_text=? WHERE id=?',(json.dumps(body),result['turn_id']))
    assert service.explanation_status('request-1')['state']=='failed'


def test_history_fetches_180_real_bars_and_excludes_future_or_other_securities(monkeypatch):
    from datetime import timedelta
    daily_signals_api._history_cache.clear()
    monkeypatch.setattr(daily_signals_api,'tushare_settings',lambda:{'token':'test'})
    monkeypatch.setattr(daily_signals_api,'configured_limiter',lambda:None)
    items=[['300001.SZ',(date(2026,11,12)-timedelta(days=i)).strftime('%Y%m%d'),10,12,9,11,100] for i in range(200)]
    items.append(['300001.SZ','20261113',10,12,9,11,999]);items.append(['600000.SH','20261112',10,12,9,11,888])
    class Client:
        def __init__(self,*a,**kw):pass
        def raw_query(self,*a,**kw):return {'data':{'fields':['ts_code','trade_date','open','high','low','close','vol'],'items':items}}
    monkeypatch.setattr(daily_signals_api,'TushareClient',Client)
    data=daily_signals_api.chart_history('300001.SZ',date(2026,11,12))
    assert len(data['items'])==180 and data['items'][-1]['trade_date']=='2026-11-12'
    assert data['volume_unit']=='手' and all(row['volume']==100 for row in data['items'])
    daily_signals_api._history_cache.clear()
