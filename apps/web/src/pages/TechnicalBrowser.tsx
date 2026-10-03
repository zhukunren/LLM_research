import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Activity, ArrowRight } from 'lucide-react'
import { api, type DataStatus } from '../api'
import StockSearch from '../components/StockSearch'
import type { LibrarySeed } from '../libraryContext'
import { isText, useSessionState } from '../useSessionState'

type Indicator = { id: string; name: string; min_window?: number; max_window?: number; default_window?: number; signal_window?: number }
type ChartLine = { id: string; label: string; color: string; values: (number | null)[] }
export type ChartBar = { trade_date: string; open: number; high: number; low: number; close: number; volume?: number; quality_valid?: boolean }
export type IndicatorChart = { placement: 'overlay' | 'pane'; lines: ChartLine[]; histogram: ChartLine | null; reference_lines: number[]; bars: ChartBar[] }
type Preview = { indicator: string; window: number; stock_code: string; as_of: string; current: number | null; previous: number | null; state: string; warning: string; series: { date: string; value: number | null }[]; chart?: IndicatorChart }
const guides: Record<string, { explanation: string; example: string; window: number }> = {
  sma: { explanation: '一段时间内的平均收盘价，用于观察价格相对近期均价的位置。', example: '收盘价高于20日均线', window: 20 },
  ema: { explanation: '给近期价格更高权重的均线，对价格变化更敏感。', example: '收盘价高于20日指数均线', window: 20 },
  rsi: { explanation: '观察近期上涨与下跌的相对强度，数值通常在0到100之间。', example: 'RSI14小于30', window: 14 },
  macd_hist: { explanation: '观察两条指数均线之差与信号线的关系，柱值为两者差值的两倍。', example: 'MACD柱大于0', window: 9 },
  macd_dif: { explanation: '12日与26日指数均线的差值。', example: 'MACD DIF大于0', window: 9 },
  macd_dea: { explanation: 'DIF的9日指数平滑值，用于观察趋势变化。', example: 'MACD DEA大于0', window: 9 },
  bollinger: { explanation: '价格均值加两倍标准差形成上轨，反映价格相对近期波动区间的位置。', example: '收盘价高于20日布林带上轨', window: 20 },
  kdj_k: { explanation: '比较收盘价在近期高低区间中的位置并平滑。', example: '9日KDJ的K值小于20', window: 9 },
  kdj_d: { explanation: '对K值继续平滑，观察短期动量。', example: '9日KDJ的D值小于20', window: 9 },
  kdj_j: { explanation: '用K与D的差异放大短期变化，数值可能超出0到100。', example: '9日KDJ的J值小于0', window: 9 },
  atr: { explanation: '平均真实波幅，用于观察价格波动大小，本身不表示涨跌方向。', example: '14日ATR大于1', window: 14 },
}
const fmt = (v: number | null) => v == null || !Number.isFinite(v) ? '—' : Number(v.toFixed(4)).toLocaleString('zh-CN', { maximumFractionDigits: 4 })

