import { useEffect, useState } from 'react'
import { AlertCircle, ArrowDownRight, ArrowUpRight, Radio, RefreshCw } from 'lucide-react'
import LoadingState from '../components/LoadingState'
import { api } from '../api'
import { StockMention } from '../components/StockMentions'
import { dailySignalsEndpoint, parseDailySignals, signalPercent, sortDailyStrategies, type SignalSort, type SignalSortKey, type DailySignals, type DailyStrategy, type SignalStock } from '../dailySignals'
import './daily-signals.css'

type DayQuote = { code: string; date: string; volume: number | null; volume_unit: string; close: number | null; pct_chg: number | null }
function volumeLabel(value: number | null | undefined) { return value == null ? '—' : value >= 10000 ? `${(value / 10000).toFixed(2)}万手` : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}手` }

function SignalList({ title, items, covered, side, asOf, quotes, strategy }: { title: string; items: SignalStock[]; covered: boolean; side: 'buy' | 'sell'; asOf: string; quotes: Record<string, DayQuote>; strategy: DailyStrategy }) {
  return <section className={`daily-signal-direction daily-signal-${side}`} aria-label={title}>
    <h3>{side === 'buy' ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}{title}<span>{covered ? items.length : '—'}</span></h3>
    {!covered ? <p>无法判断</p> : !items.length ? <p>无{title}信号</p> : <ul>{items.map(stock => <li key={stock.code}>
      <StockMention code={stock.code} asOf={asOf || undefined} signalContext={{ side, strategyTitle: strategy.strategy_title, markers: [
        ...(strategy.buy_signals.some(item => item.code === stock.code) ? [{ date: asOf, side: 'buy' as const, label: strategy.strategy_title }] : []),
        ...(strategy.sell_signals.some(item => item.code === stock.code) ? [{ date: asOf, side: 'sell' as const, label: strategy.strategy_title }] : []),
      ] }}>{stock.name && <span>{stock.name}</span>}<code>{stock.code}</code></StockMention><span className="daily-signal-volume" title={`当日成交量：${quotes[stock.code]?.volume == null ? '暂无数据' : quotes[stock.code].volume?.toLocaleString('zh-CN') + '手'}`}>量 {volumeLabel(quotes[stock.code]?.volume)}</span>
    </li>)}</ul>}
  </section>
}

function StrategyCard({ strategy, asOf, quotes, sort, onSort }: { strategy: DailyStrategy; asOf: string; quotes: Record<string, DayQuote>; sort: SignalSort; onSort: (key: SignalSortKey) => void }) {
  const s = strategy
  const active = s.buy_signals.length + s.sell_signals.length > 0
  const winRateTone = !s.covers_date || s.win_rate === null || s.win_rate === 0.5 ? '' : s.win_rate > 0.5 ? 'is-above-half' : 'is-below-half'
  return <article className="daily-signal-card" aria-label={s.strategy_title}>
    <header><div className="daily-strategy-title"><h2>{s.strategy_title}</h2><span className={s.covers_date ? 'daily-signal-status' : 'daily-signal-status unavailable'}>
      {!s.covers_date ? '数据未覆盖该日' : active ? '有信号' : '当日无信号'}
    </span></div><dl className="daily-signal-metrics">
        <div><dt><button type="button" className="metric-sort-button workspace-button" aria-label="按近期胜率排序" aria-pressed={sort?.key === 'win_rate'} onClick={() => onSort('win_rate')}>近期胜率{sort?.key === 'win_rate' ? sort.direction === 'desc' ? ' ↓' : ' ↑' : ' ↕'}</button></dt><dd className={`daily-signal-win-rate ${winRateTone}`}>{signalPercent(s.covers_date ? s.win_rate : null)}</dd></div>
        <div><dt><button type="button" className="metric-sort-button workspace-button" aria-label="按平均每笔收益排序" aria-pressed={sort?.key === 'avg_trade_return'} onClick={() => onSort('avg_trade_return')}>平均每笔收益{sort?.key === 'avg_trade_return' ? sort.direction === 'desc' ? ' ↓' : ' ↑' : ' ↕'}</button></dt><dd>{signalPercent(s.covers_date ? s.avg_trade_return : null)}</dd></div>
        <div><dt><button type="button" className="metric-sort-button workspace-button" aria-label="按策略年化收益排序" aria-pressed={sort?.key === 'ann_return'} onClick={() => onSort('ann_return')}>策略年化收益{sort?.key === 'ann_return' ? sort.direction === 'desc' ? ' ↓' : ' ↑' : ' ↕'}</button></dt><dd>{signalPercent(s.covers_date ? s.ann_return : null)}</dd></div>
      </dl></header>
    <div className="daily-signal-card-body">
      <SignalList title="买入" items={s.buy_signals} covered={s.covers_date} side="buy" asOf={asOf} quotes={quotes} strategy={strategy} />
      <SignalList title="卖出" items={s.sell_signals} covered={s.covers_date} side="sell" asOf={asOf} quotes={quotes} strategy={strategy} />
    </div>
    <section className="daily-signal-details" aria-label="样本与数据范围">
      <dl className="daily-signal-detail-grid">
        <div><dt>已平仓样本</dt><dd>{s.sample_count} 笔</dd></div>
        <div><dt>盈亏有效样本</dt><dd>{s.known_pnl_count} 笔</dd></div>
        <div><dt>盈利交易</dt><dd>{s.win_count === null ? '未提供' : `${s.win_count} 笔`}</dd></div>
        <div><dt>缓存截至</dt><dd>{s.data_end || '未知日期'}</dd></div>
        <div className="date-range"><dt>样本平仓区间</dt><dd>{s.sample_count && s.sample_start && s.sample_end ? `${s.sample_start} 至 ${s.sample_end}` : '暂无已平仓样本'}</dd></div>
        <div className="date-range"><dt>年化净值区间</dt><dd>{s.ann_return_start && s.ann_return_end ? <>{s.ann_return_start} 至 {s.ann_return_end}<span className="daily-signal-day-count">（{s.ann_return_day_count} 个交易日）</span></> : '暂无可计算区间'}</dd></div>
      </dl>
    </section>
  </article>
}

export default function DailySignalsPage() {
  const [date, setDate] = useState('')
  const [n, setN] = useState('20')
  const [query, setQuery] = useState({ date: '', n: 20, revision: 0 })
  const [data, setData] = useState<DailySignals | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [onlySignals, setOnlySignals] = useState(true)
  const [search, setSearch] = useState('')
  const [quotes, setQuotes] = useState<Record<string, DayQuote>>({})
  const [quoteError, setQuoteError] = useState('')
  const [sort, setSort] = useState<SignalSort>(null)
  function changeSort(key: SignalSortKey) { setSort(current => ({ key, direction: current?.key === key && current.direction === 'desc' ? 'asc' : 'desc' })) }
  useEffect(() => {
    const controller = new AbortController()
    setQuotes({}); setQuoteError('')
    const codes = [...new Set(data?.strategies.filter(s => s.covers_date).flatMap(s => [...s.buy_signals, ...s.sell_signals]).map(s => s.code) ?? [])]
    if (!data?.date || !codes.length) return () => controller.abort()
    const day = data.date
    void (async () => {
      const quotes: Record<string, DayQuote> = {}
      for (let i = 0; i < codes.length; i += 500) {
        const result = await api<{ items: DayQuote[] }>('/daily-signals/market', { method: 'POST', signal: controller.signal, body: JSON.stringify({ date: day, codes: codes.slice(i, i + 500) }) })
        if (!Array.isArray(result.items)) throw new Error('成交量数据格式异常。')
        for (const item of result.items) if (item.date === day) quotes[item.code] = item
      }
      if (!controller.signal.aborted) setQuotes(quotes)
    })().catch(error => { if (!controller.signal.aborted) setQuoteError(error instanceof Error ? error.message : '成交量暂不可用。') })
    return () => controller.abort()
  }, [data])
  useEffect(() => {
    const controller = new AbortController()
    let timedOut = false
    setLoading(true); setError(''); setData(null)
    const timer = window.setTimeout(() => { timedOut = true; controller.abort() }, 30000)
    const params = new URLSearchParams({ n: String(query.n) })
    if (query.date) params.set('date', query.date)
    void fetch(`${dailySignalsEndpoint}?${params}`, { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error(`信号服务暂不可用（${response.status}），请稍后重试。`)
        return parseDailySignals(await response.json())
      }).then(result => { if (!controller.signal.aborted) setData(result) })
      .catch(reason => {
        if (timedOut) setError('信号查询超时，请稍后重试。')
        else if (!controller.signal.aborted) setError(reason instanceof TypeError ? '无法连接信号服务，请检查网络后重试。' : reason instanceof SyntaxError ? '信号数据格式异常，请稍后重试。' : reason instanceof Error ? reason.message : '无法连接信号服务，请稍后重试。')
      }).finally(() => { window.clearTimeout(timer); if (!controller.signal.aborted || timedOut) setLoading(false) })
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query])

  function load(latest = false) {
    const sample = Number(n)
    if (!Number.isInteger(sample) || sample < 1 || sample > 10000) { setError('样本数需为 1 至 10000 的整数。'); return }
    if (latest) setDate('')
    setQuery(current => ({ date: latest ? '' : date, n: sample, revision: current.revision + 1 }))
  }
  const covered = data?.strategies.filter(s => s.covers_date) ?? []
  const active = covered.filter(s => s.buy_signals.length + s.sell_signals.length > 0)
  const uncovered = (data?.strategies.length ?? 0) - covered.length
  const needle = search.trim().toLowerCase()
  const filtered = data?.strategies.filter(s => (!onlySignals || !s.covers_date || s.buy_signals.length + s.sell_signals.length > 0) && (!needle || [s.strategy_title, ...s.buy_signals.flatMap(x => [x.name, x.code]), ...s.sell_signals.flatMap(x => [x.name, x.code])].some(text => text.toLowerCase().includes(needle)))) ?? []
  const visible = sortDailyStrategies(filtered, sort)

  return <div className="page-content workspace-tool-page daily-signals-page" role="region" aria-label="每日信号内容" tabIndex={0}>
    <header className="page-heading"><h1><Radio size={24} aria-hidden="true" />每日信号汇总</h1></header>
    <form className="daily-signal-controls" onSubmit={event => { event.preventDefault(); load() }}>
      <label>查询日期<input type="date" aria-label="查询日期" value={date} onChange={event => setDate(event.target.value)} className="workspace-field" /></label>
      <label>近 N 笔样本<input type="number" aria-label="近 N 笔样本" min={1} max={10000} step={1} required value={n} onChange={event => setN(event.target.value)} className="workspace-field" /></label>
      <button type="submit" className="primary-button workspace-button" disabled={loading}><RefreshCw size={15} aria-hidden="true" />查询 / 刷新</button>
      <button type="button" className="secondary-button workspace-button" disabled={loading} onClick={() => load(true)}>最新缓存</button>
      <p>日期留空查询最新缓存</p>
    </form>
    {error && <div role="alert" className="daily-signal-error workspace-error"><AlertCircle size={18} /><span>{error}</span><button type="button" className="text-button workspace-button" onClick={() => setQuery(current => ({ ...current, revision: current.revision + 1 }))}>重试</button></div>}
    {loading && <LoadingState label="正在读取每日信号…" />}
    {!loading && data && <>
      <div className="daily-signal-result-heading"><div><h2>{data.date || '暂无缓存日期'}</h2><p>近 {data.n} 笔已平仓样本{data.unavailable_count > 0 && ` · ${data.unavailable_count} 个策略未载入`}</p></div>
        <button type="button" className="text-button workspace-button" disabled={!sort} onClick={() => setSort(null)}>{sort ? `恢复默认顺序` : '点击卡片指标排序'}</button><label className="daily-signal-search"><span>筛选</span><input type="search" aria-label="筛选策略或股票" value={search} onChange={event => setSearch(event.target.value)} placeholder="策略名称 / 股票名称或代码" className="workspace-field" /></label><label><input type="checkbox" checked={onlySignals} onChange={event => setOnlySignals(event.target.checked)} />仅看有信号的策略</label>
      </div>
      <dl className="daily-signal-summary" aria-label="信号概况">
        <div><dt>有信号策略</dt><dd>{active.length}</dd></div>
        <div className="daily-summary-buy"><dt>买入信号</dt><dd>{covered.reduce((sum, s) => sum + s.buy_signals.length, 0)}</dd></div>
        <div className="daily-summary-sell"><dt>卖出信号</dt><dd>{covered.reduce((sum, s) => sum + s.sell_signals.length, 0)}</dd></div>
        <div><dt>覆盖该日的策略</dt><dd>{covered.length}<small> / {data.strategies.length + data.unavailable_count}</small></dd></div>
      </dl>
      {uncovered > 0 && <p className="daily-signal-coverage" role="status">{uncovered} 个策略未覆盖查询日，已在卡片中标记。</p>}
      {quoteError && <p className="daily-signal-coverage" role="status">{quoteError}</p>}
      <div className="daily-signal-results">{visible.map(strategy => <StrategyCard key={strategy.strategy_name} strategy={strategy} asOf={data.date} quotes={quotes} sort={sort} onSort={changeSort} />)}</div>
      {!visible.length && <div className="daily-signal-empty"><h3>{needle ? '没有符合筛选的策略' : !data.date ? '暂无可用的信号缓存' : !covered.length ? '查询日暂无可判断的信号数据' : '当前范围没有买卖信号'}</h3><p>{onlySignals && covered.length > 0 ? '可取消“仅看有信号的策略”，查看各策略的统计和覆盖情况。' : '可以选择其他日期，或稍后重新读取最新缓存。'}</p></div>}
      <section className="daily-signal-method" aria-label="数据来源与统计口径"><h2>数据来源与统计口径</h2><p>来源：已保存的策略回测缓存。不同策略可能采用不同的数据截止日，读取信号不会启动回测或行情更新。</p><p>胜率与平均每笔收益使用同一批近 N 笔已平仓交易，排除未平仓和期末估值记录；样本盈亏缺失时不以更早交易替补。年化收益使用回测起点至查询日的净值，按每年 250 个交易日计算，不受 N 影响。“—”表示数据不足，0.00% 表示实际为零。</p></section>
    </>}
  </div>
}
