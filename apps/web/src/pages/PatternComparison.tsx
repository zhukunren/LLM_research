import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChartNoAxesCombined, RefreshCw, Search } from 'lucide-react'
import LoadingState from '../components/LoadingState'
import { ResponsiveMarketIndicatorChart as MarketIndicatorChart, type ChartBar } from '../components/MarketIndicatorChart'
import { StockName } from '../components/StockSearch'

export type PatternMatch = { bars: ChartBar[]; similarity?: number; stock_code?: string; start_date?: string; end_date?: string; reason?: string; scope?: string; items?: PatternMatch[]; as_of?: string }
const matchKey = (match: PatternMatch) => `${match.stock_code}@${match.start_date}`

export default function PatternComparison({ target, matchAction, result, loading, error, selectedKey, onSelect, onRetry }: {
  target: ReactNode; matchAction: ReactNode; result: PatternMatch | null; loading: boolean; error: string; selectedKey: string
  onSelect: (key: string) => void; onRetry: () => void
}) {
  const matches = result?.items?.length ? result.items : result?.bars.length ? [result] : []
  const selected = matches.find(item => matchKey(item) === selectedKey) ?? matches[0]
  return <section className="pattern-comparison" aria-label="形态对照工作台">
    <div className="pattern-comparison-charts">
      {target}
      <div className="pattern-comparison-match-actions">{matchAction}</div>
      <section className="pattern-comparison-candidate" aria-label="候选K线对照" aria-busy={loading}>
        <header className="pattern-comparison-chart-heading"><div><h2>选中样本</h2>{selected?.stock_code ? <StockName code={selected.stock_code} /> : <span>从右侧选择相似样本</span>}</div>{selected && <span className="pattern-comparison-score"><strong>{selected.similarity?.toFixed(1)}</strong><small>相似度 / 100</small></span>}</header>
        <div className="pattern-comparison-chart-content">
          {loading ? <LoadingState label="正在寻找相似的真实 K 线…" compact /> : error ? <p className="workspace-error" role="alert">{error}<button className="text-button workspace-button" onClick={onRetry}>重试</button></p> : selected ? <PatternMarketChart bars={selected.bars} /> : <div className="pattern-comparison-placeholder"><ChartNoAxesCombined size={24} /><p>{result?.reason || '匹配后在这里对照相似 K 线。'}</p></div>}
        </div>
        {selected && <p className="pattern-comparison-dates">{selected.start_date} — {selected.end_date} · {selected.bars.length} 个交易日</p>}
      </section>
    </div>
    <aside className="pattern-comparison-results" aria-label="相似K线样本">
      <header className="pattern-comparison-results-heading"><div><h2>相似样本 <span>{matches.length || (loading ? '匹配中' : '待匹配')}</span></h2><small>按相似度排序</small></div>{(result || error) && <button type="button" className="text-button workspace-button" aria-label="刷新形态匹配" disabled={loading} onClick={onRetry}><RefreshCw size={14} /></button>}</header>
      <div className="pattern-comparison-result-list">{matches.length ? matches.map((match, index) => <button type="button" data-stock-ignore key={matchKey(match)} className={'workspace-button pattern-comparison-result' + (selected === match ? ' selected' : '')} aria-pressed={selected === match} aria-label={`查看 ${match.stock_code} 相似K线，相似度 ${match.similarity?.toFixed(1)} 分`} onClick={() => onSelect(matchKey(match))}>
        <span className="pattern-comparison-result-title"><span className="pattern-match-rank">{String(index + 1).padStart(2, '0')}</span>{match.stock_code && <StockName code={match.stock_code} interactive={false} />}<strong className="pattern-comparison-result-score">{match.similarity?.toFixed(1)}</strong></span>
        <MiniCandles bars={match.bars} /><span className="pattern-similar-dates">{match.start_date} — {match.end_date}</span>
      </button>) : <div className="pattern-comparison-list-empty"><Search size={22} /><p>{loading ? '正在比较本地行情' : error ? '暂时无法读取候选' : result ? '没有可用的相似样本' : '匹配结果将在这里排列'}</p></div>}</div>
      <div className="pattern-comparison-scope">{result?.as_of && <span>行情截至 {result.as_of}</span>}<details><summary>匹配范围与口径</summary><p>{result?.scope || '本地证券每只最近 120 个结束窗口，每家公司取最相近区间。行情区间模板排除来源股票。相似度仅描述形态接近程度。'}</p></details></div>
    </aside>
  </section>
}

export function PatternMarketChart({ bars, closePath = false }: { bars: ChartBar[]; closePath?: boolean }) {
  const frame = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(160)
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const { height: availableHeight } = entries[0].contentRect
      if (availableHeight > 0) setHeight(Math.max(110, Math.floor(availableHeight)))
    })
    observer.observe(frame.current)
    return () => observer.disconnect()
  }, [])
  const chart = useMemo(() => ({ bars, placement: 'overlay' as const, lines: closePath ? [{ id: 'source-close', label: '收盘路径', color: 'var(--ui-chart-line)', values: bars.map(bar => bar.close) }] : [], histogram: null, reference_lines: [] }), [bars, closePath])
  return <div ref={frame} className="pattern-comparison-plot"><MarketIndicatorChart chart={chart} height={height} minHeight={110} showLegend={false} /></div>
}

export function MiniCandles({ bars }: { bars: ChartBar[] }) {
  const valid = bars.filter(bar => bar.quality_valid !== false && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
  if (!valid.length) return <span className="workbench-help">暂无有效 K 线</span>
  const low = Math.min(...valid.map(bar => bar.low)), high = Math.max(...valid.map(bar => bar.high))
  const span = Math.max(high - low, Math.abs(high) * .02, 1e-8)
  const y = (value: number) => 8 + (high - value) / span * 76
  const step = 244 / Math.max(1, bars.length)
  const width = Math.max(.6, Math.min(7, step * .6))
  return <svg className="pattern-mini-candles" viewBox="0 0 260 92" aria-hidden="true" focusable="false">
    {[28, 52, 76].map(position => <line key={position} x1="8" x2="252" y1={position} y2={position} className="chart-grid" />)}
    {bars.map((bar, index) => bar.quality_valid === false || ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? null : <g key={bar.trade_date} className={bar.close >= bar.open ? 'positive' : 'negative'}><line x1={8 + (index + .5) * step} x2={8 + (index + .5) * step} y1={y(bar.high)} y2={y(bar.low)} /><rect x={8 + (index + .5) * step - width / 2} y={Math.min(y(bar.open), y(bar.close))} width={width} height={Math.max(1, Math.abs(y(bar.open) - y(bar.close)))} /></g>)}
  </svg>
}
