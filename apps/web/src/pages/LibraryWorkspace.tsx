import { lazy, Suspense, useState } from 'react'
import { BookOpen, FilePlus2, FolderOpen, ListFilter, MessageCircle, MoreHorizontal, Upload } from 'lucide-react'
import type { ConversationSourceReference, DataStatus, Filter, WorkflowType } from '../api'
import { libraryCopy, type LibraryScope, type LibrarySeed } from '../libraryContext'
import WorkbenchPage, { type Section } from './WorkbenchPage'
import TechnicalBrowser from './TechnicalBrowser'
import { useSessionState } from '../useSessionState'
const ReportPage = lazy(() => import('./ReportPage'))
const ReportEvaluations = lazy(() => import('./ReportEvaluations'))
const NewsPage = lazy(() => import('./NewsPage'))
type LibraryTab = 'browse' | 'create' | 'library' | 'assess'

export default function LibraryWorkspace({ scope, data, onCompose, onConversation }: { scope: LibraryScope; data: DataStatus | null; onCompose: () => void; onConversation: (scope: LibraryScope, source?: { reference: ConversationSourceReference; label: string }, prompt?: string, workflow?: WorkflowType) => void; onSettings: () => void }) {
  const copy = libraryCopy[scope]
  const [tab, setTab] = useSessionState<'browse' | 'create' | 'library' | 'assess'>(`library.${scope}.tab`, 'browse', (value): value is 'browse' | 'create' | 'library' | 'assess' => ['browse', 'create', 'library', ...(scope === 'report' ? ['assess'] : [])].includes(String(value)))
  const [seed, setSeed] = useState<LibrarySeed>()
  const [moreOpen, setMoreOpen] = useState(false)
  const [newsImportOpen, setNewsImportOpen] = useState(false)
  const [evaluationFilter, setEvaluationFilter] = useState<Filter>()
  const [advancedOpen, setAdvancedOpen] = useState(tab !== 'browse')
  function sourceFor(value?: Omit<LibrarySeed, 'id'> | LibrarySeed) { return value?.source_document_id ? { reference: { kind: 'report_page' as const, source_id: value.source_document_id, page_number: value.source_page }, label: `${value.title || '研报'} · 第${value.source_page}页` } : undefined }
  function describe(value?: Omit<LibrarySeed, 'id'> | LibrarySeed) { onConversation(scope, sourceFor(value), value?.prompt || (scope === 'report' ? '请解释这页研报的核心判断，区分事实、预测和推断，并核对支持与反方证据。' : '请解释当前资料与计算口径，核对变化、证据和局限。'), 'research') }
  function defineCondition(value?: Omit<LibrarySeed, 'id'> | LibrarySeed) { onConversation(scope, sourceFor(value), value?.prompt || '请基于这份资料整理可操作、可核对的选股条件，先形成草稿。', 'screening') }
  function changeView(section: Section) { if (section === 'create' || section === 'library') { setAdvancedOpen(true); setTab(section) } else onCompose() }
  const tabs: { id: LibraryTab; label: string; icon: typeof BookOpen }[] = [
    { id: 'browse', label: copy.browse, icon: BookOpen },
    { id: 'library', label: '独立条件库', icon: FolderOpen },
    { id: 'create', label: '创建条件', icon: FilePlus2 },
    ...(scope === 'report' ? [{ id: 'assess' as const, label: '研报评估', icon: ListFilter }] : []),
  ]
  const visibleTabs = advancedOpen ? tabs : tabs.filter(item => item.id === 'browse')
  function toggleAdvanced() {
    if (advancedOpen && tab !== 'browse') setTab('browse')
    setAdvancedOpen(value => !value)
  }
  return <div className={`page-content library-shell library-redesign scope-${scope}`}>
    <div className="library-heading"><div className="library-title"><h1>{copy.title}</h1></div><div className={`library-heading-actions ${moreOpen ? 'library-actions-expanded' : ''}`}>{scope === 'news' && <button className="secondary-button" onClick={() => { setTab('browse'); setNewsImportOpen(true) }}><Upload size={15} />导入资讯</button>}{advancedOpen && scope !== 'report' && <button className="secondary-button" onClick={() => defineCondition()}>定义选股条件</button>}<button className="secondary-button library-main-action" onClick={() => onConversation(scope, undefined, undefined, 'research')}><MessageCircle size={15} />发起研究</button><button type="button" className="secondary-button library-more-action" aria-label="更多资料操作" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}><MoreHorizontal size={17} />更多</button></div></div>
    <div className="library-tool-actions"><button type="button" className="text-button" aria-expanded={advancedOpen} aria-controls={`library-${scope}-tools`} onClick={toggleAdvanced}>{advancedOpen ? '收起高级工具' : '选股与条件工具'}</button></div>
    <label className="library-mobile-tools">当前视图<select aria-label="资料库视图" value={tab} onChange={event => setTab(event.target.value as LibraryTab)}>{visibleTabs.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    <nav id={`library-${scope}-tools`} className="library-viewbar" role="tablist" aria-label={`${copy.title}功能`} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = visibleTabs.findIndex(item => item.id === tab)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? visibleTabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length
      setTab(visibleTabs[index].id)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
    }}>
      {visibleTabs.map(({ id, label, icon: Icon }, index) => <span key={id} className={id === 'browse' ? 'library-primary-tab' : 'library-tool-tab'}>{index === 1 && <span className="library-tools-label">条件工具</span>}<button id={`library-${scope}-${id}`} role="tab" aria-selected={tab === id} aria-controls={`library-${scope}-panel`} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={15} />{label}</button></span>)}
    </nav>
    <div className={`library-workspace-panel ${tab === 'browse' ? 'is-browsing' : 'is-tool'}`} id={`library-${scope}-panel`} role="tabpanel" aria-labelledby={`library-${scope}-${tab}`}>
    <Suspense fallback={<div className="library-panel-loading" role="status">正在加载资料…</div>}>
      {tab === 'browse' && scope === 'technical' && <TechnicalBrowser data={data} onDescribe={defineCondition} />}
      {tab === 'browse' && scope === 'report' && <ReportPage contentOnly onDescribe={describe} onDefineCondition={defineCondition} />}
      {tab === 'browse' && scope === 'news' && <NewsPage importOpen={newsImportOpen} onImportClose={() => setNewsImportOpen(false)} onDiscuss={item => onConversation('news', { reference: { kind: 'news_item', source_id: item.id }, label: item.title })} />}
      {(tab === 'create' || tab === 'library') && <WorkbenchPage key={scope} scope={scope} view={tab} seed={seed} onSeedConsumed={() => setSeed(undefined)} onViewChange={changeView} data={data} onCompose={onCompose} onConversation={onConversation} onReports={filter => { setEvaluationFilter(filter); setTab('assess') }} />}
      {tab === 'assess' && scope === 'report' && <ReportEvaluations selected={evaluationFilter} />}
    </Suspense>
    </div>
  </div>
}
