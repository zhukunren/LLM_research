"""Fixed AKShare adapter. No user-supplied function names, URLs or executable code."""
from datetime import datetime, timedelta
import contextlib
import json
import sys


def fetch(request):
    import akshare as ak
    import requests
    original=requests.sessions.Session.request
    def bounded(self,method,url,**kwargs):
        kwargs['timeout']=8
        return original(self,method,url,**kwargs)
    requests.sessions.Session.request=bounded
    cutoff=datetime.fromisoformat(request['cutoff']);output=[]
    for code in ('000001.SH','399001.SZ','399006.SZ'):
        end=cutoff.date()-timedelta(days=int(bool(request.get('preopen'))))
        symbol=('sh' if code.endswith('SH') else 'sz')+code[:6]
        params={'symbol':symbol,'start_date':(end-timedelta(days=30)).strftime('%Y%m%d'),'end_date':end.strftime('%Y%m%d')}
        provider='东方财富';url=f'https://quote.eastmoney.com/zs{code[:6]}.html'
        try:frame=ak.stock_zh_index_daily_em(**params)
        except Exception:
            provider='腾讯财经';url=f'https://gu.qq.com/{symbol}/zs'
            try:frame=ak.stock_zh_index_daily_tx(**params)
            except Exception:
                provider='新浪财经';url=f'https://finance.sina.com.cn/realstock/company/{symbol}/nc.shtml'
                frame=ak.stock_zh_index_daily(symbol=symbol)
        daily=sorted(frame.to_dict('records'),key=lambda row:str(row['date']))
        earlier=[row for row in daily if str(row['date'])[:10]<cutoff.date().isoformat()]
        selected=[row for row in daily if str(row['date'])[:10]<=end.isoformat()]
        if request.get('preopen') or (cutoff.hour>=15 and selected and str(selected[-1]['date'])[:10]==cutoff.date().isoformat()):
            if selected:
                row=selected[-1];observed=datetime.fromisoformat(str(row['date'])[:10]+'T15:00:00').replace(tzinfo=cutoff.tzinfo)
                raw={key:str(value) for key,value in row.items()}
                raw['pre_close']=str(selected[-2]['close']) if len(selected)>1 else None
                output.append({'code':code,'observed_at':observed.isoformat(),'provider':provider,'source_url':url,'raw':raw})
        else:
            frame=ak.index_zh_a_hist_min_em(symbol=code[:6],period='1',start_date=cutoff.strftime('%Y-%m-%d 09:00:00'),end_date=cutoff.strftime('%Y-%m-%d %H:%M:%S'))
            rows=sorted(frame.to_dict('records'),key=lambda row:str(row['时间']))
            eligible=[row for row in rows if str(row['时间'])<=cutoff.strftime('%Y-%m-%d %H:%M:%S')]
            if eligible:
                row=eligible[-1];observed=datetime.fromisoformat(str(row['时间'])).replace(tzinfo=cutoff.tzinfo)
                output.append({'code':code,'observed_at':observed.isoformat(),'raw':{'close':str(row['收盘']),'pre_close':str(earlier[-1]['close']) if earlier else None,**{str(key):str(value) for key,value in row.items()}}})
    return output


if __name__=='__main__':
    with contextlib.redirect_stdout(sys.stderr):result=fetch(json.loads(sys.argv[1]))
    print(json.dumps(result,ensure_ascii=False))
