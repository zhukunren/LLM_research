import { ChevronLeft, ChevronRight } from 'lucide-react'

export default function Pagination({ offset, total, pageSize, onChange, disabled = false, nextOffset, label = '列表分页', unit = '条', previousLabel = '上一页', nextLabel = '下一页', inset = false, summary }: {
  offset: number; total: number; pageSize: number; onChange: (offset: number) => void
  disabled?: boolean; nextOffset?: number | null; label?: string; unit?: string
  previousLabel?: string; nextLabel?: string; inset?: boolean; summary?: string
}) {
  const hasNext = total > 0 && (nextOffset === undefined ? offset + pageSize < total : nextOffset !== null)
  const start = total ? Math.min(offset + 1, total) : 0
  const end = Math.min(offset + pageSize, total)
  return <nav className={`workspace-pagination${inset ? ' workspace-pagination-inset' : ''}`} aria-label={label}>
    <span className="workspace-pagination-summary" aria-live="polite">{summary ?? (total ? `${start.toLocaleString('zh-CN')}–${end.toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')} ${unit}` : `共 0 ${unit}`)}</span>
    <div className="workspace-pagination-controls">
      <button type="button" className="secondary-button workspace-button" aria-label={previousLabel} disabled={disabled || offset <= 0} onClick={() => onChange(Math.max(0, offset - pageSize))}><ChevronLeft size={15} aria-hidden="true" />上一页</button>
      <button type="button" className="secondary-button workspace-button" aria-label={nextLabel} disabled={disabled || !hasNext} onClick={() => onChange(nextOffset ?? offset + pageSize)}>下一页<ChevronRight size={15} aria-hidden="true" /></button>
    </div>
  </nav>
}
