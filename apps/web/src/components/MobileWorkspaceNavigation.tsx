import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, History, LayoutGrid, Plus, RotateCcw, Settings2, X } from 'lucide-react'
import { WorkspaceAccount } from '../AuthBoundary'
import type { WorkflowType } from '../api'
import { clientServiceMenus, workspaceMenus, type PageId, type ServiceView } from '../navigation'
import type { WorkspaceRoute } from '../workspaceRoute'
import type { WorkspaceTab } from '../workspaceTabs'
import MobileSheet from './MobileSheet'

const primaryMenus = workspaceMenus.filter(item => ['screening', 'conditions', 'watchlist', 'client-service'].includes(item.id))
const moreMenus = workspaceMenus.filter(item => ['intelligence', 'library', 'patterns', 'qmt', 'daily-signals', 'etf'].includes(item.id))
const servicePages = clientServiceMenus.filter(item => ['cards', 'opening-plan', 'suggestions'].includes(item.id))
const serviceManagementPages = clientServiceMenus.filter(item => !servicePages.includes(item))

export default function MobileWorkspaceNavigation({ route, moreOpen, onNavigate, onMore }: {
  route: WorkspaceRoute; moreOpen: boolean; onNavigate: (page: PageId) => void; onMore: () => void
}) {
  const currentPage = route.screeningMethod === 'pattern' ? 'conditions' : route.page
  const onMorePage = !primaryMenus.some(item => item.id === currentPage)
  return <nav className="mobile-workspace-nav" aria-label="手机主导航">
    {primaryMenus.map(({ id, mobileLabel, icon: Icon }) => <button key={id} type="button" className="mobile-nav-item workspace-button" aria-current={currentPage === id ? 'page' : undefined} onClick={() => onNavigate(id)}>
      <span className="mobile-nav-icon"><Icon size={21} aria-hidden="true" /></span>
      <span>{id === 'screening' ? '研究' : mobileLabel}</span>
    </button>)}
    <button type="button" className="mobile-nav-item workspace-button" aria-current={onMorePage ? 'true' : undefined} aria-haspopup="dialog" aria-expanded={moreOpen} onClick={onMore}>
      <span className="mobile-nav-icon"><LayoutGrid size={21} aria-hidden="true" /></span><span>更多</span>
    </button>
  </nav>
}

export function MobileServiceNavigation({ view = 'cards', onSelect }: { view?: ServiceView; onSelect: (view: ServiceView) => void }) {
  const [managementOpen, setManagementOpen] = useState(false)
  const inManagement = serviceManagementPages.some(item => item.id === view)
  return <>
    <nav className="mobile-service-nav" aria-label="对客服务页面">
      {servicePages.map(({ id, label }) => <button key={id} type="button" className="workspace-button" aria-current={view === id ? 'page' : undefined} onClick={() => onSelect(id)}>{label}</button>)}
      <button type="button" className="workspace-button" aria-current={inManagement ? 'true' : undefined} aria-haspopup="dialog" aria-expanded={managementOpen} onClick={() => setManagementOpen(true)}>
        管理<ChevronDown size={14} aria-hidden="true" />
      </button>
    </nav>
    {managementOpen && <MobileSheet title="对客服务管理" onClose={() => setManagementOpen(false)}>
      <nav className="mobile-sheet-list" aria-label="对客服务管理页面">
        {serviceManagementPages.map(({ id, label, description, icon: Icon }) => <button key={id} type="button" className="mobile-sheet-row workspace-button" aria-label={label} aria-current={view === id ? 'page' : undefined} onClick={() => { setManagementOpen(false); onSelect(id) }}>
          <Icon size={20} aria-hidden="true" />
          <span className="mobile-sheet-row-copy"><strong>{label}</strong><small>{description}</small></span>
          {view === id ? <Check size={17} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        </button>)}
      </nav>
    </MobileSheet>}
  </>
}

export function MobileMoreSheet({ page, onNavigate, onHistory, onSettings, onClose }: {
  page: PageId; onNavigate: (page: PageId) => void; onHistory: () => void; onSettings: () => void; onClose: () => void
}) {
  const currentPage = page === 'news' || page === 'reports' ? 'library' : page
  return <MobileSheet title="更多" onClose={onClose}>
    <nav className="mobile-tools-grid" aria-label="研究工具与资料">
      {moreMenus.map(({ id, label, icon: Icon }) => <button key={id} type="button" className="workspace-button" aria-current={currentPage === id ? 'page' : undefined} onClick={() => onNavigate(id)}>
        <span className="mobile-tool-icon"><Icon size={20} aria-hidden="true" /></span><span>{label}</span>
      </button>)}
    </nav>
    <div className="mobile-sheet-list">
      <button type="button" className="mobile-sheet-row workspace-button" onClick={onHistory}><History size={19} aria-hidden="true" /><span>对话记录</span><ChevronRight size={16} aria-hidden="true" /></button>
      <button type="button" className="mobile-sheet-row workspace-button" onClick={onSettings}><Settings2 size={19} aria-hidden="true" /><span>数据与连接</span><ChevronRight size={16} aria-hidden="true" /></button>
    </div>
    <WorkspaceAccount mobile />
  </MobileSheet>
}

export function MobileTabsSheet({ tabs, activeId, canReopen, onActivate, onCloseTab, onReopen, onNew, onClose }: {
  tabs: WorkspaceTab[]; activeId: string; canReopen: boolean; onActivate: (id: string) => void; onCloseTab: (id: string) => void
  onReopen: () => void; onNew: (workflow: WorkflowType) => void; onClose: () => void
}) {
  return <MobileSheet title="已打开页面" onClose={onClose}>
    <div className="mobile-new-tasks">
      <button type="button" className="secondary-button workspace-button" onClick={() => onNew('research')}><Plus size={17} aria-hidden="true" />新建研究</button>
      <button type="button" className="secondary-button workspace-button" onClick={() => onNew('screening')}><Plus size={17} aria-hidden="true" />新建选股</button>
    </div>
    <ul className="mobile-sheet-list mobile-open-pages">
      {tabs.map(tab => {
        const Icon = workspaceMenus.find(item => item.id === tab.route.page)?.icon
        return <li key={tab.id}>
          <button type="button" className="mobile-sheet-row workspace-button" aria-current={tab.id === activeId ? 'page' : undefined} onClick={() => onActivate(tab.id)}>
            {Icon && <Icon size={19} aria-hidden="true" />}<span>{tab.title}</span>{tab.id === activeId && <Check size={17} aria-hidden="true" />}
          </button>
          <button type="button" className="icon-button mobile-icon-button workspace-button" aria-label={`关闭页面：${tab.title}`} onClick={() => onCloseTab(tab.id)}><X size={17} aria-hidden="true" /></button>
        </li>
      })}
    </ul>
    {canReopen && <button type="button" className="mobile-sheet-row mobile-reopen-page workspace-button" onClick={onReopen}><RotateCcw size={17} aria-hidden="true" /><span>重新打开关闭的页面</span></button>}
  </MobileSheet>
}
