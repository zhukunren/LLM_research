import { useEffect, useId, useState, type FormEvent } from 'react'
import { api } from '../api'
import { ArrowDownRight, ArrowUpRight, Bell, BriefcaseBusiness, Check, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import StockSearch from '../components/StockSearch'
import './investment-tracking.css'

export type InvestmentTab = 'all' | 'candidates' | 'batches' | 'updates' | 'expectations' | 'portfolio'

const tabs: { id: InvestmentTab; label: string }[] = [
  { id: 'all', label: '全部观察' },
  { id: 'updates', label: '变化提醒' },
  { id: 'expectations', label: '业绩预期' },
  { id: 'portfolio', label: '投资组合' },
]

export function InvestmentTrackingTabs({ active, onChange }: { active: InvestmentTab; onChange: (value: InvestmentTab) => void }) {
  return <div className="investment-tabs workspace-view-toolbar" role="tablist" aria-label="投资跟踪">
    {tabs.map(item => <button type="button" role="tab" aria-selected={active === item.id} key={item.id} className="workspace-button" onClick={() => onChange(item.id)}>{item.label}</button>)}
  </div>
}

export default function InvestmentTracking({ tab }: { tab: Extract<InvestmentTab, 'updates' | 'expectations' | 'portfolio'> }) {
  return <section className="investment-tracking-panel">
    {tab === 'updates' ? <WatchlistUpdates /> : tab === 'expectations' ? <EarningsExpectations /> : <Portfolio />}
  </section>
}

function ConfirmDelete({ label, warning, onConfirm }: { label: string; warning: string; onConfirm: () => Promise<boolean> }) {
  const confirmationId = useId()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  async function confirm() {
    if (busy) return
    setBusy(true)
    try { if (await onConfirm()) setOpen(false) }
    finally { setBusy(false) }
  }
  return <div className="investment-delete-control">
    <button type="button" className="icon-button workspace-button" aria-label={label} title={label} aria-expanded={open} aria-controls={open ? confirmationId : undefined} onClick={() => setOpen(value => !value)}><Trash2 size={15} /></button>
    {open && <div id={confirmationId} className="investment-delete-confirmation" role="group" aria-label="确认删除" aria-live="polite">
      <span>{warning}</span>
      <div className="investment-delete-confirmation-actions">
        <button type="button" className="text-button workspace-button investment-delete-action" disabled={busy} onClick={() => void confirm()}>{busy ? '删除中…' : '确认删除'}</button>
        <button type="button" className="text-button workspace-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
      </div>
    </div>}
  </div>
}

type MonitorPreference = { price_move_threshold: number; updated_at: string | null }
type MonitorEvent = { id: string; stock_code: string; event_kind: 'price_move' | 'financial_update' | 'new_disclosure'; event_date: string; title: string; summary: string; source_url: string | null; status: string }

function WatchlistUpdates() {
  const [events, setEvents] = useState<MonitorEvent[]>([])
  const [threshold, setThreshold] = useState('5')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [lastChecked, setLastChecked] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void Promise.all([
      api<MonitorPreference>('/investment-tracking/monitor/preferences', { signal: controller.signal }),
      api<{ items: MonitorEvent[]; last_checked_at: string | null }>('/investment-tracking/monitor/events?status=open&limit=100', { signal: controller.signal }),
    ]).then(([preference, result]) => {
      if (controller.signal.aborted) return
      setThreshold(String(preference.price_move_threshold)); setEvents(result.items); setLastChecked(result.last_checked_at)
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  async function saveThreshold() {
    setError(''); setNotice('')
    try {
      const result = await api<MonitorPreference>('/investment-tracking/monitor/preferences', { method: 'PUT', body: JSON.stringify({ price_move_threshold: Number(threshold) }) })
      setThreshold(String(result.price_move_threshold)); setNotice('提醒阈值已保存。')
    } catch (reason) { setError((reason as Error).message) }
  }
  async function checkUpdates() {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api<{ checked: number; created: number; checked_at: string }>('/investment-tracking/monitor/check', { method: 'POST', body: '{}' })
      setNotice(`检查了 ${result.checked} 家关注公司，新增 ${result.created} 条提醒。`)
      setRefresh(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  async function changeEvent(id: string, status: 'reviewed' | 'dismissed') {
    try {
      await api('/investment-tracking/monitor/events/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status }) })
      setEvents(current => current.filter(item => item.id !== id))
    } catch (reason) { setError((reason as Error).message) }
  }
  return <>
    <header className="investment-panel-heading"><div><h2>关注变化</h2><p>检查观察池中的重点公司，汇总显著行情变化、新财务版本和已确认披露。</p></div><button type="button" className="primary-button workspace-button" disabled={busy || loading} onClick={() => void checkUpdates()}>{busy ? <RefreshCw size={15} className="spin" /> : <RefreshCw size={15} />}{busy ? '检查中…' : '检查变化'}</button></header>
    <div className="investment-monitor-settings workspace-form"><label className="workspace-field-label">单日收盘变动提醒阈值（%）<input className="workspace-field" type="number" min="0.5" max="50" step="0.5" value={threshold} onChange={event => setThreshold(event.target.value)} /></label><button className="secondary-button workspace-button" type="button" disabled={!Number(threshold) || Number(threshold) > 50 || Number(threshold) < 0.5} onClick={() => void saveThreshold()}>保存阈值</button>{lastChecked && <span className="investment-secondary">上次检查 {dateTime(lastChecked)}</span>}</div>
    {error && <p className="workspace-error" role="alert">{error}</p>}{notice && <p className="workspace-feedback workspace-feedback-success" role="status">{notice}</p>}
    {loading ? <p role="status">正在读取提醒…</p> : !events.length ? <div className="investment-empty"><Bell size={19} /><strong>暂无待处理提醒</strong><span>运行检查后，新变化会显示在这里。</span></div> : <div className="investment-event-list" aria-label="待处理提醒">
      {events.map(event => <article className="investment-event-row" key={event.id}><div className={'investment-event-icon investment-event-' + event.event_kind}>{event.event_kind === 'price_move' ? event.title.includes('下跌') ? <ArrowDownRight size={17} /> : <ArrowUpRight size={17} /> : event.event_kind === 'financial_update' ? <BriefcaseBusiness size={17} /> : <Bell size={17} />}</div><div className="investment-event-main"><div><strong>{event.title}</strong><small>{event.stock_code} · {event.event_date}</small></div><p>{event.summary}</p>{event.source_url && <a href={event.source_url} target="_blank" rel="noreferrer">{event.event_kind === 'new_disclosure' ? '打开原始披露' : '查看行情数据'}</a>}</div><div className="investment-event-actions"><button type="button" className="icon-button workspace-button" aria-label="标记已复核" title="标记已复核" onClick={() => void changeEvent(event.id, 'reviewed')}><Check size={16} /></button><button type="button" className="icon-button workspace-button" aria-label="忽略提醒" title="忽略提醒" onClick={() => void changeEvent(event.id, 'dismissed')}><X size={16} /></button></div></article>)}
    </div>}
    <p className="investment-footnote">财务和披露只报告上次检查后新进入本地资料库的版本；首次检查建立基线。价格按本地日线收盘数据计算。</p>
  </>
}

type Metric = { code: string; label: string; unit: string }
type Expectation = { id: string; stock_code: string; report_period: string; basis: string; metric_code: string; metric_label: string; unit: string; expected_value: string; actual_value: string | null; actual_status: string; actual_reason: string; surprise: string | null; surprise_percent: string | null; note: string }

function EarningsExpectations() {
  const [items, setItems] = useState<Expectation[]>([])
  const [metrics, setMetrics] = useState<Metric[]>([])
  const [stockCode, setStockCode] = useState('')
  const [period, setPeriod] = useState(`${new Date().getFullYear()}-12-31`)
  const [basis, setBasis] = useState('annual')
  const [metric, setMetric] = useState('revenue')
  const [expected, setExpected] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void Promise.all([
      api<{ items: Expectation[]; metrics: Metric[] }>('/investment-tracking/expectations', { signal: controller.signal }),
      api<{ items: Metric[] }>('/financial-data/metrics', { signal: controller.signal }),
    ]).then(([result, catalog]) => {
      if (controller.signal.aborted) return
      setItems(result.items); setMetrics(catalog.items); setMetric(current => catalog.items.some(item => item.code === current) ? current : catalog.items[0]?.code || '')
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaving(true); setError(''); setNotice('')
    try {
      await api('/investment-tracking/expectations', { method: 'POST', body: JSON.stringify({ stock_code: stockCode.trim().toUpperCase(), report_period: period, basis, metric_code: metric, expected_value: expected, note }) })
      setExpected(''); setNote(''); setNotice('业绩预期已保存。'); setRefresh(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setSaving(false) }
  }
  async function remove(id: string) {
    setError(''); setNotice('')
    try { await api('/investment-tracking/expectations/' + encodeURIComponent(id), { method: 'DELETE' }); setItems(current => current.filter(item => item.id !== id)); setNotice('业绩预期已删除。'); return true }
    catch (reason) { setError((reason as Error).message); return false }
  }
  const quarter = basis !== 'annual'
  const validPeriod = ['-03-31', '-06-30', '-09-30', '-12-31'].some(suffix => period.endsWith(suffix))
  return <>
    <header className="investment-panel-heading"><div><h2>业绩预期</h2><p>记录自己的指标预期；财务数据到达后显示实际值和差额。</p></div></header>
    <form className="investment-entry-form workspace-form" onSubmit={event => void save(event)}>
      <div className="workspace-field-label investment-entry-stock"><span>股票</span><StockSearch label="业绩预期股票" value={stockCode} onSelectionPending={() => setStockCode('')} onChange={setStockCode} /></div>
      <label className="workspace-field-label">报告期<input className="workspace-field" type="date" value={period} onChange={event => setPeriod(event.target.value)} required /></label>
      <label className="workspace-field-label">比较口径<select className="workspace-field workspace-select" value={basis} onChange={event => setBasis(event.target.value)}><option value="annual">年度</option><option value="quarter">单季</option><option value="cumulative">年内累计</option><option value="ttm">滚动十二个月</option></select></label>
      <label className="workspace-field-label">指标<select className="workspace-field workspace-select" value={metric} onChange={event => setMetric(event.target.value)}>{metrics.map(item => <option key={item.code} value={item.code}>{item.label}（{item.unit}）</option>)}</select></label>
      <label className="workspace-field-label">预期值<input className="workspace-field" type="number" step="any" value={expected} onChange={event => setExpected(event.target.value)} required /></label>
      <label className="workspace-field-label investment-entry-note">备注<input className="workspace-field" maxLength={1000} value={note} onChange={event => setNote(event.target.value)} placeholder="可选" /></label>
      <button type="submit" className="primary-button workspace-button" disabled={saving || !stockCode || !metric || !validPeriod || (!quarter && !period.endsWith('-12-31'))}><Plus size={15} />{saving ? '保存中…' : '保存预期'}</button>
    </form>
    {error && <p className="workspace-error" role="alert">{error}</p>}{notice && <p className="workspace-feedback workspace-feedback-success" role="status">{notice}</p>}
    <div className="investment-subheading"><h3>已记录预期</h3><span>{items.length} 项</span><button type="button" className="icon-button workspace-button" aria-label="刷新业绩预期" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} /></button></div>
    {loading ? <p role="status">正在读取预期…</p> : !items.length ? <div className="investment-empty"><BriefcaseBusiness size={19} /><strong>还没有业绩预期</strong><span>添加关注公司的指标与报告期。</span></div> : <div className="investment-table-scroll workspace-table-scroll"><table className="workspace-data-table" aria-label="业绩预期"><thead><tr><th>公司 / 报告期</th><th>指标</th><th>预期值</th><th>实际值</th><th>差额</th><th>备注</th><th></th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td data-label="公司 / 报告期">{item.stock_code}<small>{item.report_period} · {basisLabel(item.basis)}</small></td><td data-label="指标">{item.metric_label}<small>{item.unit}</small></td><td data-label="预期值">{formatNumber(item.expected_value)}</td><td data-label="实际值">{item.actual_status === 'ok' ? formatNumber(item.actual_value) : item.actual_reason || '待披露'}</td><td data-label="差额" className={tone(item.surprise)}>{item.surprise == null ? '—' : `${formatNumber(item.surprise)}${item.surprise_percent == null ? '' : ` · ${formatNumber(item.surprise_percent)}%`}`}</td><td data-label="备注">{item.note || '—'}</td><td><ConfirmDelete label={`删除${item.stock_code} ${item.metric_label}预期`} warning="确认删除这项业绩预期？" onConfirm={() => remove(item.id)} /></td></tr>)}</tbody></table></div>}
    <p className="investment-footnote">预期值按指标目录的原单位输入；差额为实际值减预期值，不代表利好或利空判断。</p>
  </>
}

type Position = { stock_code: string; name: string; quantity: string; average_cost: string; cost_basis: string; latest_close: string | null; latest_date: string | null; market_value: string | null; unrealized_profit: string | null; realized_profit: string }
type Transaction = { id: string; trade_date: string; stock_code: string; side: 'buy' | 'sell'; quantity: string; price: string; fees: string; note: string }
type PortfolioResult = { positions: Position[]; transactions: Transaction[]; latest_market_date: string | null; cost_method: string; summary: { market_value: string | null; cost_basis: string; unrealized_profit: string | null; realized_profit: string; total_profit: string | null; positions: number } }

function Portfolio() {
  const [result, setResult] = useState<PortfolioResult | null>(null)
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [tradeDate, setTradeDate] = useState(localDate())
  const [stockCode, setStockCode] = useState('')
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [fees, setFees] = useState('0')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    api<PortfolioResult>('/investment-tracking/portfolio', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setResult(value) })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaving(true); setError(''); setNotice('')
    try {
      await api('/investment-tracking/portfolio/transactions', { method: 'POST', body: JSON.stringify({ trade_date: tradeDate, stock_code: stockCode.trim().toUpperCase(), side, quantity, price, fees, note }) })
      setQuantity(''); setPrice(''); setFees('0'); setNote(''); setNotice('流水已记录，组合正在重新计算。'); setRefresh(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setSaving(false) }
  }
  async function remove(id: string) {
    setError(''); setNotice('')
    try { await api('/investment-tracking/portfolio/transactions/' + encodeURIComponent(id), { method: 'DELETE' }); setNotice('流水已删除，组合正在重新计算。'); setRefresh(value => value + 1); return true }
    catch (reason) { setError((reason as Error).message); return false }
  }
  const summary = result?.summary
  return <>
    <header className="investment-panel-heading"><div><h2>投资组合</h2><p>手动记录买卖流水，查看本地行情估值和收益。</p></div></header>
    <section className="investment-overview workspace-metric-grid" aria-label="组合汇总">
      <Metric label="持仓市值" value={formatNumber(summary?.market_value)} />
      <Metric label="持仓成本" value={formatNumber(summary?.cost_basis)} />
      <Metric label="未实现盈亏" value={formatNumber(summary?.unrealized_profit)} tone={tone(summary?.unrealized_profit)} />
      <Metric label="已实现盈亏" value={formatNumber(summary?.realized_profit)} tone={tone(summary?.realized_profit)} />
      <Metric label="合计盈亏" value={formatNumber(summary?.total_profit)} tone={tone(summary?.total_profit)} />
    </section>
    <p className="investment-footnote">行情截至 {result?.latest_market_date || '暂无本地日线'} · {result?.cost_method || '盈亏按移动加权平均计算。'}</p>
    <form className="investment-entry-form workspace-form" onSubmit={event => void save(event)}>
      <label className="workspace-field-label">方向<select className="workspace-field workspace-select" value={side} onChange={event => setSide(event.target.value as 'buy' | 'sell')}><option value="buy">买入</option><option value="sell">卖出</option></select></label>
      <label className="workspace-field-label">交易日期<input className="workspace-field" type="date" max={localDate()} value={tradeDate} onChange={event => setTradeDate(event.target.value)} required /></label>
      <div className="workspace-field-label investment-entry-stock"><span>股票</span><StockSearch label="投资组合股票" value={stockCode} onSelectionPending={() => setStockCode('')} onChange={setStockCode} /></div>
      <label className="workspace-field-label">数量<input className="workspace-field" type="number" min="0.0001" step="any" value={quantity} onChange={event => setQuantity(event.target.value)} required /></label>
      <label className="workspace-field-label">成交价<input className="workspace-field" type="number" min="0.0001" step="any" value={price} onChange={event => setPrice(event.target.value)} required /></label>
      <label className="workspace-field-label">费用<input className="workspace-field" type="number" min="0" step="any" value={fees} onChange={event => setFees(event.target.value)} required /></label>
      <label className="workspace-field-label investment-entry-note">备注<input className="workspace-field" maxLength={1000} value={note} onChange={event => setNote(event.target.value)} placeholder="可选" /></label>
      <button type="submit" className="primary-button workspace-button" disabled={saving || !stockCode}>{saving ? <RefreshCw size={15} className="spin" /> : <Plus size={15} />}{saving ? '保存中…' : '记入流水'}</button>
    </form>
    {error && <p className="workspace-error" role="alert">{error}</p>}{notice && <p className="workspace-feedback workspace-feedback-success" role="status">{notice}</p>}
    <div className="investment-subheading"><h3>当前持仓</h3><span>{summary?.positions ?? 0} 只</span><button type="button" className="icon-button workspace-button" aria-label="刷新组合估值" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} /></button></div>
    {loading ? <p role="status">正在计算组合…</p> : !result?.positions.length ? <div className="investment-empty"><BriefcaseBusiness size={19} /><strong>还没有持仓</strong><span>记录买入流水后会显示当前持仓。</span></div> : <div className="investment-table-scroll workspace-table-scroll"><table className="workspace-data-table" aria-label="当前持仓"><thead><tr><th>股票</th><th>数量</th><th>移动平均成本</th><th>最新收盘</th><th>市值</th><th>未实现盈亏</th><th>已实现盈亏</th></tr></thead><tbody>{result.positions.map(item => <tr key={item.stock_code}><td data-label="股票">{item.name || item.stock_code}<small>{item.stock_code}</small></td><td data-label="数量">{formatNumber(item.quantity)}</td><td data-label="移动平均成本">{formatNumber(item.average_cost)}</td><td data-label="最新收盘">{item.latest_close == null ? '—' : `${formatNumber(item.latest_close)} · ${item.latest_date}`}</td><td data-label="市值">{formatNumber(item.market_value)}</td><td data-label="未实现盈亏" className={tone(item.unrealized_profit)}>{formatNumber(item.unrealized_profit)}</td><td data-label="已实现盈亏" className={tone(item.realized_profit)}>{formatNumber(item.realized_profit)}</td></tr>)}</tbody></table></div>}
    <div className="investment-subheading"><h3>最近流水</h3><span>{result?.transactions.length ?? 0} 笔</span></div>
    {!loading && !!result?.transactions.length && <div className="investment-table-scroll workspace-table-scroll"><table className="workspace-data-table" aria-label="组合流水"><thead><tr><th>日期</th><th>方向 / 股票</th><th>数量</th><th>成交价</th><th>费用</th><th>备注</th><th></th></tr></thead><tbody>{result.transactions.map(item => <tr key={item.id}><td data-label="日期">{item.trade_date}</td><td data-label="方向 / 股票">{item.side === 'buy' ? '买入' : '卖出'}<small>{item.stock_code}</small></td><td data-label="数量">{formatNumber(item.quantity)}</td><td data-label="成交价">{formatNumber(item.price)}</td><td data-label="费用">{formatNumber(item.fees)}</td><td data-label="备注">{item.note || '—'}</td><td><ConfirmDelete label={`删除${item.trade_date} ${item.stock_code}流水`} warning="删除后会重算后续持仓。" onConfirm={() => remove(item.id)} /></td></tr>)}</tbody></table></div>}
    <p className="investment-footnote">此组合由手动流水计算，不连接券商账户，也不会提交委托。同日按先买入后卖出计算；删除流水会重算之后的持仓，造成负持仓时会拒绝操作。</p>
  </>
}

function Metric({ label, value, tone: style = '' }: { label: string; value: string; tone?: string }) {
  return <div className="workspace-metric-card"><span>{label}</span><strong className={style}>{value}</strong></div>
}

function formatNumber(value: string | number | null | undefined) {
  if (value == null || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : String(value)
}
function tone(value: string | null | undefined) { const number = Number(value); return !value || !Number.isFinite(number) || number === 0 ? '' : number > 0 ? 'observation-up' : 'observation-down' }
function basisLabel(value: string) { return ({ annual: '年度', quarter: '单季', cumulative: '年内累计', ttm: '滚动十二个月' } as Record<string, string>)[value] || value }
function dateTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function localDate() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` }
