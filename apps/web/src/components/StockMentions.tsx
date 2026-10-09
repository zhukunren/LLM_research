import { Children, cloneElement, createContext, Fragment, isValidElement, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, LoaderCircle, Star, TrendingUp } from 'lucide-react'
import { api } from '../api'
import { createStockMatcher, type StockMatcher } from '../stockMentions'
import { useSecurities } from './StockSearch'
import './stock-mentions.css'

const StockChartDialog = lazy(() => import('./StockChartDialog'))
type Target = { code: string; element: HTMLElement; asOf?: string; originalHref?: string }
type Actions = { matcher: StockMatcher; show: (target: Target, fromFocus?: boolean) => void; hideSoon: () => void; open: (code: string, asOf?: string, origin?: HTMLElement) => void }
const Context = createContext<Actions | null>(null)

export function StockInteractionsProvider({ children }: { children: ReactNode }) {
  const { items } = useSecurities()
  const matcher = useMemo(() => createStockMatcher(items), [items])
  const [hover, setHover] = useState<Target | null>(null)
  const [quote, setQuote] = useState<{ code: string; asOf?: string } | null>(() => {
    const parameters = new URLSearchParams(window.location.hash.split('?')[1] || '')
    const code = parameters.get('quote')
    return code && /^\d{6}\.(SH|SZ|BJ)$/.test(code) ? { code } : null
  })
  const [position, setPosition] = useState({ left: 12, top: 60 })
  const [busy, setBusy] = useState(new Set<string>()), [notice, setNotice] = useState(''), [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [added, setAdded] = useState(new Set<string>())
  const attempts = useRef(new Map<string, string>())
  const inFlight = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const popover = useRef<HTMLDivElement>(null)
  const quoteOrigin = useRef<HTMLElement | null>(null)
  const suppressFocus = useRef(false)
  const restoreFocus = useCallback((element: HTMLElement | null) => { if (!element?.isConnected) return; suppressFocus.current = true; element.focus({ preventScroll: true }); suppressFocus.current = false }, [])
  const clearTimer = useCallback(() => { clearTimeout(timer.current) }, [])
  const hideSoon = useCallback(() => { clearTimer(); timer.current = setTimeout(() => setHover(null), 180) }, [clearTimer])
  const show = useCallback((target: Target, fromFocus = false) => {
    if (fromFocus && suppressFocus.current) return
    clearTimer(); setError(null); setHover(target)
    const box = target.element.getBoundingClientRect()
    const width = Math.min(284, window.innerWidth - 24)
    setPosition({ left: Math.max(12, Math.min(box.left, window.innerWidth - width - 12)), top: Math.max(12, Math.min(box.bottom + 8, window.innerHeight - 170)) })
  }, [clearTimer])
  const open = useCallback((code: string, asOf?: string, origin?: HTMLElement) => { clearTimer(); quoteOrigin.current = origin || document.activeElement as HTMLElement; setHover(null); setQuote({ code, asOf }) }, [clearTimer])
  const closeQuote = () => { const origin = quoteOrigin.current; setQuote(null); requestAnimationFrame(() => restoreFocus(origin)) }
  useEffect(() => () => clearTimer(), [clearTimer])
  useLayoutEffect(() => {
    if (!hover || !popover.current) return
    const anchor = hover.element.getBoundingClientRect(), height = popover.current.getBoundingClientRect().height
    setPosition({ left: Math.max(12, Math.min(anchor.left, window.innerWidth - popover.current.offsetWidth - 12)), top: Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - height - 12)) })
  }, [hover, error])
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!detail || typeof detail.stock_code !== 'string') return
      setAdded(current => { const next = new Set(current); if (detail.status === 'ended') next.delete(detail.stock_code); else next.add(detail.stock_code); return next })
    }
    window.addEventListener('observation:changed', changed)
    return () => window.removeEventListener('observation:changed', changed)
  }, [])
  useEffect(() => {
    if (!hover) return
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !hover.element.contains(event.target) && !popover.current?.contains(event.target)) setHover(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setHover(null); restoreFocus(hover.element) } }
    const close = () => setHover(null)
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape)
    window.addEventListener('resize', close); window.addEventListener('scroll', close, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true) }
  }, [hover, restoreFocus])
  async function add(code: string) {
    if (inFlight.current.has(code)) return
    const requestId = attempts.current.get(code) || crypto.randomUUID()
    attempts.current.set(code, requestId); inFlight.current.add(code); setBusy(current => new Set(current).add(code)); setError(null)
    try {
      const result = await api<{ status: string }>('/observation/quick-add', { method: 'POST', body: JSON.stringify({ request_id: requestId, stock_code: code }) })
      if (result.status === 'ended') { attempts.current.delete(code); throw new Error('观察状态已变化，请重新点击加入观察池。') }
      setAdded(current => new Set(current).add(code)); setNotice(`${matcher.codes.get(code)?.name || code}已加入观察池`)
      window.dispatchEvent(new CustomEvent('observation:changed', { detail: { stock_code: code, status: result.status } }))
    } catch (reason) { setError({ code, message: (reason as Error).message }) }
    finally { inFlight.current.delete(code); setBusy(current => { const next = new Set(current); next.delete(code); return next }) }
  }
  const identity = hover && matcher.codes.get(hover.code)
  return <Context.Provider value={{ matcher, show, hideSoon, open }}>{children}
    {notice && <div className="stock-action-notice" role="status">{notice}<button type="button" aria-label="关闭观察提示" onClick={() => setNotice('')}>×</button></div>}
    {hover && createPortal(<div ref={popover} className="stock-action-popover" role="dialog" aria-label={`${identity?.name || hover.code}股票操作`} style={position}
      onPointerEnter={clearTimer} onPointerLeave={hideSoon} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setHover(null); restoreFocus(hover.element) } }}>
      <button className="stock-action-title" type="button" aria-label={`查看${identity?.name || hover.code}行情`} onClick={() => open(hover.code, hover.asOf, hover.element)}><strong>{identity?.name || hover.code}</strong><small>{hover.code}</small></button>
      <button type="button" onClick={() => open(hover.code, hover.asOf, hover.element)}><TrendingUp size={15} />查看行情</button>
      {matcher.codes.has(hover.code) && <button type="button" disabled={busy.has(hover.code) || added.has(hover.code)} onClick={() => void add(hover.code)}>
        {busy.has(hover.code) ? <LoaderCircle size={15} className="spin" /> : added.has(hover.code) ? <Check size={15} /> : <Star size={15} />}{busy.has(hover.code) ? '加入中…' : added.has(hover.code) ? '已加入观察池' : '加入观察池'}
      </button>}{hover.originalHref && <a href={hover.originalHref} target="_blank" rel="noopener noreferrer">查看原文</a>}{error?.code === hover.code && <p role="alert">{error.message}</p>}
    </div>, hover.element.closest('[aria-modal="true"]') || document.body)}
    {quote && <div className="stock-quote-layer"><Suspense fallback={<div className="stock-action-notice" role="status">正在打开行情…</div>}><StockChartDialog code={quote.code} asOf={quote.asOf} onClose={closeQuote}
      onAddToWatchlist={matcher.codes.has(quote.code) ? () => void add(quote.code) : undefined} watchBusy={busy.has(quote.code)} watched={added.has(quote.code)} actionError={error?.code === quote.code ? error.message : undefined} /></Suspense></div>}
  </Context.Provider>
}

