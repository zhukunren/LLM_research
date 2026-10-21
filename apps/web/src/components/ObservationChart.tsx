import { chartPalette, chartAxisValue } from '../chartTheme'
import LoadingState from './LoadingState'
import { StockText } from './StockMentions'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { BarChart, CandlestickChart } from 'echarts/charts'
import { AxisPointerComponent, DataZoomComponent, GridComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { api, type ScreeningTaskDecision, type ScreeningTaskRevision } from '../api'
import { StockName } from './StockSearch'

echarts.use([BarChart, CandlestickChart, AxisPointerComponent, DataZoomComponent, GridComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TooltipComponent, CanvasRenderer])
type Bar = { trade_date: string; open: number | null; close: number | null; high: number | null; low: number | null; volume: number | null; quality_valid: boolean }
type Chart = { bars: Bar[]; signal_date: string; cutoff: string; markers: { date: string; name: string; current: boolean; executed_at: string; run_id: string }[]; decision: ScreeningTaskDecision }

export function chartOption(chart: Chart, width = 720) {
  const compact = width < 480
  const dates = chart.bars.map(bar => bar.trade_date)
  const signalIndex = dates.indexOf(chart.signal_date)
  const markerDays = [...new Set(chart.markers.map(marker => marker.date))]
  return {
    animation: false,
    textStyle: { fontFamily: chartPalette.fontFamily, fontSize: 12, color: chartPalette.text },
    tooltip: { trigger: 'axis', triggerOn: 'mousemove|click', renderMode: 'richText', confine: true, backgroundColor: chartPalette.surface, borderColor: chartPalette.border, borderWidth: 1, padding: 12, textStyle: { fontFamily: chartPalette.fontFamily, fontSize: 12, color: chartPalette.text, lineHeight: 20 }, axisPointer: { type: 'cross' } },
    axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: chartPalette.faint, type: 'dashed' }, label: { fontFamily: chartPalette.fontFamily, fontSize: 11, backgroundColor: chartPalette.primary, color: '#ffffff', padding: [4, 6] } },
    grid: [{ left: compact ? 48 : 58, right: compact ? 12 : 18, top: 28, height: '57%' }, { left: compact ? 48 : 58, right: compact ? 12 : 18, top: '73%', height: '13%' }],
    xAxis: [0, 1].map(index => ({ type: 'category', data: dates, gridIndex: index, boundaryGap: true, axisLine: { lineStyle: { color: chartPalette.border } }, axisTick: { show: false }, axisLabel: { show: index === 1, color: chartPalette.muted, fontSize: 12, hideOverlap: true, formatter: (value: string) => compact ? value.slice(5) : value } })),
    yAxis: [{ scale: true, axisLabel: { fontSize: 12, color: chartPalette.muted, formatter: chartAxisValue }, splitLine: { lineStyle: { color: chartPalette.grid } } }, { gridIndex: 1, scale: true, splitNumber: 2, axisLabel: { show: false }, splitLine: { show: false } }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], startValue: Math.max(0, signalIndex - 45), endValue: Math.min(dates.length - 1, Math.max(signalIndex + 90, 100)) }, { type: 'slider', xAxisIndex: [0, 1], bottom: 0, height: compact ? 16 : 20, borderColor: chartPalette.border, fillerColor: 'rgba(0,51,122,0.06)', handleStyle: { color: chartPalette.primary, borderColor: chartPalette.primary }, textStyle: { fontSize: 12, color: chartPalette.muted } }],
    series: [{ name: '日线', type: 'candlestick', data: chart.bars.map(bar => bar.quality_valid ? [bar.open, bar.close, bar.low, bar.high] : ['-', '-', '-', '-']), itemStyle: { color: chartPalette.up, color0: chartPalette.down, borderColor: chartPalette.up, borderColor0: chartPalette.down },
      markLine: { symbol: 'none', silent: true, lineStyle: { color: chartPalette.primary, type: 'dashed' }, data: signalIndex >= 0 ? [{ xAxis: chart.signal_date, label: { formatter: '选股日', position: 'insideEndTop', fontSize: 11 } }] : [] },
      markArea: { silent: true, itemStyle: { color: 'rgba(50,131,155,0.045)' }, data: signalIndex >= 0 && chart.cutoff > chart.signal_date ? [[{ xAxis: chart.signal_date }, { xAxis: dates.at(-1) }]] : [] },
      markPoint: { symbol: 'pin', symbolSize: 32, label: { formatter: '选', fontSize: 10 }, data: markerDays.flatMap(day => {
        const bar = chart.bars.find(item => item.trade_date === day)
        if (!bar?.quality_valid || bar.high == null) return []
        const marks = chart.markers.filter(marker => marker.date === day)
        return [{ name: marks.map(marker => `${marker.name} · 执行 ${new Date(marker.executed_at).toLocaleString('zh-CN')}`).join('\n'), coord: [day, bar.high], value: marks.length, itemStyle: { color: marks.some(marker => marker.current) ? chartPalette.primary : chartPalette.faint } }]
      }) } },
      { name: '成交量（本地口径）', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: chart.bars.map(bar => ({ value: bar.quality_valid ? bar.volume : '-', itemStyle: { color: (bar.close ?? 0) >= (bar.open ?? 0) ? chartPalette.up : chartPalette.down } })) }],
  }
}

