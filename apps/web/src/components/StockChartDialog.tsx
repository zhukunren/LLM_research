import LoadingState from './LoadingState'
import { useEffect, useRef } from 'react'
import { useRemoteResource } from '../useRemoteResource'
import { trapDialogTab } from '../keyboard'
import { ResponsiveMarketIndicatorChart, type ChartBar } from './MarketIndicatorChart'
import { StockName } from './StockSearch'
import { ChartNoAxesCombined, Star } from 'lucide-react'
import EmptyState from './EmptyState'
import type { StockSignalContext } from '../stockSignalContext'
import TradeExplanation from './TradeExplanation'

export default function StockChartDialog({ code, asOf, signalContext, onClose, onAddToWatchlist, watchBusy, watched, actionError }: { code: string; asOf?: string; signalContext?: StockSignalContext; onClose: () => void; onAddToWatchlist?: () => void; watchBusy?: boolean; watched?: boolean; actionError?: string }) {
  const { data, error, loading, retry } = useRemoteResource<{ items: ChartBar[]; volume_unit?: string; warning?: string; source?: string }>(signalContext && asOf ? `/daily-signals/chart/${encodeURIComponent(code)}?as_of=${encodeURIComponent(asOf)}` : `/securities/${encodeURIComponent(code)}/bars?${asOf ? `as_of=${encodeURIComponent(asOf)}&` : ''}limit=180`)
  const bars = data?.items || []
  const volumeUnit = data?.volume_unit && data.volume_unit !== 'unknown' ? data.volume_unit : '原始单位'
  const volume = { id: 'volume', label: `成交量（${volumeUnit}）`, color: '#208575', values: bars.map(bar => bar.quality_valid !== false && typeof bar.volume === 'number' && Number.isFinite(bar.volume) && bar.volume >= 0 ? bar.volume : null) }
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    close.current?.focus()
    const overflow = window.document.body.style.overflow
    window.document.body.style.overflow = 'hidden'
    return () => { window.document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="stock-chart-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="stock-chart-dialog workspace-tool-dialog workspace-drawer" role="dialog" aria-modal="true" aria-label={asOf ? '筛选当日的股票走势' : '股票行情'} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() }; trapDialogTab(event) }}>
      <div className="section-title-row"><h2><StockName code={code} interactive={false} /></h2><button ref={close} className="secondary-button workspace-button" onClick={onClose}>关闭走势</button></div>
      <p>{asOf ? `截至 ${asOf} · 近 180 个交易日${bars.length && bars.length < 180 ? `（现有 ${bars.length} 日）` : ''}` : bars.length ? `本地日线 · 行情截至 ${bars.at(-1)!.trade_date}` : '最新可用日线行情'}</p>
      {onAddToWatchlist && <button className="text-button workspace-button" disabled={watchBusy || watched} onClick={onAddToWatchlist}><Star size={14} />{watched ? '已加入观察池' : watchBusy ? '加入中…' : '加入观察池'}</button>}
      {actionError && <p role="alert" className="workspace-error">{actionError}</p>}
      {loading ? <LoadingState compact label="正在读取走势…" /> : error ? <div role="alert" className="workspace-error-empty"><EmptyState icon={ChartNoAxesCombined} title="暂时无法读取行情" description={error} actions={<button className="secondary-button workspace-button" onClick={retry}>重试行情</button>} /></div> : bars.length ? <><ResponsiveMarketIndicatorChart chart={{ bars, placement: 'pane', lines: [], histogram: volume, reference_lines: [] }} signals={signalContext?.markers} />{volumeUnit === '原始单位' && <p className="conversation-muted">该本地行情的成交量单位未确认，按原始数值展示。</p>}</> : <EmptyState icon={ChartNoAxesCombined} title="该日期之前没有可用行情。" description="可以更换证券或截止日期，查看其他可用的本地日线。" />}
      {signalContext && asOf && bars.length > 0 && <><p className="stock-signal-context">{signalContext.strategyTitle} · 标记为所选日期的策略信号</p><TradeExplanation key={`${code}:${asOf}`} code={code} date={asOf} initialSide={signalContext.side} /></>}
    </section>
  </div>
}