export function StockMention({ code, children, embedded = false, asOf }: { code: string; children: ReactNode; embedded?: boolean; asOf?: string }) {
  const actions = useContext(Context)
  const ref = useRef<HTMLAnchorElement | HTMLSpanElement>(null)
  function target() {
    const href = embedded ? ref.current?.closest('a')?.getAttribute('href') : null
    return { code, element: ref.current!, asOf, originalHref: href && /^(https?:\/\/|\/api\/v1\/(documents|news)\/)/i.test(href) ? href : undefined }
  }
  const content = { className: 'stock-mention', 'data-stock-code': code,
    onClick: (event: ReactMouseEvent<HTMLElement>) => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !actions) return; event.preventDefault(); event.stopPropagation(); actions.open(code, asOf, ref.current || undefined) },
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => { if (actions && event.pointerType !== 'touch') actions.show(target()) },
    onPointerLeave: () => actions?.hideSoon(), onFocus: () => actions?.show(target(), true),
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => { if (!actions) return; if (event.key === 'ArrowDown' || event.key === ' ') { event.preventDefault(); actions.show(target()); setTimeout(() => document.querySelector<HTMLButtonElement>('.stock-action-popover button')?.focus(), 0) } },
  }
  if (embedded) return <span ref={ref as React.Ref<HTMLSpanElement>} tabIndex={-1} {...content}>{children}</span>
  const parameters = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.hash.split('?')[1] || '')
  parameters.set('quote', code)
  const base = typeof window === 'undefined' ? '#/research/new' : window.location.hash.split('?')[0] || '#/research/new'
  const label = typeof children === 'string' ? children : actions?.matcher.codes.get(code)?.name || code
  return <a ref={ref as React.Ref<HTMLAnchorElement>} href={`${base}?${parameters}`} aria-label={`查看${label}行情`} {...content}>{children}</a>
}

