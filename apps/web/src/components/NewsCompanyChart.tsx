import { useState } from 'react'
import { Activity, ArrowDownRight, ArrowUpRight, CalendarDays, ChartNoAxesCombined } from 'lucide-react'
import { useRemoteResource } from '../useRemoteResource'
import { ResponsiveMarketIndicatorChart, type ChartBar } from '../pages/TechnicalBrowser'

export type NewsChartCompany = { stock_code: string; name: string }

export default function NewsCompanyChart({ companies, publishedAt }: { companies: NewsChartCompany[]; publishedAt: string | null }) {
  const [atPublication, setAtPublication] = useState(false)
  const timestamp = publishedAt ? new Date(publishedAt).getTime() : NaN
  const newsDate = Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10) : ''
  return <section className="news-company-chart" aria-label="资讯公司K线">
    <div className="news-market-toolbar"><div className="news-chart-heading"><span className="news-market-icon" aria-hidden="true"><ChartNoAxesCombined size={18} /></span><div><h2>企业行情 {companies.length > 1 && <span className="news-chart-count">{companies.length} 家</span>}</h2>{newsDate && <p className="news-market-date"><CalendarDays size={12} aria-hidden="true" />资讯发布于 {newsDate}</p>}</div></div>
      {!!companies.length && newsDate && <div className="news-chart-controls"><div className="segmented" aria-label="资讯行情时间范围"><button type="button" aria-pressed={!atPublication} className={!atPublication ? 'selected' : ''} onClick={() => setAtPublication(false)}>最新行情</button><button type="button" aria-pressed={atPublication} className={atPublication ? 'selected' : ''} onClick={() => setAtPublication(true)}>资讯当日</button></div></div>}
    </div>
    {companies.length ? <div className="news-company-charts">{companies.map(company => <CompanyCandles key={company.stock_code} company={company} newsDate={newsDate} atPublication={atPublication} />)}</div> : <p className="workbench-help">此资讯未识别到可展示 K 线的上市企业。</p>}
  </section>
}

function CompanyCandles({ company, newsDate, atPublication }: { company: NewsChartCompany; newsDate: string; atPublication: boolean }) {
  const path = `/securities/${encodeURIComponent(company.stock_code)}/bars?limit=120${atPublication && newsDate ? '&as_of=' + newsDate : ''}`
  const { data, error, loading, retry } = useRemoteResource<{ items: ChartBar[] }>(path)
  const bars = data?.items || []
  const latest = bars.at(-1), previous = bars.at(-2)
  const close = latest && latest.quality_valid !== false && Number.isFinite(latest.close) ? latest.close : null
  const change = close !== null && previous && previous.quality_valid !== false && Number.isFinite(previous.close) && previous.close > 0 ? (close - previous.close) / previous.close * 100 : null
  const direction = change === null || change === 0 ? 'neutral' : change > 0 ? 'up' : 'down'
  const market = ({ SH: '沪市', SZ: '深市', BJ: '北交所' } as Record<string, string>)[company.stock_code.split('.')[1]]
  return <section className="news-company-candles" aria-label={`${company.name || company.stock_code}K线`}>
    <div className="news-company-card-header"><div className="news-company-identity"><h3>{company.name || company.stock_code}</h3><div>{company.name !== company.stock_code && <span>{company.stock_code}</span>}{market && <span className="news-market-badge">{market}</span>}<span className="news-period-badge">日线</span></div></div>
      {!loading && bars.length > 0 && <div className={`news-company-quote ${direction}`} aria-label="行情摘要"><span className="news-quote-label">收盘价</span><div><strong>{close === null ? '—' : close.toFixed(2)}</strong>{change !== null && <span className="news-price-change" title="较前一交易日收盘价">{change > 0 ? <ArrowUpRight size={14} aria-hidden="true" /> : change < 0 ? <ArrowDownRight size={14} aria-hidden="true" /> : null}{change > 0 ? '+' : ''}{change.toFixed(2)}%</span>}</div></div>}
    </div>
    {loading ? <div role="status" className="news-chart-state"><Activity size={24} aria-hidden="true" /><p>正在读取公司 K 线…</p></div> : error ? <div className="news-chart-state news-chart-failure" role="alert"><Activity size={24} aria-hidden="true" /><p>{error}</p><button type="button" className="secondary-button compact" onClick={retry}>重试公司行情</button></div> : bars.length ? <>
      <ResponsiveMarketIndicatorChart chart={{ bars, placement: 'overlay', lines: [], histogram: null, reference_lines: [] }} height={240} showLegend={false} referenceDate={atPublication ? undefined : newsDate} />
      <div className="news-chart-footer"><p className="news-chart-caption">日线 · {bars[0].trade_date} 至 {bars.at(-1)!.trade_date}{atPublication && ' · 仅显示资讯当日及之前行情'}</p>{!atPublication && bars.some(bar => bar.trade_date === newsDate) && <span className="news-reference-key"><i />资讯日</span>}</div>
    </> : <p className="workbench-help">该公司暂无可用行情。</p>}
  </section>
}