export default function TechnicalBrowser({ data, onDescribe }: { data: DataStatus | null; onDescribe: (seed: LibrarySeed) => void }) {
  const [items, setItems] = useState<Indicator[]>([])
  const [selected, setSelected] = useSessionState('indicator.selected', 'sma', (value): value is string => typeof value === 'string' && value in guides)
  const [window, setWindow] = useSessionState('indicator.window', 20, (value): value is number => typeof value === 'number' && Number.isFinite(value))
  const [stock, setStock] = useSessionState('indicator.stock', '000001.SH', isText)
  const [asOf, setAsOf] = useSessionState('indicator.date', data?.last_date ?? '', isText)
  const [result, setResult] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => { const controller = new AbortController(); api<{ items: Indicator[] }>('/indicators', { signal: controller.signal }).then(x => { if (!controller.signal.aborted) setItems(x.items) }).catch(e => { if (!controller.signal.aborted) setError(e.message) }); return () => controller.abort() }, [retry])
  useEffect(() => { if (!asOf && data?.last_date) setAsOf(data.last_date) }, [data?.last_date, asOf])
  const indicator = items.find(x => x.id === selected)
  const guide = guides[selected]
  const invalidInput = !/^\d{6}\.(SH|SZ|BJ)$/.test(stock) ? '请输入完整证券代码，例如 000001.SH。' : !Number.isInteger(window) || window < (indicator?.min_window ?? 2) || window > (indicator?.max_window ?? 250) ? `指标周期应在 ${indicator?.min_window ?? 2}–${indicator?.max_window ?? 250} 之间。` : asOf && data?.last_date && asOf > data.last_date ? '截止日期不能晚于最新行情日期。' : ''
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setResult(null); setError('')
    if ((!data?.available && stock !== '000001.SH') || invalidInput) { setBusy(false); return }
    setBusy(true)
    const timer = globalThis.setTimeout(() => {
      api<Preview>('/indicators/preview', { method: 'POST', signal: controller.signal, body: JSON.stringify({ stock_code: stock, indicator: selected, window, field: 'close', as_of: asOf || undefined }) })
        .then(value => { if (active) setResult(value) })
        .catch(e => { if (active) setError(e.message) })
        .finally(() => { if (active) setBusy(false) })
    }, 150)
    return () => { active = false; controller.abort(); globalThis.clearTimeout(timer) }
  }, [selected, stock, window, asOf, data?.available, invalidInput, retry])
  function describe() {
    let prompt = guide?.example ?? ''
    if (selected === 'sma') prompt = `收盘价高于${window}日均线`
    else if (selected === 'ema') prompt = `收盘价高于${window}日指数均线`
    else if (selected === 'rsi') prompt = `RSI${window}小于30`
    else if (!selected.startsWith('macd_') && guide) prompt = guide.example.replace(String(guide.window), String(window))
    onDescribe({ id: crypto.randomUUID(), prompt })
  }
  return <div className="indicator-browser"><aside className="indicator-catalog"><div className="section-title-row"><h2>常用指标</h2><span>{items.length} 项</span></div>{items.map(item => <button key={item.id} aria-pressed={selected === item.id} className={selected === item.id ? 'active' : ''} onClick={() => { setSelected(item.id); setWindow(guides[item.id]?.window ?? 20) }}><span>{item.name}<small>{item.id.toUpperCase().replaceAll('_', ' ')}</small></span></button>)}</aside>
    <section className="indicator-detail"><div className="section-title-row"><h2>{indicator?.name ?? '简单移动平均线'}</h2><button className="quiet-button" disabled={busy || !!invalidInput} onClick={describe}>描述条件<ArrowRight size={13} /></button></div><p className="indicator-explanation">{guide?.explanation}</p>
      <div className="indicator-controls"><label>股票或指数<StockSearch label="股票或指数" value={stock} onChange={setStock} includeIndices /></label><label>指标周期<input type="number" value={window} min={indicator?.min_window ?? 2} max={indicator?.max_window ?? 100} disabled={selected.startsWith('macd_')} onChange={e => { setWindow(Number(e.target.value)) }} /></label><label>截止日期<input type="date" value={asOf} max={data?.last_date} onInput={e => setAsOf(e.currentTarget.value)} onChange={e => { setAsOf(e.target.value) }} /></label></div>
      {error && <div className="library-error" role="alert">{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>重新加载指标</button></div>}{invalidInput && <p className="library-error" role="alert">{invalidInput}</p>}
      {result ? <div className="indicator-result"><div className="indicator-numbers"><div><span>当日数值</span><strong>{fmt(result.current)}</strong></div><div><span>上一交易日</span><strong>{fmt(result.previous)}</strong></div><div><span>实际行情日</span><strong>{result.as_of}</strong></div></div>{result.chart ? <ResponsiveMarketIndicatorChart chart={result.chart} /> : <IndicatorLine series={result.series.slice(-120)} />}<p className="workbench-help">{result.stock_code} · {result.window} 日周期 · {result.warning}</p></div> : <div className="indicator-placeholder"><Activity size={28} /><p>{busy ? '正在加载 K 线和指标…' : invalidInput ? '调整上方参数后自动更新。' : error ? '暂时无法读取行情，请重试。' : '此证券暂无可用行情。'}</p><small>只使用截止日期及之前的行情数据。</small></div>}

    </section></div>
}

function IndicatorLine({ series }: { series: Preview['series'] }) {
  const known = series.map(item => item.value).filter((value): value is number => value !== null)
  if (!known.length) return <div className="indicator-placeholder">此窗口内没有可计算的指标值。</div>
  const min = Math.min(...known), max = Math.max(...known), span = max - min || 1
  let open = false
  const path = series.map((item, index) => { if (item.value === null) { open = false; return '' } const point = `${15 + index * 670 / Math.max(1, series.length - 1)},${180 - (item.value - min) / span * 150}`; const result = `${open ? 'L' : 'M'}${point}`; open = true; return result }).join(' ')
  return <div className="indicator-chart"><svg viewBox="0 0 700 210" role="img" aria-label="所选指标的真实历史走势"><line x1="15" x2="685" y1="180" y2="180" stroke="var(--ui-border)" /><line x1="15" x2="685" y1="105" y2="105" stroke="var(--ui-border-subtle)" /><path d={path} stroke="var(--ui-chart-line)" fill="none" strokeWidth="2.3" /><text x="15" y="205">{series[0]?.date}</text><text x="685" y="205" textAnchor="end">{series.at(-1)?.date}</text></svg><small>范围 {fmt(min)} — {fmt(max)}；缺失值留空。</small></div>
}

