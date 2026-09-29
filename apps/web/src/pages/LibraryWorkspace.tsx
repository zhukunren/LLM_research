import { lazy, Suspense, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import type { ConversationSourceReference, DataStatus, Filter } from '../api'
import { libraryCopy, type LibraryScope, type LibrarySeed } from '../libraryContext'
import WorkbenchPage, { type Section } from './WorkbenchPage'
import TechnicalBrowser from './TechnicalBrowser'
import { useSessionState } from '../useSessionState'
const ReportPage = lazy(() => import('./ReportPage'))
const ReportEvaluations = lazy(() => import('./ReportEvaluations'))
const NewsPage = lazy(() => import('./NewsPage'))

export default function LibraryWorkspace({ scope, data, onCompose, onConversation }: { scope: LibraryScope; data: DataStatus | null; onCompose: () => void; onConversation: (scope: LibraryScope, source?: { reference: ConversationSourceReference; label: string }, prompt?: string) => void; onSettings: () => void }) {
  const copy = libraryCopy[scope]
  const [tab, setTab] = useSessionState<'browse' | 'create' | 'library' | 'assess'>(`library.${scope}.tab`, 'browse', (value): value is 'browse' | 'create' | 'library' | 'assess' => ['browse', 'create', 'library', ...(scope === 'report' ? ['assess'] : [])].includes(String(value)))
  const [seed, setSeed] = useState<LibrarySeed>()
  const [newsImportOpen, setNewsImportOpen] = useState(false)
  const [evaluationFilter, setEvaluationFilter] = useState<Filter>()
  function describe(value?: Omit<LibrarySeed, 'id'> | LibrarySeed) { onConversation(scope, value?.source_document_id ? { reference: { kind: 'report_page', source_id: value.source_document_id, page_number: value.source_page }, label: `${value.title || '研报'} · 第${value.source_page}页` } : undefined, value?.prompt || '我想基于这页研报整理选股条件，请先说明有哪些可以核对的事实。') }
  function changeView(section: Section) { if (section === 'create' || section === 'library') setTab(section); else onCompose() }
  return <div className={`page-content library-shell scope-${scope}`}>
    <div className="library-heading"><div className="library-title"><h1>{copy.title}</h1></div><div className="library-heading-actions">{scope === 'news' && <button className="secondary-button" onClick={() => { setTab('browse'); setNewsImportOpen(true) }}>导入</button>}<button className="quiet-button" onClick={() => onConversation(scope)}><MessageCircle size={14} />对话筛选</button></div></div>
    <p className="library-intro">{copy.intro}</p>
    <nav className="library-tabs" aria-label={`${copy.title}功能`}>
      <button className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>{copy.browse}</button>
      <button onClick={() => onConversation(scope)}>描述需求</button><button className={tab === 'create' ? 'active' : ''} onClick={() => setTab('create')}>创建独立条件（高级）</button>
      <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>独立条件库</button>
      {scope === 'report' && <button className={tab === 'assess' ? 'active' : ''} onClick={() => setTab('assess')}>独立研报评估</button>}
    </nav>
    <Suspense fallback={<div className="workbench-help">正在加载资料…</div>}>
      {tab === 'browse' && scope === 'technical' && <TechnicalBrowser data={data} onDescribe={describe} />}
      {tab === 'browse' && scope === 'report' && <ReportPage contentOnly onDescribe={describe} />}
      {tab === 'browse' && scope === 'news' && <NewsPage importOpen={newsImportOpen} onImportClose={() => setNewsImportOpen(false)} onDiscuss={item => onConversation('news', { reference: { kind: 'news_item', source_id: item.id }, label: item.title })} />}
      {(tab === 'create' || tab === 'library') && <WorkbenchPage key={scope} scope={scope} view={tab} seed={seed} onSeedConsumed={() => setSeed(undefined)} onViewChange={changeView} data={data} onCompose={onCompose} onConversation={onConversation} onReports={filter => { setEvaluationFilter(filter); setTab('assess') }} />}
      {tab === 'assess' && scope === 'report' && <ReportEvaluations selected={evaluationFilter} />}
    </Suspense>
  </div>
}
