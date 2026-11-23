import { lazy, Suspense, useState } from 'react'
import { useRemoteResource } from '../../useRemoteResource'
import { chartPalette } from '../../chartTheme'
import { ResponsiveMarketIndicatorChart, type ChartBar } from '../MarketIndicatorChart'
import { Change, FeatureNotes, FeatureStatus, FeatureTable, figures, shanghaiToday, type DataNotes } from './FeatureData'

const FeatureLine = lazy(() => import('./FeatureLine'))

type Earnings = DataNotes & {
  as_of: string; fiscal_year: number; window_start: string; window_days: number
  consensus_eps: number | null; brokers: number; comparable_brokers: number; up: number; down: number; flat: number
  actual: { eps: number; ann_date: string; period: string } | null
  series: { date: string; eps: number; brokers: number }[]
  comparisons: { broker: string; direction: string; previous_eps: number; current_eps: number; previous_date: string; report_date: string; available_at: string }[]
}
type ChipDay = { trade_date: string; low_cost: number | null; median_cost: number | null; high_cost: number | null; average_cost: number | null; winner_pct: number | null; spread_pct: number | null }
type Chips = DataNotes & { as_of: string; trade_date: string | null; series: ChipDay[]; distribution: { price: number; percent: number }[] }
type Institutions = DataNotes & {
  as_of: string; month: string; brokers: string[]
  surveys: { visit_date: string; visitors: string; mode: string; host: string }[]
}
const base = (code: string) => '/tushare-features/company/' + encodeURIComponent(code) + '/'

export function EarningsPanel({ code }: { code: string }) {
  const [date, setDate] = useState('')
  const [year, setYear] = useState<number | null>(null)
  const [window, setWindow] = useState(30)
  const anchor = Number((date || shanghaiToday()).slice(0, 4))
  const params = new URLSearchParams({ year: String(year ?? anchor), window_days: String(window) })
  if (date) params.set('as_of', date)
  const resource = useRemoteResource<Earnings>(base(code) + 'earnings?' + params)
  const data = resource.data
  return <section className="tushare-feature" aria-label="盈利预期">
    <div className="tushare-filter-row">
      <label className="workspace-field-label">研究截止日<input type="date" className="workspace-field" min="2000-01-01" max={shanghaiToday()} value={date} onChange={event => { setDate(event.target.value); setYear(null) }} /></label>
      <label className="workspace-field-label">预测财年<select className="workspace-field workspace-select" value={year ?? anchor} onChange={event => setYear(Number(event.target.value))}>
        {[-2, -1, 0, 1, 2].map(offset => <option key={offset} value={anchor + offset}>{anchor + offset} 年</option>)}</select></label>
      <label className="workspace-field-label">回看窗口<select className="workspace-field workspace-select" value={window} onChange={event => setWindow(Number(event.target.value))}>
        {[7, 30, 60, 90].map(value => <option key={value} value={value}>{value} 天</option>)}</select></label>
    </div>
    <FeatureStatus {...resource} label="盈利预期">{data && <>
      <p className="tushare-meta">{data.fiscal_year} 财年 · {data.window_start} 至 {data.as_of} · 按预测入库时间核对</p>
      <div className="tushare-metrics">
        <div><span>预测中位数（元/股）</span><strong>{figures(data.consensus_eps, 3)}</strong><small>{data.brokers} 家券商有可用预测</small></div>
        <div><span>上调 / 下调</span><strong>{data.comparable_brokers ? <><span className="tushare-change is-up">{data.up}</span> / <span className="tushare-change is-down">{data.down}</span></> : '—'}</strong><small>{data.comparable_brokers ? data.comparable_brokers + ' 家有可比预测，' + data.flat + ' 家持平' : '暂无同券商可比预测'}</small></div>
        <div><span>已披露每股收益（元/股）</span><strong>{figures(data.actual?.eps, 3)}</strong><small>{data.actual ? data.actual.ann_date + ' 披露' : '截至所选日暂无可核对的年报数据'}</small></div>
      </div>
      {data.series.length > 0 && <section aria-label="每股收益预测中位数走势">
        <h3>券商预测中位数走势</h3>
        <Suspense fallback={<div className="tushare-line" />}><FeatureLine dates={data.series.map(point => point.date)} values={data.series.map(point => point.eps)} unit="元/股" label="预测中位数" /></Suspense>
        <p className="tushare-meta">{data.series[0].date} 至 {data.series.at(-1)?.date} · 每家券商取当时最新一份预测</p>
      </section>}
      {data.comparisons.length ? <FeatureTable label="券商预测修正"><thead><tr><th scope="col">券商</th><th scope="col">前次预测日</th><th scope="col">最新预测日</th><th scope="col" className="is-number">前次 EPS</th><th scope="col" className="is-number">最新 EPS</th><th scope="col" className="is-number">变动（元/股）</th></tr></thead>
        <tbody>{data.comparisons.map(row => <tr key={row.broker}><th scope="row">{row.broker}</th><td>{row.previous_date}</td><td><time dateTime={row.report_date} title={'入库时间 ' + row.available_at}>{row.report_date}</time></td><td className="is-number">{figures(row.previous_eps, 3)}</td><td className="is-number">{figures(row.current_eps, 3)}</td><td className="is-number"><Change value={row.current_eps - row.previous_eps} unit="" decimals={3} /></td></tr>)}</tbody>
      </FeatureTable> : <p className="tushare-empty">所选财年和窗口暂无可比较的预测。可以切换财年或扩大回看窗口。</p>}
      <FeatureNotes {...data} />
    </>}</FeatureStatus>
  </section>
}

