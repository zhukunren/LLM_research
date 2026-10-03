import { lazy, Suspense, useState } from 'react'
import { BookOpen, FilePlus2, FolderOpen, ListFilter, MessageCircle, Upload } from 'lucide-react'
import type { ConversationSourceReference, DataStatus, Filter } from '../api'
import { libraryCopy, type LibraryScope, type LibrarySeed } from '../libraryContext'
import WorkbenchPage, { type Section } from './WorkbenchPage'
import TechnicalBrowser from './TechnicalBrowser'
import { useSessionState } from '../useSessionState'
const ReportPage = lazy(() => import('./ReportPage'))
const ReportEvaluations = lazy(() => import('./ReportEvaluations'))
const NewsPage = lazy(() => import('./NewsPage'))
type LibraryTab = 'browse' | 'create' | 'library' | 'assess'

export default function LibraryWorkspace({ scope, data, onCompose, onConversation }: { scope: LibraryScope; data: DataStatus | null; onCompose: () => void; onConversation: (scope: LibraryScope, source?: { reference: ConversationSourceReference; label: string }, prompt?: string) => void; onSettings: () => void }) {
  const copy = libraryCopy[scope]
  const [tab, setTab] = useSessionState<'browse' | 'create' | 'library' | 'assess'>(`library.${scope}.tab`, 'browse', (value): value is 'browse' | 'create' | 'library' | 'assess' => ['browse', 'create', 'library', ...(scope === 'report' ? ['assess'] : [])].includes(String(value)))
  const [seed, setSeed] = useState<LibrarySeed>()
  const [newsImportOpen, setNewsImportOpen] = useState(false)
  const [evaluationFilter, setEvaluationFilter] = useState<Filter>()
  function describe(value?: Omit<LibrarySeed, 'id'> | LibrarySeed) { onConversation(scope, value?.source_document_id ? { reference: { kind: 'report_page', source_id: value.source_document_id, page_number: value.source_page }, label: `${value.title || '研报'} · 第${value.source_page}页` } : undefined, value?.prompt || '我想基于这页研报整理选股条件，请先说明有哪些可以核对的事实。') }
  function changeView(section: Section) { if (section === 'create' || section === 'library') setTab(section); else onCompose() }
  const tabs: { id: LibraryTab; label: string; icon: typeof BookOpen }[] = [
    { id: 'browse', label: copy.browse, icon: BookOpen },
    { id: 'library', label: '独立条件库', icon: FolderOpen },
    { id: 'create', label: '创建条件', icon: FilePlus2 },
    ...(scope === 'report' ? [{ id: 'assess' as const, label: '研报评估', icon: ListFilter }] : []),
  ]
  return <div className={`page-content library-shell scope-${scope}`}>
    <div className="library-heading"><div className="library-title"><span className="workspace-eyebrow">研究资料</span><h1>{copy.title}</h1></div><div className="library-heading-actions">{scope === 'news' && <button className="secondary-button" onClick={() => { setTab('browse'); setNewsImportOpen(true) }}><Upload size={15} />导入资讯</button>}<button className="primary-button" onClick={() => onConversation(scope)}><MessageCircle size={15} />发起研究</button></div></div>
    <nav className="library-tabs" role="tablist" aria-label={`${copy.title}功能`} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = tabs.findIndex(item => item.id === tab)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      setTab(tabs[index].id)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
    }}>
      {tabs.map(({ id, label, icon: Icon }) => <button key={id} id={`library-${scope}-${id}`} role="tab" aria-selected={tab === id} aria-controls={`library-${scope}-panel`} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={15} />{label}</button>)}
    </nav>
    <div id={`library-${scope}-panel`} role="tabpanel" aria-labelledby={`library-${scope}-${tab}`}>
    <Suspense fallback={<div className="workbench-help">正在加载资料…</div>}>
      {tab === 'browse' && scope === 'technical' && <TechnicalBrowser data={data} onDescribe={describe} />}
      {tab === 'browse' && scope === 'report' && <ReportPage contentOnly onDescribe={describe} />}
      {tab === 'browse' && scope === 'news' && <NewsPage importOpen={newsImportOpen} onImportClose={() => setNewsImportOpen(false)} onDiscuss={item => onConversation('news', { reference: { kind: 'news_item', source_id: item.id }, label: item.title })} />}
      {(tab === 'create' || tab === 'library') && <WorkbenchPage key={scope} scope={scope} view={tab} seed={seed} onSeedConsumed={() => setSeed(undefined)} onViewChange={changeView} data={data} onCompose={onCompose} onConversation={onConversation} onReports={filter => { setEvaluationFilter(filter); setTab('assess') }} />}
      {tab === 'assess' && scope === 'report' && <ReportEvaluations selected={evaluationFilter} />}
    </Suspense>
    </div>
  </div>
}
