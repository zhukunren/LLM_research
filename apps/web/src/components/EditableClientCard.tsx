import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { contentFields, type CardContent, type CardPreview, type CardTextRegion } from '../clientService'
import './editable-client-card.css'

type Edit = { region: CardTextRegion; value: string }
export default function EditableClientCard({ preview, content, alt, mode = 'normal', onApply, onFullscreen }: {
  preview: CardPreview; content: CardContent; alt: string; mode?: 'normal' | 'fit' | 'read'
  onApply: (values: Record<string, string | null>) => void; onFullscreen?: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const completed = useRef(false)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [size, setSize] = useState({ width: 1, height: 1 })
  useEffect(() => {
    if (mode !== 'fit' || !host.current) return
    const element = host.current
    const measure = () => {
      const ratio = Math.min(element.clientWidth / preview.width, element.clientHeight / preview.height)
      if (ratio > 0) setSize({ width: preview.width * ratio, height: preview.height * ratio })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [mode, preview.width, preview.height])
  useEffect(() => { if (edit) { input.current?.focus(); input.current?.select() } }, [edit?.region.key])
  function start(region: CardTextRegion) {
    completed.current = false
    const candidate = region.key.startsWith('market.') ? content.market_overrides?.[region.key.slice(7)] : content[region.key as keyof CardContent]
    setEdit({ region, value: typeof candidate === 'string' ? candidate : region.value })
  }
  const invalid = !!edit && ((edit.region.key === 'brand' || edit.region.key.startsWith('market.')) && !edit.value.trim())
  function commit() {
    if (!edit || invalid || completed.current) return
    completed.current = true
    onApply({ [edit.region.key]: edit.value })
    setEdit(null)
  }
  function cancel() { completed.current = true; setEdit(null) }
  const style: CSSProperties | undefined = mode === 'fit' ? { width: size.width, height: size.height } : undefined
  const editableRegions = (preview.regions || []).filter(region => region.key.startsWith('market.') || contentFields.some(field => field.key === region.key))
  return <div ref={host} className={`client-editable-host is-${mode}`}>
    <div className="client-editable-card" style={style}>
      <img className="client-editable-image" src={preview.image} width={preview.width} height={preview.height} alt={alt} onDoubleClick={onFullscreen} />
      <div className="client-text-hotspots" aria-label="图片文字编辑区域">{editableRegions.map(region => <button key={region.key} type="button" className="client-text-hotspot" aria-label={`编辑图片中的${region.label}`} title={`点击编辑${region.label}`} style={{ left: `${region.x / preview.width * 100}%`, top: `${region.y / preview.height * 100}%`, width: `${region.width / preview.width * 100}%`, height: `${region.height / preview.height * 100}%` }} onClick={() => start(region)}><span><Pencil size={11} />{region.label}</span></button>)}</div>
      {edit && <form className="client-inline-editor" aria-label={`编辑${edit.region.label}`} style={{ top: `${Math.min(85, edit.region.y / preview.height * 100)}%` }} onSubmit={event => { event.preventDefault(); commit() }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) commit() }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit() }
      }}>
        <header><strong>{edit.region.label}</strong><small>{edit.value.length}/{edit.region.max}</small></header>
        <textarea ref={input} aria-label={`图片中的${edit.region.label}`} value={edit.value} maxLength={edit.region.max} rows={edit.region.max > 80 ? 5 : 3} onChange={event => setEdit({ ...edit, value: event.target.value })} />
        {invalid && <p role="alert">此项文字不能为空。</p>}
        {edit.region.key.startsWith('market.') && <small>修改展示文字，原始采集记录保留。</small>}
        <footer>{edit.region.key.startsWith('market.') && <button type="button" className="workspace-button" onClick={() => { completed.current = true; onApply({ [edit.region.key]: null }); setEdit(null) }}>恢复采集文字</button>}<button type="button" className="workspace-button" onClick={cancel}><X size={13} />取消</button><button type="submit" className="workspace-button" disabled={invalid}><Check size={13} />确认修改</button></footer>
      </form>}
    </div>
  </div>
}
