import { lazy, Suspense, useEffect, useState } from 'react'
import { Activity, FileText, GitBranch, Newspaper, Settings2, Shapes, Star } from 'lucide-react'
import { api, type ConversationScope, type ConversationSourceReference, type DataStatus } from './api'
const ObservationPage = lazy(() => import('./pages/ObservationPage'))
const WorkbenchPage = lazy(() => import('./pages/WorkbenchPage'))
const PatternPage = lazy(() => import('./pages/PatternPage'))
const LibraryWorkspace = lazy(() => import('./pages/LibraryWorkspace'))
import SystemDrawer from './pages/DataServicesPanel'
import type { Section } from './pages/WorkbenchPage'
import { useSessionState } from './useSessionState'

const menus = [
  { id: 'screening', label: '帮我选股', icon: GitBranch },
  { id: 'watchlist', label: '观察池', icon: Star },
  { id: 'news', label: '资讯库', icon: Newspaper },
  { id: 'technical', label: '技术指标库', icon: Activity },
  { id: 'patterns', label: '形态库', icon: Shapes },
  { id: 'reports', label: '研报库', icon: FileText },
] as const

type PageId = (typeof menus)[number]['id']
type ScreeningSection = Extract<Section, 'conversation' | 'compose' | 'history'>

function storedScreeningSection(): ScreeningSection {
  try {
    const value = JSON.parse(localStorage.getItem('workbench.section') ?? '"conversation"')
    return value === 'compose' || value === 'history' ? value : 'conversation'
  } catch {
    return 'conversation'
  }
}

export default function App() {
  const [page, setPage] = useSessionState<PageId>('app.page', 'screening', (value): value is PageId => menus.some(item => item.id === value))
  const [data, setData] = useState<DataStatus | null>(null)
  const [systemOpen, setSystemOpen] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [screeningSection, setScreeningSection] = useState<ScreeningSection>(storedScreeningSection)
  const [conversationScope, setConversationScope] = useState<ConversationScope>('screening')
  const [conversationPrompt, setConversationPrompt] = useState<string | undefined>()
  const [conversationSource, setConversationSource] = useState<{ reference: ConversationSourceReference; label: string } | null>(null)

  function changeScreeningSection(section: ScreeningSection) {
    setScreeningSection(section)
    localStorage.setItem('workbench.section', JSON.stringify(section))
  }

  function handleConversationScopeChange(scope: ConversationScope) {
    setConversationScope(scope)
    setConversationSource(null)
  }

  function openConversation(scope: ConversationScope, source?: { reference: ConversationSourceReference; label: string }, prompt?: string) {
    setConversationPrompt(prompt)
    setConversationScope(scope)
    setConversationSource(source ?? null)
    changeScreeningSection('conversation')
    setPage('screening')
  }

  function openComposition() {
    setConversationScope('screening')
    setConversationSource(null)
    changeScreeningSection('compose')
    setPage('screening')
  }

  const refreshStatus = () => {
    api<DataStatus>('/data/status').then((result) => { setData(result); setLoadError('') }).catch((error) => setLoadError(error.message))
  }

  useEffect(() => {
    refreshStatus()
  }, [])

  const active = menus.find((item) => item.id === page)!
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="research-brand"><img src="/brand/soochow-blue.png" alt="东吴证券 SOOCHOW SECURITIES" width="160" height="35" /><img className="sidebar-brand-symbol" src="/brand/soochow-symbol-blue.png" alt="东吴证券" width="90" height="70" /></div>
        <div className="branch-name">张家港营业部<span>投研工作台</span></div>
        <div className="workspace-label">从选股到持续观察</div>
        <nav className="workspace-navigation" aria-label="主菜单">
          {menus.map(({ id, label, icon: Icon }) => <button className={'nav-item ' + (page === id ? 'active' : '')} key={id} aria-label={label} title={label} aria-current={page === id ? 'page' : undefined} onClick={() => { if (id === 'screening') openConversation('screening'); else setPage(id) }}><Icon size={16} strokeWidth={1.8} /><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-bottom"><div className="sidebar-mode">探索模式</div><div className="research-data-status"><span className={'status-dot ' + (loadError ? 'warning' : data?.available ? 'good' : 'warning')} />{loadError ? '服务连接异常' : data ? data.available ? '行情可供查询' : '待添加行情数据' : '正在检查数据'}</div>{data?.last_date && <button className="market-watermark" onClick={() => setSystemOpen(true)} aria-label={`行情截至 ${data.last_date}，查看数据状态`}>行情截至 <time>{data.last_date}</time></button>}<button className="research-settings" onClick={() => setSystemOpen(true)} aria-label="数据与服务"><Settings2 size={16} /><span>数据与服务</span></button></div>
      </aside>
      <main className="main-shell">
        <header className="research-header"><div className="research-breadcrumb"><span>张家港营业部</span><i>/</i><strong>{active.label}</strong></div><div className="research-header-actions"><span className="mode-badge"><span className="status-dot warning" />探索模式</span><button className="research-settings mobile-settings" onClick={() => setSystemOpen(true)} aria-label="数据与服务"><Settings2 size={16} /></button></div></header>
        {loadError && <div className="global-alert">暂时无法连接服务。可双击“启动投研工作台”恢复，或稍后重试。<button onClick={refreshStatus}>重试</button></div>}
        <section className="page-frame" key={page}>
          <Suspense fallback={<div className="page-content">正在加载页面…</div>}>
          {page === 'watchlist' && <ObservationPage data={data} />}
          {page === 'screening' && <WorkbenchPage data={data} conversationPrompt={conversationPrompt} onPromptConsumed={() => setConversationPrompt(undefined)} screeningOnly view={screeningSection} onViewChange={(section) => { if (section === 'conversation' || section === 'compose' || section === 'history') { setScreeningSection(section); if (section !== 'conversation') setConversationSource(null) } }} conversationScope={conversationScope} onConversationScopeChange={handleConversationScopeChange} conversationSource={conversationSource} onConversationSourceChange={setConversationSource} onReports={() => setPage('reports')} onCreateCondition={() => setPage('technical')} />}
          {page === 'patterns' && <PatternPage onCompose={openComposition} onDiscuss={(id, version, name) => openConversation('pattern', { reference: { kind: 'pattern', source_id: id, version }, label: name })} />}
          {(page === 'technical' || page === 'news' || page === 'reports') && <LibraryWorkspace key={page} scope={page === 'reports' ? 'report' : page} data={data} onCompose={openComposition} onConversation={openConversation} onSettings={() => setSystemOpen(true)} />}
          </Suspense>
        </section>
      </main>
      {systemOpen && <SystemDrawer data={data} onClose={() => setSystemOpen(false)} onRefresh={refreshStatus} />}
    </div>
  )
}
