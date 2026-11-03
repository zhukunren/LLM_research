import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import LoadingState from '../components/LoadingState'
import { ResponsiveMarketIndicatorChart as MarketIndicatorChart, type ChartBar } from '../components/MarketIndicatorChart'
import { StockName } from '../components/StockSearch'

export type PatternMatch = { bars: ChartBar[]; similarity?: number; stock_code?: string; start_date?: string; end_date?: string; reason?: string; scope?: string; items?: PatternMatch[]; as_of?: string
  candidate_points?: number[]; template_points?: number[]; distance_components?: Record<string, number>; algorithm_version?: string; normalization?: string; interpretation?: string
  match_age_bars?: number; priority_score?: number; age_basis?: string; end_lag_days?: number
  scanned_securities?: number; valid_securities?: number; requested_as_of?: string; source_fingerprint?: unknown
  template_timing?: 'verified' | 'post_hoc' | 'unknown'; timing_warning?: string; price_basis?: string; frequency?: string; search_run_id?: string
}
const matchKey = (match: PatternMatch) => `${match.stock_code}@${match.start_date}`

export default function PatternComparison({ target, matchAction, result, loading, error, selectedKey, onSelect, onRetry, minSimilarity, emptyActionLabel = '重新匹配' }: {
  target: ReactNode; matchAction: ReactNode; result: PatternMatch | null; loading: boolean; error: string; selectedKey: string
  onSelect: (key: string) => void; onRetry: () => void; minSimilarity?: number; emptyActionLabel?: string
}) {
  const [view, setView] = useState<'candles' | 'normalized'>('candles')
  const matches = result?.items?.length ? result.items : result?.bars.length ? [result] : []
  const selected = matches.find(item => matchKey(item) === selectedKey) ?? matches[0]
  const hasOverlay = validPair(selected?.template_points, selected?.candidate_points)
  useEffect(() => { if (!hasOverlay) setView('candles') }, [hasOverlay])
  const weak = selected?.similarity !== undefined && minSimilarity !== undefined && Number.isFinite(minSimilarity) && selected.similarity < minSimilarity
  return <section className="pattern-comparison" data-has-results={matches.length > 0} aria-label="形态对照工作台">
    <div className="pattern-comparison-charts">
      {target}
      {matchAction && <div className="pattern-comparison-match-actions">{matchAction}</div>}
      {loading ? <div className="pattern-match-feedback"><LoadingState label="正在寻找相似的真实 K 线…" compact /></div> : error ? <p className="pattern-match-feedback workspace-error" role="alert">{error}<button className="text-button workspace-button" onClick={onRetry}>重试</button></p> : result && !selected ? <p className="pattern-match-feedback" role="status">{result.reason || '没有可用的相似样本'}<button className="text-button workspace-button" onClick={onRetry}>{emptyActionLabel}</button></p> : null}
      {selected && <section className="pattern-comparison-candidate" aria-label="候选K线对照" aria-busy={loading}>
        <header className="pattern-comparison-chart-heading"><div><h2>选中样本</h2>{selected?.stock_code ? <StockName code={selected.stock_code} /> : <span>从右侧选择相似样本</span>}</div>{selected && <span className="pattern-comparison-score"><strong>{selected.similarity?.toFixed(1)}</strong><small>相似度 / 100</small></span>}</header>
        <div className="pattern-comparison-view-switch segmented" role="group" aria-label="对照显示方式">
          <button type="button" className="workspace-button" aria-pressed={view === 'candles'} onClick={() => setView('candles')}>原始 K 线</button>
          <button type="button" className="workspace-button" aria-pressed={view === 'normalized'} disabled={!hasOverlay} onClick={() => setView('normalized')}>归一化叠加</button>
        </div>
        <div className="pattern-comparison-chart-content">
          {view === 'normalized' && hasOverlay ? <NormalizedOverlay expected={selected.template_points!} actual={selected.candidate_points!} /> : <PatternMarketChart bars={selected.bars} />}
        </div>
        {selected && <p className="pattern-comparison-dates">{selected.start_date} — {selected.end_date} · {selected.bars.length} 个交易日{ageDescription(selected) && ` · ${ageDescription(selected)}`}</p>}
        {weak && <p className="pattern-comparison-notice">低于选股参考阈值 {minSimilarity} 分；此处仅为历史案例排序，不表示选股命中。</p>}
        {selected && <MatchExplanation match={selected} />}
      </section>}
    </div>
    {matches.length > 0 && <aside className="pattern-comparison-results" aria-label="相似K线样本">
      <header className="pattern-comparison-results-heading"><div><h2>相似样本 <span>{matches.length || (loading ? '匹配中' : '待匹配')}</span></h2><small>按相似度排序</small></div>{(result || error) && <button type="button" className="text-button workspace-button" aria-label="刷新形态匹配" disabled={loading} onClick={onRetry}><RefreshCw size={14} /></button>}</header>
      <div className="pattern-comparison-result-list">{matches.map((match, index) => <button type="button" data-stock-ignore key={matchKey(match)} className={'workspace-button pattern-comparison-result' + (selected === match ? ' selected' : '')} aria-pressed={selected === match} aria-label={`查看 ${match.stock_code} 相似K线，相似度 ${match.similarity?.toFixed(1)} 分`} onClick={() => onSelect(matchKey(match))}>
        <span className="pattern-comparison-result-title"><span className="pattern-match-rank">{String(index + 1).padStart(2, '0')}</span>{match.stock_code && <StockName code={match.stock_code} interactive={false} />}<strong className="pattern-comparison-result-score">{match.similarity?.toFixed(1)}</strong></span>
        <MiniCandles bars={match.bars} /><span className="pattern-similar-dates">{match.start_date} — {match.end_date}{ageDescription(match) && <><br />{ageDescription(match)}</>}</span>
      </button>)}</div>
      <div className="pattern-comparison-scope">
        <p>相似度不是上涨概率。</p>
        {result?.as_of && <span>行情截至 {result.as_of}</span>}
        <details><summary>匹配范围与口径{result?.template_timing === 'post_hoc' ? ' · 事后构造' : ''}</summary>
          <p>{result?.scope || '本地证券每只最近 120 个结束窗口，每家公司取最相近区间。行情区间模板排除来源股票。相似度仅描述形态接近程度，不预测后续收益。'}</p>
          {result?.scanned_securities !== undefined && result.valid_securities !== undefined && <p>有效覆盖 {result.valid_securities} / 已扫描 {result.scanned_securities} 只证券</p>}
          {result?.timing_warning && <p className="pattern-comparison-notice">{result.timing_warning}</p>}
          {result?.requested_as_of && <p>检索截止 {result.requested_as_of}</p>}
          <p>日线 · {result?.price_basis && result.price_basis !== 'unadjusted' ? result.price_basis : '未复权'} · 固定交易日窗口</p>
        </details></div>
    </aside>}
  </section>
}