const skipped = new Set(['input', 'textarea', 'select', 'option', 'code', 'pre', 'svg', 'script', 'style'])
function plainLabel(children: ReactNode): string | null {
  let text = '', known = true
  Children.forEach(children, child => {
    if (typeof child === 'string' || typeof child === 'number') text += String(child)
    else if (isValidElement<{ children?: ReactNode }>(child)) {
      if (typeof child.type !== 'string' && child.type !== Fragment) { known = false; return }
      const value = plainLabel(child.props.children)
      if (value === null) known = false
      else text += value
    }
  })
  return known ? text : null
}
/** Render mentions as React nodes; never rewrite React-owned DOM after rendering. */
export function StockText({ children, asOf }: { children: ReactNode; asOf?: string }) {
  const actions = useContext(Context)
  const catalog = useSecurities()
  const fallback = useMemo(() => createStockMatcher(catalog.items), [catalog.items])
  const matcher = actions?.matcher || fallback
  if (!matcher.codes.size) return <>{children}</>
  function visit(node: ReactNode, embedded = false): ReactNode {
    if (typeof node === 'string') return matcher.split(node).map((token, index) => token.code ? <StockMention key={index} code={token.code} embedded={embedded} asOf={asOf}>{token.text}</StockMention> : token.text)
    if (!isValidElement<{ children?: ReactNode; download?: unknown; 'data-stock-ignore'?: boolean; role?: string; 'aria-label'?: string; onFocus?: React.FocusEventHandler<HTMLElement>; onKeyDown?: React.KeyboardEventHandler<HTMLElement> }>(node)) return node
    if (node.type === Fragment) return cloneElement(node, {}, Children.map(node.props.children, child => visit(child, embedded)))
    if (typeof node.type !== 'string') return node
    if (node.type === 'code') {
      const text = plainLabel(node.props.children)
      const tokens = text && !text.includes('\n') ? matcher.split(text) : []
      return tokens.length === 1 && tokens[0].code ? cloneElement(node, {}, <StockMention code={tokens[0].code} embedded={embedded} asOf={asOf}>{text}</StockMention>) : node
    }
    if (skipped.has(node.type) || node.props.download !== undefined || node.props['data-stock-ignore'] || ['combobox', 'option', 'listbox'].includes(node.props.role || '')) return node
    const inside = embedded || ['button', 'a', 'summary'].includes(node.type)
    const text = ['button', 'a', 'summary'].includes(node.type) && !node.props['aria-label'] ? plainLabel(node.props.children) : null
    const label = text && matcher.split(text).some(token => token.code) ? text : null
    const extra: Partial<typeof node.props> = label ? { 'aria-label': label } : {}
    if (actions && ['button', 'a', 'summary'].includes(node.type)) {
      const offer = (element: HTMLElement, fromFocus = false) => {
        const stock = element.querySelector<HTMLElement>('[data-stock-code]')
        if (!stock?.dataset.stockCode) return false
        const href = element.tagName === 'A' ? element.getAttribute('href') : null
        actions.show({ code: stock.dataset.stockCode, element: stock, asOf, originalHref: href && /^(https?:\/\/|\/api\/v1\/(documents|news)\/)/i.test(href) ? href : undefined }, fromFocus)
        return true
      }
      extra.onFocus = event => { node.props.onFocus?.(event); if (event.target === event.currentTarget) offer(event.currentTarget, true) }
      extra.onKeyDown = event => {
        if (event.key === 'ArrowDown' && offer(event.currentTarget)) {
          event.preventDefault(); event.stopPropagation(); setTimeout(() => document.querySelector<HTMLButtonElement>('.stock-action-popover button')?.focus(), 0)
        } else node.props.onKeyDown?.(event)
      }
    }
    return cloneElement(node, extra, Children.map(node.props.children, child => visit(child, inside)))
  }
  return <>{Children.map(children, child => visit(child))}</>
}
