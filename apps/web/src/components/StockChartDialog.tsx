import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { MarketIndicatorChart, type ChartBar } from '../pages/TechnicalBrowser'
import { StockName } from './StockSearch'

export default function StockChartDialog({ code, asOf, onClose }: { code: string; asOf: string; onClose: () => void }) {
  const [bars, setBars] = useState<ChartBar[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    close.current?.focus()
    const controller = new AbortController()
    api<{ items: ChartBar[] }>(`/securities/${encodeURIComponent(code)}/bars?as_of=${asOf}&limit=180`, { signal: controller.signal })
      .then(result => setBars(result.items)).catch(reason => { if (!controller.signal.aborted) setError(reason.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); previous?.focus() }
  }, [code, asOf])
  return <div className="stock-chart-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="stock-chart-dialog" role="dialog" aria-modal="true" aria-label="筛选当日的股票走势" onKeyDown={event => { if (event.key === 'Escape') onClose(); if (event.key === 'Tab') { event.preventDefault(); close.current?.focus() } }}>
      <div className="section-title-row"><h2><StockName code={code} /></h2><button ref={close} className="secondary-button" onClick={onClose}>关闭走势</button></div>
      <p>截至 {asOf} 的日线走势，使用与本次筛选相同的截止日。</p>
      {loading ? <p role="status">正在读取走势…</p> : error ? <p role="alert">{error}</p> : bars.length ? <MarketIndicatorChart chart={{ bars, placement: 'overlay', lines: [], histogram: null, reference_lines: [] }} /> : <p>该日期之前没有可用行情。</p>}
    </section>
  </div>
}
