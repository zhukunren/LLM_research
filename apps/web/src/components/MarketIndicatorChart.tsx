import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { chartAxisValue } from '../chartTheme'

type ChartLine = { id: string; label: string; color: string; values: (number | null)[] }
export type ChartBar = { trade_date: string; open: number; high: number; low: number; close: number; volume?: number; quality_valid?: boolean }
export type IndicatorChart = { placement: 'overlay' | 'pane'; lines: ChartLine[]; histogram: ChartLine | null; reference_lines: number[]; bars: ChartBar[] }

const fmt = (v: number | null) => v == null || !Number.isFinite(v) ? '—' : Number(v.toFixed(4)).toLocaleString('zh-CN', { maximumFractionDigits: 4 })

type MarketChartPresentation = { height?: number; minHeight?: number; showLegend?: boolean; referenceDate?: string }
export function ResponsiveMarketIndicatorChart({ chart, height, minHeight, showLegend, referenceDate }: { chart: IndicatorChart } & MarketChartPresentation) {
  const frame = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)))
    observer.observe(frame.current)
    return () => observer.disconnect()
  }, [])
  return <div ref={frame} className="responsive-market-chart workspace-chart-frame"><MarketIndicatorChart chart={chart} containerWidth={width || undefined} height={height} minHeight={minHeight} showLegend={showLegend} referenceDate={referenceDate} /></div>
}

