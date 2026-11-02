import LoadingState from '../components/LoadingState'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import { lazy, Suspense, useState } from 'react'
import { BookOpen, Newspaper } from 'lucide-react'
import type { ConversationSourceReference, DataStatus, WorkflowType } from '../api'
import type { LibraryScope, LibrarySeed } from '../libraryContext'
import { useSessionState } from '../useSessionState'
import LibraryQuickSession, { validLibraryQuickEntries, type LibraryQuickEntry } from '../components/LibraryQuickSession'
const ReportPage = lazy(() => import('./ReportPage'))
const NewsPage = lazy(() => import('./NewsPage'))
const DisclosuresPanel = lazy(() => import('../components/DisclosuresPanel'))

type Props = {
  scope: Exclude<LibraryScope, 'technical'>; data: DataStatus | null; onCompose: () => void; onSettings: () => void
  onBrowseChange?: (tab: 'news' | 'reports') => void
  onHistoryChange?: () => void
  onConversation: (scope: LibraryScope, source?: { reference: ConversationSourceReference; label: string }, prompt?: string, workflow?: WorkflowType) => void
}

/** Read sources and work with them in local research and screening sessions. */
export default function LibraryWorkspace({ scope, data, onBrowseChange, onHistoryChange }: Props) {
  const [disclosuresOpen, setDisclosuresOpen] = useSessionState('library.disclosures-open', false, (value): value is boolean => typeof value === 'boolean')
  const [quickEntries, setQuickEntries] = useSessionState<Record<string, LibraryQuickEntry>>('library.quick-sessions', {}, validLibraryQuickEntries)
  const [openEntry, setOpenEntry] = useState('')
  const researchPrompt = '请解释当前资料的核心判断，区分事实、预测和推断，并核对支持与反方证据。'
  const screeningPrompt = '请基于这份资料整理可操作、可核对的选股条件，先形成草稿。'
  function openQuickSession(entryScope: 'news' | 'report', source: LibraryQuickEntry['source'], prompt: string, workflow: WorkflowType) {
    const key = JSON.stringify([workflow, entryScope, source.reference])
    setQuickEntries(current => current[key] ? current : { ...current, [key]: { id: crypto.randomUUID(), scope: entryScope, source, prompt, workflow } })
    setOpenEntry(key)
  }
  function fromDocument(value: Omit<LibrarySeed, 'id'> | undefined, workflow: WorkflowType) {
    if (!value?.source_document_id || !value.source_page) return
    openQuickSession('report', { reference: { kind: 'report_page', source_id: value.source_document_id, page_number: value.source_page }, label: `${value.title || '资料'} · 第${value.source_page}页` }, value.prompt || (workflow === 'research' ? researchPrompt : screeningPrompt), workflow)
  }
  function fromNews(item: { id: string; title: string }, workflow: WorkflowType) {
    openQuickSession('news', { reference: { kind: 'news_item', source_id: item.id }, label: item.title }, workflow === 'research' ? researchPrompt : screeningPrompt, workflow)
  }
  return <div className={`page-content library-shell library-redesign scope-${scope} workspace-tool-page`}>
    <WorkspacePageHeading className="library-heading" actions={null}><h1>资料库</h1></WorkspacePageHeading>
    <nav className="library-viewbar" aria-label="资料类型">
      <button className={`workspace-button${!disclosuresOpen && scope === 'news' ? ' active' : ''}`} aria-current={!disclosuresOpen && scope === 'news' ? 'page' : undefined} onClick={() => { setDisclosuresOpen(false); onBrowseChange?.('news') }}><Newspaper size={15} />资讯</button>
      <button className={`workspace-button${!disclosuresOpen && scope === 'report' ? ' active' : ''}`} aria-current={!disclosuresOpen && scope === 'report' ? 'page' : undefined} onClick={() => { setDisclosuresOpen(false); onBrowseChange?.('reports') }}><BookOpen size={15} />研报与公告</button>
      <button className={`workspace-button${disclosuresOpen ? ' active' : ''}`} aria-current={disclosuresOpen ? 'page' : undefined} onClick={() => setDisclosuresOpen(true)}>原始披露</button>
    </nav>
    <div className="library-workspace-panel is-browsing" role="region" aria-label={disclosuresOpen ? '原始披露阅读' : scope === 'report' ? '研报与公告阅读' : '资讯阅读'}>
      <Suspense fallback={<LoadingState label="正在加载资料…" skeleton />}>
        {disclosuresOpen && <DisclosuresPanel onDescribe={value => fromDocument(value, 'research')} onDefineCondition={value => fromDocument(value, 'screening')} />}
        {!disclosuresOpen && scope === 'report' && <ReportPage contentOnly onDescribe={value => fromDocument(value, 'research')} onDefineCondition={value => fromDocument(value, 'screening')} />}
        {!disclosuresOpen && scope === 'news' && <NewsPage onDiscuss={item => fromNews(item, 'research')} onDefineCondition={item => fromNews(item, 'screening')} />}
      </Suspense>
    </div>
    {Object.entries(quickEntries).map(([key, entry]) => <LibraryQuickSession key={entry.id} entry={entry} open={openEntry === key} data={data} onClose={() => setOpenEntry('')} onChange={change => setQuickEntries(current => ({ ...current, [key]: { ...current[key], ...change } }))} onHistoryChange={onHistoryChange} />)}
  </div>
}