export function ChipsPanel({ code, asOf, bars, unadjusted }: { code: string; asOf: string; bars: ChartBar[]; unadjusted: boolean }) {
  const resource = useRemoteResource<Chips>(base(code) + 'chips' + (asOf ? '?as_of=' + asOf : ''))
  const data = resource.data
  const reference = data?.series.find(row => row.trade_date === data.trade_date)
  const series = data?.series ?? []
  const byDay = new Map(series.map(row => [row.trade_date, row]))
  const chartBars = bars.filter(row => data?.trade_date && row.trade_date <= data.trade_date).slice(-85)
  const canOverlay = unadjusted && chartBars.some(row => byDay.has(row.trade_date))
  const max = Math.max(1, ...(data?.distribution ?? []).map(row => row.percent))
  return <section className="tushare-feature" aria-label="筹码成本">
    <FeatureStatus {...resource} label="筹码成本">{data && <>
      <p className="tushare-meta">{data.trade_date ? '筹码日期 ' + data.trade_date : '暂无已确认交易日'} · 依据历史成交估算持仓成本</p>
      <div className="tushare-metrics">
        <div><span>平均成本（元）</span><strong>{figures(reference?.average_cost)}</strong></div>
        <div><span>约 90% 筹码的成本区间（元）</span><strong>{reference?.low_cost != null && reference.high_cost != null ? figures(reference.low_cost) + '–' + figures(reference.high_cost) : '—'}</strong></div>
        <div><span>成本区间宽度占中位成本</span><strong>{reference?.spread_pct != null ? figures(reference.spread_pct) + '%' : '—'}</strong><small>数值越小，估算成本越集中</small></div>
      </div>
      {canOverlay ? <><h3>日线与筹码成本</h3><p className="tushare-meta">{chartBars[0].trade_date} 至 {chartBars.at(-1)?.trade_date} · 元 · 未复权日线</p>
        <ResponsiveMarketIndicatorChart chart={{ placement: 'overlay', bars: chartBars, histogram: null, reference_lines: [], lines: [
          { id: 'average-cost', label: '平均成本（元）', color: chartPalette.primary, values: chartBars.map(row => byDay.get(row.trade_date)?.average_cost ?? null) },
        ] }} />
      </> : series.length > 0 && <><h3>平均成本走势</h3><Suspense fallback={<div className="tushare-line" />}><FeatureLine dates={series.map(row => row.trade_date)} values={series.map(row => row.average_cost)} unit="元" label="平均成本" /></Suspense></>}
      {data.distribution.length > 0 ? <details className="tushare-notes" open><summary>筹码价位分布 · {data.trade_date}</summary>
        <FeatureTable label="筹码价位分布"><thead><tr><th scope="col" className="is-number">成本（元）</th><th scope="col">相对分布</th><th scope="col" className="is-number">占比</th></tr></thead>
          <tbody>{data.distribution.map(row => <tr key={row.price}><td className="is-number">{figures(row.price)}</td><td><span className="tushare-distribution-track" aria-hidden="true"><span style={{ width: (row.percent / max * 100) + '%' }} /></span></td><td className="is-number">{figures(row.percent, 4)}%</td></tr>)}</tbody>
        </FeatureTable></details> : <p className="tushare-empty">所选交易日暂无价位分布。</p>}
      <FeatureNotes {...data} />
    </>}</FeatureStatus>
  </section>
}

export function InstitutionsPanel({ code }: { code: string }) {
  const [month, setMonth] = useState('')
  const resource = useRemoteResource<Institutions>(base(code) + 'institutions' + (month ? '?month=' + month : ''))
  const data = resource.data
  return <section className="tushare-feature" aria-label="机构动态">
    <div className="tushare-filter-row"><label className="workspace-field-label">金股月份<input type="month" className="workspace-field" min="2000-01" max={shanghaiToday().slice(0, 7)} value={month || data?.month || shanghaiToday().slice(0, 7)} onChange={event => setMonth(event.target.value)} /></label></div>
    <FeatureStatus {...resource} label="机构动态">{data && <>
      <section><h3>{data.month} 券商金股</h3>
        {data.brokers.length ? <ul className="tushare-brokers" aria-label={data.brokers.length + ' 家入选券商'}>{data.brokers.map(name => <li key={name}>{name}</li>)}</ul>
          : <p className="tushare-empty">{data.issues.some(issue => issue.label === '券商月度金股') ? '金股数据待补齐。' : '该月暂无这家公司的金股记录。'}</p>}
      </section>
      <section><h3>近 120 天机构调研</h3><p className="tushare-meta">截至 {data.as_of} · 按调研活动日期展示</p>
        {data.surveys.length ? <FeatureTable label="机构调研记录"><thead><tr><th scope="col">调研日期</th><th scope="col">参与机构或人员</th><th scope="col">接待方式</th><th scope="col">接待方</th></tr></thead>
          <tbody>{data.surveys.map((row, index) => <tr key={index}><td>{row.visit_date}</td><td className="tushare-long-cell">{row.visitors || '—'}</td><td>{row.mode || '—'}</td><td className="tushare-long-cell">{row.host || '—'}</td></tr>)}</tbody></FeatureTable>
          : <p className="tushare-empty">{data.issues.some(issue => issue.label === '机构调研记录') ? '调研数据待补齐。' : '所查区间暂无调研记录。'}</p>}
      </section>
      <FeatureNotes {...data} />
    </>}</FeatureStatus>
  </section>
}
