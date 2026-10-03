import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api'

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

export function StockName({ code }: { code: string }) {
  const { items } = useSecurities()
  const name = items.find(item => item.stock_code === code)?.name
  return <span className="stock-identity"><strong>{name || code}</strong>{name && <small>{code}</small>}</span>
}

export default function StockSearch({ value, onChange, label = '搜索股票', includeIndices = false, disabled = false }: {
  value: string; onChange: (code: string) => void; label?: string; includeIndices?: boolean; disabled?: boolean
}) {
  const { items, loading, error, refresh } = useSecurities()
  const id = useId()
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  useEffect(() => { if (!open) setQuery(items.find(item => item.stock_code === value)?.name || value) }, [value, items, open])
  const matches = useMemo(() => {
    const text = query.trim().toLowerCase()
    return items.filter(item => (includeIndices || item.market !== '指数') && (!text || [item.stock_code, item.name, item.pinyin, item.initials].some(part => part?.toLowerCase().includes(text)))).slice(0, 10)
  }, [items, includeIndices, query])
  function choose(item: Security) { onChange(item.stock_code); setQuery(item.name || item.stock_code); setOpen(false) }
  return <div className="stock-search-control">
    <input role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${id}-choices`} aria-autocomplete="list" aria-activedescendant={open && matches[cursor] ? `${id}-${cursor}` : undefined}
      placeholder="名称、拼音或六位代码" value={query} disabled={disabled} autoComplete="off"
      onFocus={() => { setQuery(''); setOpen(true); setCursor(0) }}
      onClick={() => { if (!open) { setQuery(''); setOpen(true); setCursor(0) } }}
      onBlur={() => setOpen(false)}
      onChange={event => { const text = event.target.value; setQuery(text); setOpen(true); setCursor(0); if (/^\d{6}\.(SH|SZ|BJ)$/i.test(text.trim())) onChange(text.trim().toUpperCase()) }}
      onKeyDown={event => {
        if (event.key === 'Escape') setOpen(false)
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setCursor(i => Math.max(0, Math.min(matches.length - 1, i + 1))) }
        if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(i => Math.max(0, i - 1)) }
        if (event.key === 'Enter' && open && matches[cursor]) { event.preventDefault(); choose(matches[cursor]) }
      }} />
    {open && <div role="listbox" id={`${id}-choices`} className="stock-search-options">
      {matches.map((item, index) => <button type="button" role="option" aria-selected={index === cursor} id={`${id}-${index}`} key={item.stock_code}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}><strong>{item.name || item.stock_code}</strong><span>{item.stock_code} · {({ SH: '沪市', SZ: '深市', BJ: '北交所' } as Record<string, string>)[item.market] || item.market}</span></button>)}
      {loading && <p role="status">正在读取股票名称…</p>}
      {error && <p role="alert">股票名称暂时无法读取。<button type="button" className="text-button" onMouseDown={event => event.preventDefault()} onClick={refresh}>重试</button></p>}
      {!matches.length && !loading && !error && <p>没有匹配股票。可输入完整代码，或在“数据与服务”更新股票名称。</p>}
    </div>}
  </div>
}