export function ResponsiveMarketIndicatorChart({ chart }: { chart: IndicatorChart }) {
  const frame = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)))
    observer.observe(frame.current)
    return () => observer.disconnect()
  }, [])
  return <div ref={frame} className="responsive-market-chart"><MarketIndicatorChart chart={chart} containerWidth={width || undefined} /></div>
}

export function MarketIndicatorChart({ chart, containerWidth }: { chart: IndicatorChart; containerWidth?: number }) {
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null)
  useEffect(() => setHover(null), [chart])
  const bars = chart.bars.map(bar => bar.quality_valid === false ? { ...bar, open: NaN, high: NaN, low: NaN, close: NaN } : bar)
  if (!bars.length) return <div className="indicator-placeholder">此窗口内没有可显示的 K 线。</div>
  const width = containerWidth && Number.isFinite(containerWidth) ? Math.max(200, containerWidth) : 720
  const pad = { left: containerWidth ? 64 : 44, right: 16, top: 16, bottom: 24 }
  const axisDate = (date?: string) => containerWidth && width < 400 ? date?.slice(5) : date
  const priceHeight = chart.placement === 'pane' ? 196 : 280
  const paneHeight = chart.placement === 'pane' ? 126 : 0
  const totalHeight = priceHeight + paneHeight + 18
  const x = (index: number) => pad.left + index * (width - pad.left - pad.right) / Math.max(1, bars.length - 1)
  const overlayValues = chart.placement === 'overlay' ? chart.lines.flatMap(line => line.values.filter((value): value is number => value !== null && Number.isFinite(value))) : []
  const prices = [...bars.flatMap(bar => [bar.high, bar.low]).filter(Number.isFinite), ...overlayValues]
  if (!prices.length) return <div className="indicator-placeholder">此窗口内没有有效价格。</div>
  const priceMin = Math.min(...prices), priceMax = Math.max(...prices)
  const priceSpan = Math.max(priceMax - priceMin, Math.abs(priceMax) * 0.02, 1e-8)
  const priceY = (value: number) => pad.top + (priceMax - value) / priceSpan * (priceHeight - pad.top - pad.bottom)
  const path = (values: (number | null)[], y: (value: number) => number) => {
    let connected = false
    return values.map((value, index) => {
      if (value === null || !Number.isFinite(value)) { connected = false; return '' }
      const command = connected ? 'L' : 'M'; connected = true
      return `${command}${x(index).toFixed(2)},${y(value).toFixed(2)}`
    }).join(' ')
  }
  const paneValues = chart.placement === 'pane' ? [
    ...chart.lines.flatMap(line => line.values.filter((value): value is number => value !== null && Number.isFinite(value))),
    ...(chart.histogram?.values.filter((value): value is number => value !== null && Number.isFinite(value)) ?? []),
    ...chart.reference_lines,
  ] : []
  const paneMin = paneValues.length ? Math.min(...paneValues) : 0
  const paneMax = paneValues.length ? Math.max(...paneValues) : 1
  const paneSpan = Math.max(paneMax - paneMin, 1e-8)
  const paneTop = priceHeight + 8
  const paneY = (value: number) => paneTop + (paneMax - value) / paneSpan * (paneHeight - 24)
  const zeroY = paneY(0)
  const candleWidth = Math.max(2, Math.min(10, (width - pad.left - pad.right) / Math.max(1, bars.length) * 0.62))
  return <div className={`indicator-market-chart ${chart.placement}`}>
    <div className="indicator-chart-legend"><span className="price-key">K线</span>{chart.lines.map(line => <span key={line.id} style={{ '--series-color': line.color } as CSSProperties}><i />{line.label}</span>)}{chart.histogram && <span style={{ '--series-color': chart.histogram.color } as CSSProperties}><i />{chart.histogram.label}</span>}</div>
    {hover && bars[hover.index] && <div className="indicator-hover-values" role="status"><strong>{bars[hover.index].trade_date}</strong><span>开 {fmt(bars[hover.index].open)}</span><span>高 {fmt(bars[hover.index].high)}</span><span>低 {fmt(bars[hover.index].low)}</span><span>收 {fmt(bars[hover.index].close)}</span>{[...chart.lines, ...(chart.histogram ? [chart.histogram] : [])].map(line => <span key={line.id}>{line.label} {fmt(line.values[hover.index] ?? null)}</span>)}</div>}
    <svg tabIndex={0} aria-keyshortcuts="ArrowLeft ArrowRight Home End" onBlur={() => setHover(null)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = hover?.index ?? bars.length - 1
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? bars.length - 1 : Math.max(0, Math.min(bars.length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1)))
      setHover({ index, y: Number.isFinite(bars[index].close) ? priceY(bars[index].close) : priceHeight / 2 })
    }} style={{ cursor: 'crosshair' }} onPointerLeave={() => setHover(null)} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect()
      const scale = Math.min(rect.width / width, rect.height / totalHeight)
      if (!scale) return
      const px = (event.clientX - rect.left - (rect.width - width * scale) / 2) / scale
      const py = (event.clientY - rect.top - (rect.height - totalHeight * scale) / 2) / scale
      if (px < pad.left || px > width - pad.right || py < pad.top || py > totalHeight - pad.bottom) { setHover(null); return }
      setHover({ index: Math.max(0, Math.min(bars.length - 1, Math.round((px - pad.left) * (bars.length - 1) / (width - pad.left - pad.right)))), y: py })
    }} viewBox={'0 0 ' + width + ' ' + totalHeight} role="img" aria-label={chart.placement === 'overlay' ? 'K线主图叠加指标走势' : 'K线主图和指标副图走势'}>
      {[0, 0.25, 0.5, 0.75, 1].map(ratio => <line key={`price-grid-${ratio}`} x1={pad.left} x2={width - pad.right} y1={pad.top + ratio * (priceHeight - pad.top - pad.bottom)} y2={pad.top + ratio * (priceHeight - pad.top - pad.bottom)} className="indicator-grid" />)}
      {bars.map((bar, index) => ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? null : <g key={bar.trade_date}><line x1={x(index)} x2={x(index)} y1={priceY(bar.high)} y2={priceY(bar.low)} className={bar.close >= bar.open ? 'candle-wick positive' : 'candle-wick negative'} /><rect x={x(index) - candleWidth / 2} y={Math.min(priceY(bar.open), priceY(bar.close))} width={candleWidth} height={Math.max(1.5, Math.abs(priceY(bar.open) - priceY(bar.close)))} className={bar.close >= bar.open ? 'candle-body positive' : 'candle-body negative'} /></g>)}
      {chart.placement === 'overlay' && chart.lines.map(line => <path key={line.id} d={path(line.values, priceY)} fill="none" stroke={line.color} strokeWidth="1.8" className="indicator-series-line" />)}
      {chart.placement === 'pane' && <><line x1={pad.left} x2={width - pad.right} y1={paneTop - 4} y2={paneTop - 4} className="indicator-pane-divider" />{chart.reference_lines.map(value => <g key={`ref-${value}`}><line x1={pad.left} x2={width - pad.right} y1={paneY(value)} y2={paneY(value)} className="indicator-reference-line" /><text x={width - pad.right} y={paneY(value) - 3} textAnchor="end">{value}</text></g>)}{chart.histogram?.values.map((value, index) => value === null || !Number.isFinite(value) ? null : <rect key={`hist-${index}`} x={x(index) - candleWidth / 2} width={candleWidth} y={Math.min(zeroY, paneY(value))} height={Math.max(1, Math.abs(zeroY - paneY(value)))} className={value >= 0 ? 'indicator-histogram positive' : 'indicator-histogram negative'} />)}{chart.lines.map(line => <path key={line.id} d={path(line.values, paneY)} fill="none" stroke={line.color} strokeWidth="1.7" className="indicator-series-line" />)}</>}
      <text x={pad.left} y={totalHeight - 4}>{axisDate(bars[0]?.trade_date)}</text><text x={width - pad.right} y={totalHeight - 4} textAnchor="end">{axisDate(bars.at(-1)?.trade_date)}</text><text x="4" y={pad.top + 9}>{fmt(priceMax)}</text><text x="4" y={priceHeight - pad.bottom}>{fmt(priceMin)}</text>
      {hover && <g className="indicator-crosshair" pointerEvents="none"><line x1={x(hover.index)} x2={x(hover.index)} y1={pad.top} y2={totalHeight - 20} /><line x1={pad.left} x2={width - pad.right} y1={hover.y} y2={hover.y} /><rect x={Math.max(44, Math.min(width - 100, x(hover.index) - 42))} y={totalHeight - 19} width="88" height="19" /><text x={Math.max(88, Math.min(width - 56, x(hover.index)))} y={totalHeight - 5} textAnchor="middle">{bars[hover.index]?.trade_date}</text></g>}
    </svg>
  </div>
}