export default function ObservationChart({ runId, code, view, task, refresh }: { runId: string; code: string; view: 'selection' | 'observation'; task: ScreeningTaskRevision; refresh: number }) {
  const [chart, setChart] = useState<Chart | null>(null), [error, setError] = useState(''), [perspective, setPerspective] = useState(view)
  const [loading, setLoading] = useState(true)
  const frame = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)))
    observer.observe(frame.current)
    return () => observer.disconnect()
  }, [chart])
  useEffect(() => setPerspective(view), [view])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setChart(null)
    api<Chart>(`/observation/runs/${runId}/chart/${encodeURIComponent(code)}?view=${perspective}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setChart(value) }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [runId, code, perspective, refresh])
  const option = useMemo(() => chart ? chartOption(chart, width) : {}, [chart, width])
  return <StockText><section className="observation-card observation-chart"><div className="section-title-row"><h2><StockName code={code} /></h2>{view === 'observation' && <select aria-label="K线观察视角" value={perspective} onChange={e => setPerspective(e.target.value as typeof perspective)} className="workspace-field workspace-select"><option value="observation">后续走势</option><option value="selection">当时视角</option></select>}</div><p className="observation-muted">{chart ? `选股日 ${chart.signal_date} · K 线截至 ${chart.cutoff}` : '日线与成交量'}</p>
    {loading ? <LoadingState label="正在读取 K 线…" skeleton /> : error ? <div className="library-error workspace-error" role="alert">{error}</div> : chart?.bars.length ? <div ref={frame} className="workspace-chart-canvas" role="img" aria-label={`${code} K线，选股日 ${chart.signal_date}，${chart.markers.length}条入选记录`}><ReactEChartsCore echarts={echarts} option={option} notMerge style={{ height: width < 480 ? 320 : 360, width: '100%' }} /></div> : <div className="observation-chart-placeholder">该区间没有可用行情。</div>}
    {chart && <><p className="observation-muted">深蓝：本批次；灰色：其他批次。</p>{chart.markers.length > 0 && <details className="observation-events"><summary>入选记录 · {chart.markers.length} 次</summary>{chart.markers.map(marker => <p key={marker.run_id}><strong>{marker.date} · {marker.name}{marker.current ? '（本批次）' : ''}</strong><small>实际执行 {new Date(marker.executed_at).toLocaleString('zh-CN')}</small></p>)}</details>}<details open className="observation-evidence"><summary>当时的判断依据</summary>{chart.decision.condition_decisions.map(condition => <div key={condition.reference_id}><strong>{task.conditions.find(item => item.condition_id === condition.condition_id)?.description ?? '筛选条件'}</strong><span>{({ true: '符合', false: '不符合', unknown: '数据不足' })[condition.state]}</span><p>{condition.explanation}</p>{Object.keys(condition.actual_values ?? {}).length > 0 && <small>实际值：{Object.entries(condition.actual_values).map(([name, value]) => `${name}：${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join('；')}</small>}</div>)}</details></>}
  </section></StockText>
}
