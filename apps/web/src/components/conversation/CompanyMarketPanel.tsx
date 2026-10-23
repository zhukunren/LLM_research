import { useState } from 'react'
import { useRemoteResource } from '../../useRemoteResource'
import { ResponsiveMarketIndicatorChart, type ChartBar } from '../MarketIndicatorChart'

type Market = { stock_code: string; items: ChartBar[]; price_basis: string; volume_unit: string; amount_unit: string }
const known = (value?: string) => !value || value === 'unknown' ? '待核实' : value
export default function CompanyMarketPanel({ stockCode }: { stockCode: string }) {
  const [asOf, setAsOf] = useState('')
  const params = new URLSearchParams({ limit: '180' })
  if (asOf) params.set('as_of', asOf)
  const resource = useRemoteResource<Market>('/securities/' + encodeURIComponent(stockCode) + '/bars?' + params)
  const data = resource.data
  const bars = data?.stock_code === stockCode ? data.items : []
  return <section className="company-materials" aria-label="公司日线行情">
    <label className="workspace-field-label">行情截止日<input type="date" className="workspace-field" value={asOf} onChange={event => setAsOf(event.target.value)} /></label>
    <p className="research-secondary">读取本地已保存日线；不填截止日时使用最新可用记录。</p>
    {resource.loading ? <p role="status">正在读取公司行情…</p> : resource.error ? <p role="alert" className="workspace-error">{resource.error}<button type="button" className="text-button workspace-button" onClick={resource.retry}>重试公司行情</button></p> : bars.length ? <>
      <p>本地日线 · 实际截至 {bars.at(-1)!.trade_date} · {bars.length} 条记录</p>
      <p className="research-secondary">本地价格：{data?.price_basis === 'unadjusted' ? '未复权' : known(data?.price_basis)} · 成交量单位 {known(data?.volume_unit)} · 成交额单位 {known(data?.amount_unit)}</p>
      {bars.some(bar => bar.quality_valid === false) && <p>异常价格记录已留空，请核对行情来源。</p>}
      <ResponsiveMarketIndicatorChart chart={{ bars, placement: 'overlay', lines: [], histogram: null, reference_lines: [] }} />
    </> : <p>该截止日前没有可用的本地日线行情。</p>}
  </section>
}
