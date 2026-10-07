import { useEffect, useMemo, useState } from 'react'
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

export function chartOption(chart: Chart) {
  const dates = chart.bars.map(bar => bar.trade_date)
  const signalIndex = dates.indexOf(chart.signal_date)
  const markerDays = [...new Set(chart.markers.map(marker => marker.date))]
  return {
    animation: false,
    textStyle: { fontSize: 11 },
    tooltip: { trigger: 'axis', renderMode: 'richText', textStyle: { fontSize: 13 }, axisPointer: { type: 'cross' } },
    axisPointer: { link: [{ xAxisIndex: 'all' }], label: { fontSize: 11 } },
    grid: [{ left: 58, right: 20, top: 38, height: '57%' }, { left: 58, right: 20, top: '73%', height: '13%' }],
    xAxis: [0, 1].map(index => ({ type: 'category', data: dates, gridIndex: index, boundaryGap: true, axisLine: { lineStyle: { color: '#b5c7d8' } }, axisLabel: { show: index === 1, color: '#53677d', fontSize: 11 } })),
    yAxis: [{ scale: true, axisLabel: { fontSize: 11 }, splitLine: { lineStyle: { color: '#edf2f7' } } }, { gridIndex: 1, scale: true, splitNumber: 2, axisLabel: { show: false }, splitLine: { show: false } }],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], startValue: Math.max(0, signalIndex - 45), endValue: Math.min(dates.length - 1, Math.max(signalIndex + 90, 100)) }, { type: 'slider', xAxisIndex: [0, 1], bottom: 0, height: 20, textStyle: { fontSize: 11 } }],
    series: [{ name: '日线', type: 'candlestick', data: chart.bars.map(bar => bar.quality_valid ? [bar.open, bar.close, bar.low, bar.high] : ['-', '-', '-', '-']), itemStyle: { color: '#cf3843', color0: '#1c8874', borderColor: '#cf3843', borderColor0: '#1c8874' },
      markLine: { symbol: 'none', silent: true, lineStyle: { color: '#174f78', type: 'dashed' }, data: signalIndex >= 0 ? [{ xAxis: chart.signal_date, label: { formatter: '选股日', position: 'insideEndTop', fontSize: 11 } }] : [] },
      markArea: { silent: true, itemStyle: { color: 'rgba(50,131,155,0.045)' }, data: signalIndex >= 0 && chart.cutoff > chart.signal_date ? [[{ xAxis: chart.signal_date }, { xAxis: dates.at(-1) }]] : [] },
      markPoint: { symbol: 'pin', symbolSize: 32, label: { formatter: '选', fontSize: 10 }, data: markerDays.flatMap(day => {
        const bar = chart.bars.find(item => item.trade_date === day)
        if (!bar?.quality_valid || bar.high == null) return []
        const marks = chart.markers.filter(marker => marker.date === day)
        return [{ name: marks.map(marker => `${marker.name} · 执行 ${new Date(marker.executed_at).toLocaleString('zh-CN')}`).join('\n'), coord: [day, bar.high], value: marks.length, itemStyle: { color: marks.some(marker => marker.current) ? '#174f78' : '#788b9e' } }]
      }) } },
      { name: '成交量（本地口径）', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: chart.bars.map(bar => ({ value: bar.volume, itemStyle: { color: (bar.close ?? 0) >= (bar.open ?? 0) ? '#cf3843' : '#1c8874' } })) }],
  }
}

export default function ObservationChart({ runId, code, view, task, refresh }: { runId: string; code: string; view: 'selection' | 'observation'; task: ScreeningTaskRevision; refresh: number }) {
  const [chart, setChart] = useState<Chart | null>(null), [error, setError] = useState(''), [perspective, setPerspective] = useState(view)
  const [loading, setLoading] = useState(true)
  useEffect(() => setPerspective(view), [view])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setChart(null)
    api<Chart>(`/observation/runs/${runId}/chart/${encodeURIComponent(code)}?view=${perspective}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setChart(value) }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [runId, code, perspective, refresh])
  const option = useMemo(() => chart ? chartOption(chart) : {}, [chart])
  return <section className="observation-card observation-chart"><div className="section-title-row"><h2><StockName code={code} /></h2>{view === 'observation' && <select aria-label="K线观察视角" value={perspective} onChange={e => setPerspective(e.target.value as typeof perspective)}><option value="observation">后续走势</option><option value="selection">当时视角</option></select>}</div><p className="observation-muted">{chart ? `选股日 ${chart.signal_date} · K 线截至 ${chart.cutoff}` : '日线与成交量'}</p>
    {loading ? <div className="observation-chart-placeholder" role="status">正在读取 K 线…</div> : error ? <div className="library-error" role="alert">{error}</div> : chart?.bars.length ? <div role="img" aria-label={`${code} K线，选股日 ${chart.signal_date}，${chart.markers.length}条入选记录`}><ReactEChartsCore echarts={echarts} option={option} notMerge style={{ height: 360, width: '100%' }} /></div> : <div className="observation-chart-placeholder">该区间没有可用行情。</div>}
    {chart && <><p className="observation-muted">深蓝：本批次；灰色：其他批次。</p>{chart.markers.length > 0 && <details className="observation-events"><summary>入选记录 · {chart.markers.length} 次</summary>{chart.markers.map(marker => <p key={marker.run_id}><strong>{marker.date} · {marker.name}{marker.current ? '（本批次）' : ''}</strong><small>实际执行 {new Date(marker.executed_at).toLocaleString('zh-CN')}</small></p>)}</details>}<details open className="observation-evidence"><summary>当时的判断依据</summary>{chart.decision.condition_decisions.map(condition => <div key={condition.reference_id}><strong>{task.conditions.find(item => item.condition_id === condition.condition_id)?.description ?? '筛选条件'}</strong><span>{({ true: '符合', false: '不符合', unknown: '数据不足' })[condition.state]}</span><p>{condition.explanation}</p>{Object.keys(condition.actual_values ?? {}).length > 0 && <small>实际值：{Object.entries(condition.actual_values).map(([name, value]) => `${name}：${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join('；')}</small>}</div>)}</details></>}
  </section>
}
