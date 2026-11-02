import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export default function Pagination({ offset, total, pageSize, onChange, disabled = false, nextOffset, label = '列表分页', unit = '条', previousLabel = '上一页', nextLabel = '下一页', inset = false, summary }: {
  offset: number; total: number; pageSize: number; onChange: (offset: number) => void
  disabled?: boolean; nextOffset?: number | null; label?: string; unit?: string
  previousLabel?: string; nextLabel?: string; inset?: boolean; summary?: string
}) {
  const count = Number.isSafeInteger(total) && total > 0 ? total : 0
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 0
  const currentOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
  const pages = size ? Math.ceil(count / size) : 0
  const lastOffset = Math.max(0, (pages - 1) * size)
  const currentPage = Math.min(pages || 1, Math.floor(currentOffset / (size || 1)) + 1)
  // A continuation offset is not a promise of random access, even with a count.
  const canJump = nextOffset === undefined && pages >= 6
  const [page, setPage] = useState(String(currentPage))
  useEffect(() => setPage(String(currentPage)), [currentPage, count, size])
  const request = useRef<{ scope: string; target: number } | null>(null)
  const scope = JSON.stringify([currentOffset, count, size, disabled, nextOffset])
  if (request.current?.scope !== scope) request.current = null
  const go = (target: number) => {
    if (disabled || !size || !count || !Number.isSafeInteger(target) || target < 0 || target === currentOffset) return
    if (nextOffset === undefined && target > lastOffset) return
    if (request.current?.scope === scope && request.current.target === target) return
    request.current = { scope, target }
    onChange(target)
  }
  const enteredPage = /^\d+$/.test(page) ? Number(page) : NaN
  const validPage = Number.isSafeInteger(enteredPage) && enteredPage >= 1 && enteredPage <= pages
  const jump = () => { if (validPage) go((enteredPage - 1) * size) }
  const hasNext = count > 0 && size > 0 && (nextOffset === undefined ? currentOffset + size < count : nextOffset !== null && Number.isSafeInteger(nextOffset) && nextOffset > currentOffset)
  const start = count ? Math.min(currentOffset + 1, count) : 0
  const end = Math.min(currentOffset + size, count)
  return <nav className={`workspace-pagination${inset ? ' workspace-pagination-inset' : ''}`} aria-label={label}>
    <span className="workspace-pagination-summary" aria-live="polite">{summary ?? (count ? `${start.toLocaleString('zh-CN')}–${end.toLocaleString('zh-CN')} / ${count.toLocaleString('zh-CN')} ${unit}` : `共 0 ${unit}`)}</span>
    <div className="workspace-pagination-controls">
      {canJump && <button type="button" className="secondary-button workspace-button" disabled={disabled || currentOffset === 0} onClick={() => go(0)}>首页</button>}
      <button type="button" className="secondary-button workspace-button" aria-label={previousLabel} disabled={disabled || !size || !count || currentOffset <= 0} onClick={() => go(Math.max(0, Math.min(currentOffset - size, nextOffset === undefined ? lastOffset : currentOffset)))}><ChevronLeft size={15} aria-hidden="true" />上一页</button>
      <button type="button" className="secondary-button workspace-button" aria-label={nextLabel} disabled={disabled || !hasNext} onClick={() => go(nextOffset ?? currentOffset + size)}>下一页<ChevronRight size={15} aria-hidden="true" /></button>
      {canJump && <>
        <button type="button" className="secondary-button workspace-button" disabled={disabled || currentOffset === lastOffset} onClick={() => go(lastOffset)}>末页</button>
        <div className="workspace-pagination-jump"><label>第 <input className="workspace-field" aria-label="跳转页码" inputMode="numeric" value={page} disabled={disabled} aria-invalid={!validPage} onChange={event => setPage(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'Enter') { event.preventDefault(); jump() }
        }} /> / {pages} 页</label><button type="button" className="secondary-button workspace-button" disabled={disabled || !validPage || (enteredPage - 1) * size === currentOffset} onClick={jump}>跳转</button></div>
      </>}
    </div>
  </nav>
}
