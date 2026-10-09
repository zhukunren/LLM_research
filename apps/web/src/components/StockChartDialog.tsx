import { useEffect, useRef } from 'react'
import { useRemoteResource } from '../useRemoteResource'
import { trapDialogTab } from '../keyboard'
import { ResponsiveMarketIndicatorChart, type ChartBar } from '../pages/TechnicalBrowser'
import { StockName } from './StockSearch'
import { Star } from 'lucide-react'

export default function StockChartDialog({ code, asOf, onClose, onAddToWatchlist, watchBusy, watched, actionError }: { code: string; asOf?: string; onClose: () => void; onAddToWatchlist?: () => void; watchBusy?: boolean; watched?: boolean; actionError?: string }) {
  const { data, error, loading, retry } = useRemoteResource<{ items: ChartBar[] }>(`/securities/${encodeURIComponent(code)}/bars?${asOf ? `as_of=${encodeURIComponent(asOf)}&` : ''}limit=180`)
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
    <section className="stock-chart-dialog" role="dialog" aria-modal="true" aria-label={asOf ? '筛选当日的股票走势' : '股票行情'} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() }; trapDialogTab(event) }}>
      <div className="section-title-row"><h2><StockName code={code} interactive={false} /></h2><button ref={close} className="secondary-button" onClick={onClose}>关闭走势</button></div>
      <p>{asOf ? `截止日期：${asOf}` : bars.length ? `本地日线 · 行情截至 ${bars.at(-1)!.trade_date}` : '最新可用日线行情'}</p>
      {onAddToWatchlist && <button className="text-button" disabled={watchBusy || watched} onClick={onAddToWatchlist}><Star size={14} />{watched ? '已加入观察池' : watchBusy ? '加入中…' : '加入观察池'}</button>}
      {actionError && <p role="alert">{actionError}</p>}
      {loading ? <p role="status">正在读取走势…</p> : error ? <p role="alert">{error}<button className="text-button" onClick={retry}>重试行情</button></p> : bars.length ? <ResponsiveMarketIndicatorChart chart={{ bars, placement: 'overlay', lines: [], histogram: null, reference_lines: [] }} /> : <p>该日期之前没有可用行情。</p>}
    </section>
  </div>
}
