"""Compact, source-preserving display contracts for client-facing market metrics."""
from copy import deepcopy
from decimal import Decimal, InvalidOperation
from datetime import datetime
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo
import re

INDEXES = [('上证指数', r'上证(?:指数|综指|指)?|沪指'), ('深证成指', r'深证成指|深成指|深证指数'), ('创业板指', r'创业板(?:指数|指)?')]
FORMAT_VERSION = 3


def _number(value):
    try: return f'{Decimal(value.replace(",", "")):.2f}'
    except InvalidOperation: return None


def compact_metrics(market):
    """Keep full verified inputs in raw_metrics; each major index gets its own numeric cell."""
    result = deepcopy(market)
    if result.get('format_version',0) >= FORMAT_VERSION: return result
    raw = result.get('raw_metrics') or result.get('metrics', [])
    indexes, others = {}, []
    for item in raw:
        label, value = str(item.get('label','')), str(item.get('value',''))
        named = []
        for name, aliases in INDEXES:
            if re.search(aliases, label + ' ' + value):
                named.append(name)
                # Stop at the next index name so its percentage cannot be assigned
                # to this index when this index has no quoted change.
                next_index = '|'.join(alias for _, alias in INDEXES)
                segment = value
                own_name = re.search(aliases, value)
                if own_name:
                    remainder = value[own_name.end():]
                    following = re.search(next_index, remainder)
                    segment = value[own_name.start():own_name.end() + (following.start() if following else len(remainder))]
                pattern = rf'(?:{aliases})\s*(?:报|收报|为|：|:)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*点?([^；;]{{0,35}})'
                match = re.search(pattern, segment)
                if not match and re.search(aliases, label) and sum(bool(re.search(alias,label)) for _,alias in INDEXES)==1 and not re.search(next_index,value):
                    match = re.search(r'^\s*(?:收报|报|为|：|:)?\s*([0-9][0-9,]{2,7}(?:\.[0-9]+)?)(?![\d.%％])\s*点?([^；;]{0,35})', value)
                display = '未核实'
                if match and item.get('source_url') and item.get('observed_at'):
                    price = _number(match[1])
                    change_text=match[2].translate(str.maketrans({'−':'-','－':'-','＋':'+'}))
                    pct = re.search(r'([+-]?\d+(?:\.\d+)?)\s*[%％]',change_text)
                    if price:
                        display = price + '点'
                        if pct:
                            change = _number(pct[1])
                            if change:
                                before=change_text[:pct.start()]
                                falling=bool(re.search(r'(?:下跌|跌幅|跌|下降|回落|↓)\s*$',before))
                                rising=bool(re.search(r'(?:上涨|涨幅|涨|上升|↑)\s*$',before))
                                if not change.startswith('-') and falling: change = '-' + change.lstrip('+')
                                elif not change.startswith('-') and (pct[1].startswith('+') or rising): change = '+' + change
                                elif Decimal(change)==0 and not change.startswith(('+','-')):change='+'+change
                                # Unsigned magnitudes without a direction cannot
                                # be converted into a signed market return.
                                if pct[1].startswith(('+','-')) or falling or rising or Decimal(change)==0:
                                    display += ' ' + change + '%'
                if display=='未核实' and item.get('source_url') and item.get('observed_at') and (own_name or (sum(bool(re.search(alias,label)) for _,alias in INDEXES)==1 and not re.search(next_index,value))):
                    # A sourced return remains useful when an article quotes no
                    # point value; never discard it merely for lacking a price.
                    signed=re.search(r'([+\-−－＋]?\d+(?:\.\d+)?)\s*[%％]',segment)
                    if signed:
                        change=signed[1].translate(str.maketrans({'−':'-','－':'-','＋':'+'}))
                        if re.search('跌|下降|回落',segment[:signed.start()]):change='-'+change.lstrip('+-')
                        elif re.search('涨|上升',segment[:signed.start()]):change='+'+change.lstrip('+-')
                        if change.startswith(('+','-')) or Decimal(change)==0:display=f'{Decimal(change):+.2f}%'
                indexes[name] = {**item,'label':name,'value':display}
        if not named and re.search('三大指数|主要指数', label):
            for name,_ in INDEXES: indexes.setdefault(name, {'label':name,'value':'未核实','source_url':None,'observed_at':None})
            continue
        if not named:
            compact = value.strip()
            if '涨跌' in label:
                up=re.search(r'(\d+)\s*家?上涨|上涨\s*(\d+)\s*家',compact)
                down=re.search(r'(\d+)\s*家?下跌|下跌\s*(\d+)\s*家',compact)
                if up and down:
                    compact='涨'+next(group for group in up.groups() if group)+' / 跌'+next(group for group in down.groups() if group)
            elif re.search('家数|涨停|跌停',label):
                count=re.search(r'(超过|超|约)?\s*(\d+)\s*(只|家)',compact)
                if count:
                    if '沪深京' in compact and '沪深京' not in label:label='沪深京'+label
                    elif '沪深' in compact and '沪深' not in label:label='沪深'+label
                    compact=('超' if count[1]=='超过' else count[1] or '')+count[2]+count[3]
            if len(compact) > 24:
                if re.search('成交|金额',label):
                    m = re.search(r'([0-9]+(?:\.[0-9]+)?)\s*(万亿|亿|万)?元',compact)
                    compact = (('超' if re.search('超过|超',compact[:m.start()+1]) else '约' if '约' in compact[:m.start()+1] else '') + m[1] + (m[2] or '') + '元'+('（半日）' if re.search('半日|午间',compact) else '（全天）' if '全天' in compact else '')) if m else '未核实'
                elif re.search('占比|比例|比率',label):
                    m = re.search(r'([0-9]+(?:\.[0-9]+)?)\s*%',compact)
                    compact = m[1]+'%' if m else '未核实'
                elif re.search('涨停|跌停|家数',label):
                    m = re.search(r'(\d+)\s*家',compact)
                    compact = m[1]+'家' if m else '未核实'
                else: compact = '未核实'
            others.append({**item,'label':label[:12],'value':compact})
    if indexes:
        metrics = [indexes[name] for name,_ in INDEXES if name in indexes]
        metrics += others[:6-len(metrics)]
    else: metrics = others[:6]
    if any(item['value'] == '未核实' for item in metrics):
        result['quality'] = 'partial'
    result['format_version'] = FORMAT_VERSION
    result['raw_metrics'] = deepcopy(raw)
    result['metrics'] = metrics
    return result