function ageDescription(match: PatternMatch): string {
  const age = match.match_age_bars
  return age !== undefined && Number.isFinite(age) ? `距截止窗口 ${age} 根${match.end_lag_days !== undefined ? `（结束日距行情截止 ${match.end_lag_days} 个自然日）` : ''}` : ''
}
function validPair(expected?: number[], actual?: number[]): boolean {
  return !!expected && !!actual && expected.length >= 2 && expected.length === actual.length && expected.every(Number.isFinite) && actual.every(Number.isFinite)
}
function NormalizedOverlay({ expected, actual }: { expected: number[]; actual: number[] }) {
  const points = (values: number[]) => values.map((value, index) => `${12 + index / (values.length - 1) * 576},${148 - value * 136}`).join(' ')
  return <div className="pattern-normalized-overlay">
    <svg viewBox="0 0 600 160" role="img" aria-label="模板与候选归一化走势叠加">
      {[12, 80, 148].map(y => <line key={y} x1="12" x2="588" y1={y} y2={y} className="chart-grid" />)}
      <polyline className="pattern-overlay-template" points={points(expected)} fill="none" strokeWidth="2" />
      <polyline className="pattern-overlay-candidate" points={points(actual)} fill="none" strokeWidth="2" strokeDasharray="7 4" />
    </svg>
    <p><span className="pattern-overlay-template-key">实线：目标模板</span> · <span>虚线：候选窗口</span></p>
  </div>
}
const componentLabels: Record<string, string> = { path: '路径误差', velocity: '变化速度误差', body: '实体误差', wicks: '影线误差', direction: '方向差异', gap: '跳空误差' }
function MatchExplanation({ match }: { match: PatternMatch }) {
  const components = Object.entries(match.distance_components || {}).filter(([key, value]) => key in componentLabels && Number.isFinite(value))
  if (!match.algorithm_version && !components.length && !match.normalization) return null
  return <details className="pattern-match-explanation"><summary>为什么相似 · 算法与误差</summary>
    {match.algorithm_version && <p>算法版本：{match.algorithm_version}</p>}
    {match.normalization && <p>{match.normalization === 'first_price_relative_v2' ? '首价归零、窗口极差缩放；目标路径重采样到固定交易日根数。图中两条曲线共用显示尺度，不代表相同涨跌幅。' : `归一化口径：${match.normalization}`}</p>}
    {components.length > 0 && <><dl>{components.map(([key, value]) => <div key={key}><dt>{componentLabels[key]}</dt><dd>{value.toFixed(6)}</dd></div>)}</dl><p>以上为算法误差分量，越小表示该维度越接近；不是百分比、胜率或收益预测。</p></>}
    {match.age_basis && <p>时间口径：{match.age_basis}</p>}
    {match.interpretation && <p>{match.interpretation}</p>}
  </details>
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
