import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, LockKeyhole, RefreshCw } from 'lucide-react'
import { api } from '../../api'
import { validateModelCatalog, type ModelSelection, type ResearchModelCatalog } from '../../modelSelection'
import './research-model-picker.css'

type Props = {
  value?: Partial<ModelSelection>
  disabled: boolean
  onChange: (selection: ModelSelection) => void
  onAvailabilityChange?: (available: boolean) => void
  portalTargetId?: string
  visible?: boolean
  onCatalogError?: (error: string) => void
}

export default function ResearchModelPicker({ value, disabled, onChange, onAvailabilityChange, portalTargetId, visible = true, onCatalogError }: Props) {
  const [catalog, setCatalog] = useState<ResearchModelCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const [position, setPosition] = useState<CSSProperties>({ left: 12, top: 64 })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const id = useId()
  const availabilityCallback = useRef(onAvailabilityChange)
  availabilityCallback.current = onAvailabilityChange
  const errorCallback = useRef(onCatalogError)
  errorCallback.current = onCatalogError
  useEffect(() => { errorCallback.current?.(error) }, [error])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void api<unknown>('/research-models', { signal: controller.signal }).then(validateModelCatalog).then(result => {
      if (!controller.signal.aborted) { setCatalog(result); setLoading(false) }
    }).catch(reason => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : '模型目录加载失败，请重试。'); setLoading(false) }
    })
    return () => controller.abort()
  }, [attempt])

  useLayoutEffect(() => {
    if (!portalTargetId) { setPortalTarget(null); return }
    const findTarget = () => setPortalTarget(document.getElementById(portalTargetId))
    findTarget()
    const observer = new MutationObserver(findTarget)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [portalTargetId])

  const selectedId = value?.model_id || catalog?.default_model_id
  const selectedModel = catalog?.models.find(model => model.id === selectedId)
  const selectedEffort = value?.reasoning_effort || (value?.model_id ? selectedModel?.default_reasoning_effort : catalog?.default_reasoning_effort)
  const effortLabel = selectedModel?.reasoning_efforts.find(effort => effort.id === selectedEffort)?.label
  const selectedAvailable = Boolean(selectedModel?.available && selectedModel.reasoning_efforts.some(effort => effort.id === selectedEffort))
  const modelLabel = selectedModel?.label || value?.model_id || '选择模型'

  useEffect(() => {
    if (catalog && !loading && !error) availabilityCallback.current?.(selectedAvailable)
  }, [catalog, loading, error, selectedAvailable, selectedId, selectedEffort])

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }, [])

  useEffect(() => { if (disabled) close(false) }, [disabled, close])
  useEffect(() => { if (!visible) close(false) }, [visible, close])

  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const viewport = window.visualViewport
      const viewportWidth = viewport?.width || window.innerWidth
      const viewportHeight = viewport?.height || window.innerHeight
      const viewportLeft = viewport?.offsetLeft || 0
      const viewportTop = viewport?.offsetTop || 0
      const width = Math.min(348, Math.max(0, viewportWidth - 24))
      const maxHeight = Math.max(120, viewportHeight - 24)
      const height = Math.min(popup.current?.scrollHeight || 480, maxHeight)
      const left = Math.max(viewportLeft + 12, Math.min(anchor.left, viewportLeft + viewportWidth - width - 12))
      const below = anchor.bottom + 8
      const top = Math.max(viewportTop + 12, Math.min(below + height <= viewportTop + viewportHeight - 12 ? below : anchor.top - height - 8, viewportTop + viewportHeight - height - 12))
      setPosition({ left, top, width, maxHeight })
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition)
    }
  }, [open, catalog, error, loading, portalTarget])

  useEffect(() => {
    if (!open) return
    const focusTarget = popup.current?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)')
      || popup.current?.querySelector<HTMLElement>('button:not(:disabled)')
    ;(focusTarget || popup.current)?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close()
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open, close, catalog, loading, error])

  function choose(modelId: string, effort: string) {
    if (disabled) return
    const model = catalog?.models.find(item => item.id === modelId)
    if (!model?.available || !model.reasoning_efforts.some(item => item.id === effort)) return
    onChange({ model_id: modelId, reasoning_effort: effort })
    close()
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') { close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
    const active = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (active + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[index]?.focus()
  }

  const button = <button ref={trigger} type="button" className="research-model-trigger" disabled={disabled}
    aria-label={`选择研究模型${selectedId ? `，${modelLabel}${effortLabel ? `，${effortLabel}` : ''}` : ''}`}
    aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
    title={disabled ? '本次研究结束后可切换模型' : undefined}
    onClick={() => setOpen(current => !current)} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
    }}>
    <span className="research-model-trigger-name">{modelLabel}</span>
    {effortLabel && <span className="research-model-trigger-effort">{effortLabel}</span>}
    {catalog && !selectedAvailable && <LockKeyhole size={13} aria-label="当前选择不可用" />}
    <ChevronDown size={15} aria-hidden="true" />
  </button>

  return <>
    {portalTarget ? createPortal(button, portalTarget) : button}
    {open && createPortal(<div id={id} ref={popup} role="menu" aria-label="模型与推理设置" tabIndex={-1}
      className="research-model-popover" style={position} onKeyDown={navigate}>
      <div className="research-model-popover-heading"><span>研究模型</span>{catalog && <span className="research-model-tier">{catalog.account_tier === 'free' ? 'Free' : catalog.account_tier}</span>}</div>
      {loading && <p className="research-model-state" role="status">正在读取可用模型…</p>}
      {error && <div className="research-model-state" role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(current => current + 1)}><RefreshCw size={14} aria-hidden="true" />重新加载</button></div>}
      {!loading && !error && catalog && <>
        <div role="group" aria-label="模型">
          {catalog.models.map(model => <button key={model.id} type="button" role="menuitemradio" aria-checked={selectedId === model.id}
            className="research-model-option" disabled={!model.available} onClick={() => {
              const effort = model.reasoning_efforts.some(item => item.id === selectedEffort) ? selectedEffort! : model.default_reasoning_effort
              choose(model.id, effort)
            }}>
            <span><strong>{model.label}</strong><small>{model.available ? model.description : model.unavailable_reason || '当前账户不可用'}</small></span>
            {!model.available ? <LockKeyhole size={15} aria-hidden="true" /> : selectedId === model.id ? <Check size={17} aria-hidden="true" /> : null}
          </button>)}
        </div>
        {value?.model_id && !selectedModel && <p className="research-model-unavailable" role="status">当前模型不在服务目录中，请选择可用模型。</p>}
        {selectedModel && <div className="research-model-efforts" role="group" aria-label="推理强度">
          <div className="research-model-section-label">推理强度</div>
          <div className="research-model-effort-options">{selectedModel.reasoning_efforts.map(effort => <button type="button" key={effort.id} role="menuitemradio"
            aria-checked={selectedEffort === effort.id} disabled={!selectedModel.available} onClick={() => choose(selectedModel.id, effort.id)}>{effort.label}{selectedEffort === effort.id && <Check size={13} aria-hidden="true" />}</button>)}</div>
          {selectedEffort && !effortLabel && <p className="research-model-unavailable" role="status">当前推理档位不受支持，请重新选择。</p>}
        </div>}
      </>}
    </div>, document.body)}
  </>
}
