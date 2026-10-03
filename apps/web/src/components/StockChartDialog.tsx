import { useEffect, useRef } from 'react'
import { useRemoteResource } from '../useRemoteResource'
import { trapDialogTab } from '../keyboard'
import { ResponsiveMarketIndicatorChart, type ChartBar } from '../pages/TechnicalBrowser'
import { StockName } from './StockSearch'

export default function StockChartDialog({ code, asOf, onClose }: { code: string; asOf: string; onClose: () => void }) {
  const { data, error, loading, retry } = useRemoteResource<{ items: ChartBar[] }>(`/securities/${encodeURIComponent(code)}/bars?as_of=${asOf}&limit=180`)
  const bars = data?.items || []
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    close.current?.focus()
    const overflow = window.document.body.style.overflow
    window.document.body.style.overflow = 'hidden'
    return () => { window.document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="stock-chart-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="stock-chart-dialog" role="dialog" aria-modal="true" aria-label="筛选当日的股票走势" onKeyDown={event => { if (event.key === 'Escape') onClose(); trapDialogTab(event) }}>
      <div className="section-title-row"><h2><StockName code={code} /></h2><button ref={close} className="secondary-button" onClick={onClose}>关闭走势</button></div>
      <p>截至 {asOf} 的日线走势，使用与本次筛选相同的截止日。</p>
      {loading ? <p role="status">正在读取走势…</p> : error ? <p role="alert">{error}<button className="text-button" onClick={retry}>重试行情</button></p> : bars.length ? <ResponsiveMarketIndicatorChart chart={{ bars, placement: 'overlay', lines: [], histogram: null, reference_lines: [] }} /> : <p>该日期之前没有可用行情。</p>}
    </section>
  </div>
}
