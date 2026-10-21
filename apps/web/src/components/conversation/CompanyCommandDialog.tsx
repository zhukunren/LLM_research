import { lazy, Suspense, useEffect, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceSession } from '../../WorkspaceSession'
import { trapDialogTab } from '../../keyboard'
import type { CommandCompany, CompanyCommandKind } from './companyCommands'

const Financials = lazy(() => import('../CompanyFinancialsPanel'))
const Disclosures = lazy(() => import('../DisclosuresPanel'))
const Reports = lazy(() => import('./CompanyReportsPanel'))
const News = lazy(() => import('./CompanyNewsPanel'))
const Market = lazy(() => import('./CompanyMarketPanel'))
const titles: Record<Exclude<CompanyCommandKind, 'company'>, string> = {
  financials: '公司财务', disclosures: '公司原始披露', reports: '公司研报', news: '公司资讯', market: '公司行情',
}

export default function CompanyCommandDialog({ company, kind, returnFocus, onClose }: {
  company: CommandCompany; kind: Exclude<CompanyCommandKind, 'company'>; returnFocus: RefObject<HTMLTextAreaElement>; onClose: () => void
}) {
  const session = useWorkspaceSession(), close = useRef<HTMLButtonElement>(null)
  const title = titles[kind]
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    close.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      const target = returnFocus.current?.isConnected ? returnFocus.current : previous
      if (target?.isConnected) target.focus({ preventScroll: true })
    }
  }, [returnFocus])
  return createPortal(<div className="company-command-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="company-command-dialog workspace-tool-dialog workspace-drawer" role="dialog" aria-modal="true" aria-label={title}
      onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose() }; trapDialogTab(event) }}>
      <header><div><h2>{company.name} · {title}</h2><p>{company.stock_code}</p></div>
        <button ref={close} type="button" className="secondary-button workspace-button" onClick={onClose}>关闭{title}</button></header>
      <div className="company-command-dialog-body"><Suspense fallback={<p>正在打开{title}…</p>}>
        {kind === 'financials' && <Financials stockCode={company.stock_code} />}
        {kind === 'disclosures' && <Disclosures stockCode={company.stock_code} />}
        {kind === 'reports' && <Reports stockCode={company.stock_code} />}
        {kind === 'news' && <News stockCode={company.stock_code} />}
        {kind === 'market' && <Market stockCode={company.stock_code} />}
      </Suspense></div>
    </section>
  </div>, session.portalTarget ?? document.body)
}