def layout_checks(market):
    from .client_service_images import _font, _metric_lines
    issues=[]
    for index,item in enumerate(market.get('metrics',[])):
        if len(item.get('label',''))>12: issues.append({'area':f'metric.{index}.label','message':'指标名称过长','severity':'warning'})
        value=item.get('value','')
        if len(value)>26 or len(_metric_lines(value,_font(29,True),270))>2: issues.append({'area':f'metric.{index}.value','message':'指标应只展示简短数值，说明请移至正文','severity':'warning'})
        percent=re.search(r'([+\-−－＋]?\d+(?:\.\d+)?)\s*[%％]',value)
        if any(re.search(alias,item.get('label','')) for _,alias in INDEXES) and percent and percent[1][0].isdigit() and Decimal(percent[1])!=0 and not re.search('涨|跌|↑|↓',value):
            issues.append({'area':f'metric.{index}.value','message':'指数涨跌幅需要明确正负方向','severity':'warning'})
    return {'state':'warning' if issues else 'passed','issues':issues}


def publication_notes(market):
    """Customer-facing time and scope notes, separate from collection diagnostics."""
    times=[]
    for item in market.get('metrics',[]):
        try:times.append(datetime.fromisoformat(item['observed_at']).astimezone(ZoneInfo('Asia/Shanghai')))
        except (KeyError,TypeError,ValueError):pass
    notes=[]
    if times:
        first,last=min(times),max(times)
        span=first.strftime('%m-%d %H:%M')
        if first.strftime('%m-%d %H:%M')!=last.strftime('%m-%d %H:%M'):span+='—'+last.strftime('%H:%M')
        notes.append('数据时点 '+span+'（北京时间）')
    scope=market.get('data_note','').strip()
    if scope and re.search('含ST|不含|沪深京|沪深A股|沪深两市|半日|全天|口径',scope) and not re.search('未核实|补核|无权限|接口失败|尚未|缺少|无法|不能代表|分项合计',scope):notes.append(scope[:80])
    elif any(re.search('半日|午间',item.get('label','')+item.get('value','')) for item in market.get('metrics',[])):notes.append('成交额采用半日口径')
    return notes


def publisher(source):
    host=(urlsplit(source.get('url','')).hostname or '').lower()
    names={'qq.com':'腾讯财经','eastmoney.com':'东方财富','sina.com.cn':'新浪财经','sina.cn':'新浪财经','cls.cn':'财联社','10jqka.com.cn':'同花顺','stcn.com':'证券时报','cnfin.com':'新华财经','nbd.com.cn':'每日经济新闻','yicai.com':'第一财经','tushare.pro':'Tushare','sse.com.cn':'上交所','szse.cn':'深交所'}
    return next((name for domain,name in names.items() if host==domain or host.endswith('.'+domain)),source.get('title',host)[:18])
