import LoadingState from '../components/LoadingState'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { BookOpen, MessageCircle, Newspaper, Upload } from 'lucide-react'
import type { ConversationSourceReference, DataStatus, WorkflowType } from '../api'
import type { LibraryScope, LibrarySeed } from '../libraryContext'
import { useSessionState } from '../useSessionState'
const ReportPage = lazy(() => import('./ReportPage'))
const NewsPage = lazy(() => import('./NewsPage'))
const DisclosuresPanel = lazy(() => import('../components/DisclosuresPanel'))

type Props = {
  scope: Exclude<LibraryScope, 'technical'>; data: DataStatus | null; onCompose: () => void; onSettings: () => void
  onBrowseChange?: (tab: 'news' | 'reports') => void
  onConversation: (scope: LibraryScope, source?: { reference: ConversationSourceReference; label: string }, prompt?: string, workflow?: WorkflowType) => void
}

/** One reading workspace; condition creation hands its source to the screening editor. */
export default function LibraryWorkspace({ scope, onConversation, onBrowseChange }: Props) {
  const [newsImportOpen, setNewsImportOpen] = useState(false)
  const [disclosuresOpen, setDisclosuresOpen] = useSessionState('library.disclosures-open', false, (value): value is boolean => typeof value === 'boolean')
  type ReadingSource = { reference: ConversationSourceReference; label: string }
  const [sourceState, setSourceState] = useState<{ scope: LibraryScope; value: ReadingSource | null } | null>(null)
  const setReadingSource = useCallback((value: ReadingSource | null) => setSourceState({ scope, value }), [scope])
  const readingSource = sourceState?.scope === scope ? sourceState.value : null
  useEffect(() => { setNewsImportOpen(false) }, [scope])
  function sourceFor(value?: Omit<LibrarySeed, 'id'> | LibrarySeed) {
    return value?.source_document_id ? { reference: { kind: 'report_page' as const, source_id: value.source_document_id, page_number: value.source_page }, label: `${value.title || '研报'} · 第${value.source_page}页` } : readingSource ?? undefined
  }
  function describe(value?: Omit<LibrarySeed, 'id'> | LibrarySeed) {
    onConversation(scope, sourceFor(value), value?.prompt || '请解释当前资料的核心判断，区分事实、预测和推断，并核对支持与反方证据。', 'research')
  }
  function defineCondition(value?: Omit<LibrarySeed, 'id'> | LibrarySeed) {
    onConversation(scope, sourceFor(value), value?.prompt || '请基于这份资料整理可操作、可核对的选股条件，先形成草稿。', 'screening')
  }
  return <div className={`page-content library-shell library-redesign scope-${scope} workspace-tool-page`}>
    <WorkspacePageHeading className="library-heading" actionsClassName="library-heading-actions" actions={<>
      {!disclosuresOpen && scope === 'news' && <button className="secondary-button workspace-button" data-tooltip="导入资讯" onClick={() => setNewsImportOpen(true)}><Upload size={15} />导入资讯</button>}
      {!disclosuresOpen && <button className="primary-button library-main-action workspace-button" data-tooltip="发起研究" onClick={() => onConversation(scope, readingSource ?? undefined, undefined, 'research')}><MessageCircle size={15} />发起研究</button>}
    </>}><h1>资料库</h1></WorkspacePageHeading>
    <nav className="library-viewbar" aria-label="资料类型">
      <button className={`workspace-button${!disclosuresOpen && scope === 'news' ? ' active' : ''}`} aria-current={!disclosuresOpen && scope === 'news' ? 'page' : undefined} onClick={() => { setDisclosuresOpen(false); onBrowseChange?.('news') }}><Newspaper size={15} />资讯</button>
      <button className={`workspace-button${!disclosuresOpen && scope === 'report' ? ' active' : ''}`} aria-current={!disclosuresOpen && scope === 'report' ? 'page' : undefined} onClick={() => { setDisclosuresOpen(false); onBrowseChange?.('reports') }}><BookOpen size={15} />研报与公告</button>
      <button className={`workspace-button${disclosuresOpen ? ' active' : ''}`} aria-current={disclosuresOpen ? 'page' : undefined} onClick={() => setDisclosuresOpen(true)}>原始披露</button>
    </nav>
    <div className="library-workspace-panel is-browsing" role="region" aria-label={disclosuresOpen ? '原始披露阅读' : scope === 'report' ? '研报与公告阅读' : '资讯阅读'}>
      <Suspense fallback={<LoadingState label="正在加载资料…" skeleton />}>
        {disclosuresOpen && <DisclosuresPanel />}
        {!disclosuresOpen && scope === 'report' && <ReportPage contentOnly onSourceChange={setReadingSource} onDescribe={describe} onDefineCondition={defineCondition} />}
        {!disclosuresOpen && scope === 'news' && <NewsPage onSourceChange={setReadingSource} importOpen={newsImportOpen} onImportClose={() => setNewsImportOpen(false)} onDiscuss={item => onConversation('news', { reference: { kind: 'news_item', source_id: item.id }, label: item.title })} />}
      </Suspense>
    </div>
  </div>
}