export function MarketIndicatorChart({ chart, containerWidth, height, minHeight = 160, showLegend = true, referenceDate }: { chart: IndicatorChart; containerWidth?: number } & MarketChartPresentation) {
  const hintId = useId()
  const [focused, setFocused] = useState(false)
  const [hover, setHover] = useState<{ index: number; y: number; keyboard: boolean } | null>(null)
  useEffect(() => setHover(null), [chart])
  const bars = chart.bars.map(bar => bar.quality_valid === false ? { ...bar, open: NaN, high: NaN, low: NaN, close: NaN } : bar)
  if (!bars.length) return <div className="indicator-placeholder">此窗口内没有可显示的 K 线。</div>
  const width = containerWidth && Number.isFinite(containerWidth) ? Math.max(200, containerWidth) : 720
  const pad = { left: width < 480 ? 56 : 64, right: 14, top: 20, bottom: 26 }
  const axisDate = (date?: string) => containerWidth && width < 400 ? date?.slice(5) : date
  const priceHeight = chart.placement === 'pane' ? (width < 480 ? 180 : 210) : height ? Math.max(minHeight, height) - 18 : width < 480 ? 240 : 280
  const paneHeight = chart.placement === 'pane' ? (width < 480 ? 120 : 140) : 0
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
    ...(chart.histogram ? [0] : []),
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
  const referenceIndex = referenceDate ? bars.findIndex(bar => bar.trade_date === referenceDate) : -1
  const referenceLabelX = Math.max(pad.left, Math.min(width - pad.right - 54, x(referenceIndex) - 27))
  const activeIndex = hover && Number.isFinite(hover.index) ? Math.max(0, Math.min(bars.length - 1, hover.index)) : bars.length - 1
  const activeBar = bars[activeIndex]
  const inspectPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
      const rect = event.currentTarget.getBoundingClientRect()
      const scale = Math.min(rect.width / width, rect.height / totalHeight)
      if (!scale) return
      const px = (event.clientX - rect.left - (rect.width - width * scale) / 2) / scale
      const py = (event.clientY - rect.top - (rect.height - totalHeight * scale) / 2) / scale
      if (px < pad.left || px > width - pad.right || py < pad.top || py > totalHeight - pad.bottom) { setHover(null); return }
      setHover({ index: Math.max(0, Math.min(bars.length - 1, Math.round((px - pad.left) * (bars.length - 1) / (width - pad.left - pad.right)))), y: py, keyboard: false })
  }
  return <div className={`indicator-market-chart workspace-chart ${chart.placement}`}>
    {showLegend && <div className="indicator-chart-legend"><span className="price-key">K线</span>{chart.lines.map(line => <span key={line.id} style={{ '--series-color': line.color } as CSSProperties}><i />{line.label}</span>)}{chart.histogram && <span style={{ '--series-color': chart.histogram.color } as CSSProperties}><i />{chart.histogram.label}</span>}</div>}
    <svg tabIndex={0} aria-describedby={hintId} aria-keyshortcuts="ArrowLeft ArrowRight Home End" onFocus={event => { if (event.target === event.currentTarget) setFocused(true) }} onBlur={() => { setHover(null); setFocused(false) }} onKeyDown={event => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = hover?.index ?? bars.length - 1
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? bars.length - 1 : Math.max(0, Math.min(bars.length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1)))
      setHover({ index, y: Number.isFinite(bars[index].close) ? priceY(bars[index].close) : priceHeight / 2, keyboard: true })
    }} style={{ cursor: 'crosshair', touchAction: 'pan-y', ...(height ? { height: totalHeight, minHeight: 0 } : {}) }} onPointerLeave={() => setHover(current => current?.keyboard ? current : null)} onPointerDown={inspectPointer} onPointerMove={inspectPointer} viewBox={'0 0 ' + width + ' ' + totalHeight} role="img" aria-label={chart.placement === 'overlay' ? 'K线主图叠加指标走势' : 'K线主图和指标副图走势'}>
      {[0, 0.25, 0.5, 0.75, 1].map(ratio => <line key={`price-grid-${ratio}`} x1={pad.left} x2={width - pad.right} y1={pad.top + ratio * (priceHeight - pad.top - pad.bottom)} y2={pad.top + ratio * (priceHeight - pad.top - pad.bottom)} className="indicator-grid" />)}
      {referenceIndex >= 0 && <g className="news-chart-reference" pointerEvents="none"><line x1={x(referenceIndex)} x2={x(referenceIndex)} y1={pad.top} y2={priceHeight - pad.bottom} /><rect x={referenceLabelX} y="1" width="54" height="19" rx="4" /><text x={referenceLabelX + 27} y="14" textAnchor="middle">资讯日</text></g>}
      {bars.map((bar, index) => ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? null : <g key={bar.trade_date}><line x1={x(index)} x2={x(index)} y1={priceY(bar.high)} y2={priceY(bar.low)} className={bar.close >= bar.open ? 'candle-wick positive' : 'candle-wick negative'} /><rect x={x(index) - candleWidth / 2} y={Math.min(priceY(bar.open), priceY(bar.close))} width={candleWidth} height={Math.max(1.5, Math.abs(priceY(bar.open) - priceY(bar.close)))} className={bar.close >= bar.open ? 'candle-body positive' : 'candle-body negative'} /></g>)}
      {chart.placement === 'overlay' && chart.lines.map(line => <path key={line.id} d={path(line.values, priceY)} fill="none" stroke={line.color} strokeWidth="1.8" className="indicator-series-line" />)}
      {chart.placement === 'pane' && <><line x1={pad.left} x2={width - pad.right} y1={paneTop - 4} y2={paneTop - 4} className="indicator-pane-divider" />{chart.reference_lines.map(value => <g key={`ref-${value}`}><line x1={pad.left} x2={width - pad.right} y1={paneY(value)} y2={paneY(value)} className="indicator-reference-line" /><text x={width - pad.right} y={paneY(value) - 3} textAnchor="end">{value}</text></g>)}{chart.histogram?.values.map((value, index) => value === null || !Number.isFinite(value) ? null : <rect key={`hist-${index}`} x={x(index) - candleWidth / 2} width={candleWidth} y={Math.min(zeroY, paneY(value))} height={Math.max(1, Math.abs(zeroY - paneY(value)))} className={value >= 0 ? 'indicator-histogram positive' : 'indicator-histogram negative'} />)}{chart.lines.map(line => <path key={line.id} d={path(line.values, paneY)} fill="none" stroke={line.color} strokeWidth="1.7" className="indicator-series-line" />)}</>}
      <text x={pad.left} y={totalHeight - 4}>{axisDate(bars[0]?.trade_date)}</text><text x={width - pad.right} y={totalHeight - 4} textAnchor="end">{axisDate(bars.at(-1)?.trade_date)}</text><text x="4" y={pad.top + 9}>{chartAxisValue(priceMax)}</text><text x="4" y={priceHeight - pad.bottom}>{chartAxisValue(priceMin)}</text>
      {hover && <g className="indicator-crosshair" pointerEvents="none"><line x1={x(activeIndex)} x2={x(activeIndex)} y1={pad.top} y2={totalHeight - 20} /><line x1={pad.left} x2={width - pad.right} y1={hover.y} y2={hover.y} /><rect x={Math.max(44, Math.min(width - 100, x(activeIndex) - 42))} y={totalHeight - 19} width="88" height="19" /><text x={Math.max(88, Math.min(width - 56, x(activeIndex)))} y={totalHeight - 5} textAnchor="middle">{bars[activeIndex]?.trade_date}</text></g>}
    </svg>
    <p id={hintId} className="indicator-keyboard-hint" data-visible={focused}>← / → 查看相邻交易日；Home / End 跳到首日 / 末日</p>
    <div className="indicator-hover-values workspace-chart-readout" role={hover ? 'status' : 'group'} aria-label="行情数据" aria-live={hover?.keyboard ? 'polite' : 'off'} aria-atomic="true"><strong>{hover ? '查看' : '最近'} {activeBar.trade_date}</strong><span>开 {fmt(activeBar.open)}</span><span>高 {fmt(activeBar.high)}</span><span>低 {fmt(activeBar.low)}</span><span>收 {fmt(activeBar.close)}</span>{[...chart.lines, ...(chart.histogram ? [chart.histogram] : [])].map(line => <span key={line.id}>{line.label} {fmt(line.values[activeIndex] ?? null)}</span>)}</div>
  </div>
}
