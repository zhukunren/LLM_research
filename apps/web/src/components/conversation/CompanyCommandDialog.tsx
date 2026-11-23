import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceSession } from '../../WorkspaceSession'
import { trapDialogTab } from '../../keyboard'
import type { CommandCompany, CompanyCommandKind } from './companyCommands'
import '../tushare/tushare-features.css'

const Financials = lazy(() => import('../CompanyFinancialsPanel'))
const Earnings = lazy(() => import('../tushare/CompanyResearchData').then(module => ({ default: module.EarningsPanel })))
const Institutions = lazy(() => import('../tushare/CompanyResearchData').then(module => ({ default: module.InstitutionsPanel })))
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
  const [financialView, setFinancialView] = useState<'financials' | 'earnings' | 'institutions'>('financials')
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
      <div className="company-command-dialog-body">
        {kind === 'financials' && <div className="tushare-switch" role="group" aria-label="公司财务视图">
            <button type="button" className="workspace-button" aria-pressed={financialView === 'financials'} onClick={() => setFinancialView('financials')}>已披露财务</button>
            <button type="button" className="workspace-button" aria-pressed={financialView === 'earnings'} onClick={() => setFinancialView('earnings')}>盈利预期</button>
            <button type="button" className="workspace-button" aria-pressed={financialView === 'institutions'} onClick={() => setFinancialView('institutions')}>机构动态</button>
        </div>}
        <Suspense fallback={<p role="status">正在打开{title}…</p>}>
        {kind === 'financials' && <>
          {financialView === 'financials' && <Financials stockCode={company.stock_code} />}
          {financialView === 'earnings' && <Earnings key={company.stock_code} code={company.stock_code} />}
          {financialView === 'institutions' && <Institutions key={company.stock_code} code={company.stock_code} />}
        </>}
        {kind === 'disclosures' && <Disclosures stockCode={company.stock_code} />}
        {kind === 'reports' && <Reports stockCode={company.stock_code} />}
        {kind === 'news' && <News stockCode={company.stock_code} />}
        {kind === 'market' && <Market stockCode={company.stock_code} />}
      </Suspense></div>
    </section>
  </div>, session.portalTarget ?? document.body)
}
