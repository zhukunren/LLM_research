import LoadingState from './LoadingState'
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import { StockMention } from './StockMentions'
import { placeStockOptions } from './stockSearchLayout'

export type Security = { stock_code: string; name: string; market: string; pinyin?: string; initials?: string }
const Context = createContext<{ items: Security[]; refresh: () => void; loading: boolean; error: string }>({ items: [], refresh: () => {}, loading: false, error: '' })

export function SecuritiesProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Security[]>([])
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    api<{ items: Security[] }>('/security-catalog').then(result => { if (active) setItems(result.items) }).catch(reason => { if (active) setError((reason as Error).message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [revision])
  return <Context.Provider value={{ items, loading, error, refresh: () => setRevision(value => value + 1) }}>{children}</Context.Provider>
}

export const useSecurities = () => useContext(Context)

export function StockName({ code, interactive = true, embedded = false, asOf }: { code: string; interactive?: boolean; embedded?: boolean; asOf?: string }) {
  const { items } = useSecurities()
  const name = items.find(item => item.stock_code === code)?.name
  const identity = <span className="stock-identity"><strong>{name || code}</strong>{name && <small>{code}</small>}</span>
  return interactive ? <StockMention code={code} embedded={embedded} asOf={asOf}>{identity}</StockMention> : identity
}

export default function StockSearch({ value, onChange, label = '搜索股票', includeIndices = false, disabled = false, onSelectionPending }: {
  value: string; onChange: (code: string) => void; label?: string; includeIndices?: boolean; disabled?: boolean
  onSelectionPending?: () => void
}) {
  const { items, loading, error, refresh } = useSecurities()
  const id = useId()
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const control = useRef<HTMLDivElement>(null), options = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState({ above: false, maxHeight: 320 })
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => { if (!open) setQuery(items.find(item => item.stock_code === value)?.name || value) }, [value, items, open])
  const matches = useMemo(() => {
    const text = query.trim().toLowerCase()
    return items.filter(item => (includeIndices || item.market !== '指数') && (!text || [item.stock_code, item.name, item.pinyin, item.initials].some(part => part?.toLowerCase().includes(text)))).slice(0, 10)
  }, [items, includeIndices, query])
  useLayoutEffect(() => {
    if (!open || disabled) return
    function position() {
      const node = control.current
      if (!node) return
      const viewport = window.visualViewport
      let top = (viewport?.offsetTop || 0) + 8
      let bottom = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) - 8
      for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue
        const rect = parent.getBoundingClientRect()
        top = Math.max(top, rect.top + 4); bottom = Math.min(bottom, rect.bottom - 4)
      }
      const next = placeStockOptions(node.getBoundingClientRect(), { top, bottom }, options.current?.scrollHeight || 320)
      setPlacement(current => current.above === next.above && current.maxHeight === next.maxHeight ? current : next)
    }
    position()
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    window.visualViewport?.addEventListener('resize', position)
    window.visualViewport?.addEventListener('scroll', position)
    return () => {
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      window.visualViewport?.removeEventListener('resize', position)
      window.visualViewport?.removeEventListener('scroll', position)
    }
  }, [open, disabled, query, matches.length])
  useLayoutEffect(() => {
    const menu = options.current, selected = menu?.querySelector<HTMLElement>('[aria-selected=true]')
    if (!open || !menu || !selected) return
    if (selected.offsetTop < menu.scrollTop) menu.scrollTop = selected.offsetTop
    else if (selected.offsetTop + selected.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = selected.offsetTop + selected.offsetHeight - menu.clientHeight
  }, [open, cursor, matches, placement.maxHeight])
  function choose(item: Security) { onChange(item.stock_code); setQuery(item.name || item.stock_code); setOpen(false) }
  return <div ref={control} className="stock-search-control workspace-field-shell">
    <input role="combobox" aria-label={label} aria-expanded={open && !disabled} aria-controls={`${id}-choices`} aria-autocomplete="list" aria-activedescendant={open && !disabled && matches[cursor] ? `${id}-${cursor}` : undefined}
      placeholder="名称、拼音或六位代码" value={query} disabled={disabled} autoComplete="off"
      onFocus={() => { setQuery(''); setOpen(true); setCursor(0); onSelectionPending?.() }}
      onClick={() => { if (!open) { setQuery(''); setOpen(true); setCursor(0) } }}
      onBlur={() => setOpen(false)}
      onChange={event => { const text = event.target.value; setQuery(text); setOpen(true); setCursor(0); if (/^\d{6}\.(SH|SZ|BJ)$/i.test(text.trim())) onChange(text.trim().toUpperCase()); else onSelectionPending?.() }}
      onKeyDown={event => {
        // Candidate selection belongs to the IME, not the stock picker.
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.stopPropagation(); return }
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false) }
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setCursor(i => Math.max(0, Math.min(matches.length - 1, i + 1))) }
        if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(i => Math.max(0, i - 1)) }
        if (event.key === 'Enter' && open && matches[cursor]) { event.preventDefault(); choose(matches[cursor]) }
      }} className="workspace-field" />
    {open && !disabled && <div ref={options} role="listbox" id={`${id}-choices`} className="stock-search-options workspace-options" data-placement={placement.above ? 'above' : 'below'} style={{ top: placement.above ? 'auto' : 'calc(100% + 6px)', bottom: placement.above ? 'calc(100% + 6px)' : 'auto', maxHeight: placement.maxHeight }}>
      {matches.map((item, index) => <button type="button" role="option" aria-selected={index === cursor} id={`${id}-${index}`} key={item.stock_code}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(item)} className="workspace-button workspace-menu-option"><strong>{item.name || item.stock_code}</strong><span>{item.stock_code} · {({ SH: '沪市', SZ: '深市', BJ: '北交所' } as Record<string, string>)[item.market] || item.market}</span></button>)}
      {loading && <LoadingState compact label="正在读取股票名称…" />}
      {error && <p role="alert" className="workspace-error">股票名称暂时无法读取。<button type="button" className="text-button workspace-button" onMouseDown={event => event.preventDefault()} onClick={refresh}>重试</button></p>}
      {!matches.length && !loading && !error && <p>没有匹配股票。</p>}
    </div>}
  </div>
}
