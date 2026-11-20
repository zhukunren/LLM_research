import { useRef, type KeyboardEvent, type PointerEvent } from 'react'

export default function ScreeningSplitHandle({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const dragging = useRef(false)
  const update = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
    if (bounds?.width) onChange(Math.max(30, Math.min(55, Math.round((event.clientX - bounds.left) / bounds.width * 100))))
  }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const next = event.key === 'ArrowLeft' ? value - 2 : event.key === 'ArrowRight' ? value + 2 : event.key === 'Home' ? 30 : event.key === 'End' ? 55 : undefined
    if (next !== undefined) { event.preventDefault(); onChange(Math.max(30, Math.min(55, next))) }
  }
  return <div className="screening-split-handle" role="separator" tabIndex={0} aria-label="调整对话与结果宽度" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={55} aria-valuenow={value} aria-valuetext={`对话 ${value}%，结果 ${100 - value}%`} aria-controls="screening-view-conversation screening-view-panel" onKeyDown={keys}
    onPointerDown={event => { if (event.button !== 0) return; dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); update(event) }}
    onPointerMove={event => { if (dragging.current) update(event) }}
    onPointerUp={event => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId) }}
    onPointerCancel={() => { dragging.current = false }} onLostPointerCapture={() => { dragging.current = false }}
    onDoubleClick={() => onChange(38)} />
}
