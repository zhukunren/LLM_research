import LoadingState from './components/LoadingState'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { api, conversationWorkflow, type Conversation, type ConversationScope, type ConversationSourceReference, type DataStatus, type WorkflowType } from './api'
import type { ConversationHistoryChange } from './components/ConversationHistoryItem'
import type { Section } from './pages/WorkbenchPage'
import { screeningMethodRoute, type WorkspaceRoute } from './workspaceRoute'
import type { WorkspaceSeed, WorkspaceTab } from './workspaceTabs'
import { mergeDraftSources, type ComposerDraft, type ConversationHandoff, type DraftContent, type DraftSource, type ScreeningResultLocation, type TabLocation, type WorkspaceHandoff, type WorkspaceReturn } from './workspaceHandoff'
import { useWorkspaceSession } from './WorkspaceSession'
import type { ScreeningDestination, ScreeningPatternSelection } from './screeningMethods'
import './workspace-handoff.css'

const ResearchWorkspace = lazy(() => import('./pages/ResearchWorkspace'))
const ScreeningWorkspace = lazy(() => import('./pages/ScreeningWorkspace'))

const ObservationPage = lazy(() => import('./pages/ObservationPage'))
const PatternPage = lazy(() => import('./pages/PatternPage'))
const LibraryWorkspace = lazy(() => import('./pages/LibraryWorkspace'))
const QmtScriptsPage = lazy(() => import('./pages/QmtScriptsPage'))
const IntelligencePage = lazy(() => import('./pages/IntelligencePage'))
const DailySignalsPage = lazy(() => import('./pages/DailySignalsPage'))
const EtfPeersPage = lazy(() => import('./pages/EtfPeersPage'))
const TushareDownloadPage = lazy(() => import('./pages/TushareDownloadPage'))
const ClientServicePage = lazy(() => import('./pages/ClientServicePage'))
const OpeningPlanPage = lazy(() => import('./pages/OpeningPlanPage'))
const RebalanceSuggestionPage = lazy(() => import('./pages/RebalanceSuggestionPage'))
const CelebrationPage = lazy(() => import('./pages/CelebrationPage'))

type Props = {
  tab: WorkspaceTab; data: DataStatus | null; workspace: WorkflowType
  fixedRulesOpen?: boolean
  onCloseFixedRules?: () => void
  onOpenPatternSamples?: () => void
  onUsePattern?: (destination: ScreeningDestination, pattern: ScreeningPatternSelection) => void
  incomingPattern?: ScreeningPatternSelection
  onPatternApplied?: () => void
  conversationUpdate?: { id: string } & ConversationHistoryChange
  homeDraft: string; onLegacyDraft: () => void
  onUpdate: (route: WorkspaceRoute, userNavigation?: boolean) => void
  onOpen: (route: WorkspaceRoute, seed?: WorkspaceSeed) => void
  onOpenLinked: (route: WorkspaceRoute, handoff: WorkspaceHandoff) => void
  onRestore: (target: TabLocation, change?: (current: WorkspaceHandoff) => WorkspaceHandoff) => boolean
  onChangeHandoff: (change: (current: WorkspaceHandoff) => WorkspaceHandoff) => void
  onConversation: (id: string, scope: ConversationScope, workflow?: WorkflowType, prompt?: string) => void
  onNewResearch: () => void; onSettings: () => void; onHistoryChange: () => void
}

export default function WorkspacePage({ tab, data, fixedRulesOpen, onCloseFixedRules, onOpenPatternSamples, onUsePattern, incomingPattern, onPatternApplied, workspace, conversationUpdate, homeDraft, onLegacyDraft, onUpdate, onOpen, onOpenLinked, onRestore, onChangeHandoff, onConversation, onNewResearch, onSettings, onHistoryChange }: Props) {
  const { route } = tab, { page } = route
  const session = useWorkspaceSession()
  const scope = route.scope ?? 'screening', view = route.view ?? 'conversation'
  const screeningMethod = route.screeningMethod && route.screeningMethod !== 'pattern' ? route.screeningMethod : undefined
  const [prompt, setPrompt] = useState(tab.seed?.prompt)
  const [assistant, setAssistant] = useState(tab.seed?.assistantId)
  const [source, setSource] = useState(tab.seed?.source ?? null)
  const [newResearchKey, setNewResearchKey] = useState(tab.seed?.fresh && !tab.seed.prompt ? 1 : 0)
  const [resolved, setResolved] = useState<{ id: string; scope: ConversationScope; workflow: WorkflowType } | null>(null)
  const [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const updateRef = useRef(onUpdate)
  updateRef.current = onUpdate
  const needsConversation = (page === 'screening' || page === 'conditions') && !!route.conversationId
  const ready = !needsConversation || !!resolved && resolved.id === route.conversationId && resolved.scope === scope && resolved.workflow === (page === 'conditions' ? 'screening' : 'research')

  useEffect(() => {
    if (!needsConversation || !route.conversationId || resolved?.id === route.conversationId) return
    const id = route.conversationId, controller = new AbortController()
    setError('')
    api<Conversation>(`/conversations/${encodeURIComponent(id)}`, { signal: controller.signal }).then(current => {
      if (controller.signal.aborted) return
      const workflow = conversationWorkflow(current)
      setResolved({ id, scope: current.entry_scope, workflow })
      updateRef.current({ page: workflow === 'screening' ? 'conditions' : 'screening', conversationId: id, scope: current.entry_scope, ...(workflow === 'screening' ? { view: 'conversation' as const, ...(screeningMethod ? { screeningMethod } : {}) } : {}) })
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
    return () => controller.abort()
  }, [needsConversation, route.conversationId, resolved?.id, retry])

  function location(id: string, entryScope: ConversationScope, workflow: WorkflowType) {
    if (id) setResolved({ id, scope: entryScope, workflow })
    onUpdate({ page: workflow === 'screening' ? 'conditions' : 'screening', scope: entryScope, ...(id ? { conversationId: id } : { newDraft: true }), ...(workflow === 'screening' ? { view: 'conversation' as const, ...(screeningMethod ? { screeningMethod } : {}) } : {}) })
  }
  function openConversation(entryScope: ConversationScope, entrySource?: { reference: ConversationSourceReference; label: string }, entryPrompt?: string, workflow: WorkflowType = 'research', assistantId?: string) {
    onOpen({ page: workflow === 'screening' ? 'conditions' : 'screening', scope: entryScope, newDraft: true, ...(workflow === 'screening' ? { view: 'conversation' } : {}) }, { prompt: entryPrompt, assistantId, source: entrySource, fresh: true })
  }
  const here = { id: tab.id, route }
  const reportPicker = tab.handoff?.reportPicker
  const returnTo = tab.handoff?.returnTo

  function openLinkedDraft(workflow: WorkflowType, draft: DraftContent, returnTo?: WorkspaceReturn) {
    onOpenLinked({ page: workflow === 'screening' ? 'conditions' : 'screening', newDraft: true, ...(workflow === 'screening' ? { view: 'conversation' } : {}) }, {
      transfer: { kind: 'new', draft: { prompt: draft.prompt, sources: draft.sources } }, returnTo,
    })
  }
  function pickReport(draft: ComposerDraft) {
    onOpenLinked({ page: 'library', libraryTab: 'reports', workspace }, { reportPicker: { from: here, draft } })
  }
  function returnToQuestion(source?: DraftSource) {
    if (!reportPicker) return
    const { from, draft } = reportPicker
    const addPage = source && ((current: WorkspaceHandoff): WorkspaceHandoff => {
      const previous = current.transfer
      const pending = previous?.kind === 'add' && previous.key === draft.key ? previous.draft.sources : []
      return { ...current, transfer: { kind: 'add', key: draft.key, draft: { prompt: draft.prompt, sources: mergeDraftSources(pending, [source]) } } }
    })
    if (onRestore(from, addPage)) return
    const workflow = from.route.page === 'conditions' ? 'screening' : 'research'
    openLinkedDraft(workflow, { prompt: draft.prompt, sources: source ? mergeDraftSources(draft.sources, [source]) : draft.sources }, { kind: 'report', from: here })
  }
  function useReportForScreening(source: DraftSource) {
    if (!reportPicker) return
    openLinkedDraft('screening', { prompt: reportPicker.draft.prompt, sources: mergeDraftSources(reportPicker.draft.sources, [source]) }, { kind: 'report', from: here })
  }
  function researchStock(source: DraftSource, prompt: string, result: ScreeningResultLocation) {
    openLinkedDraft('research', { prompt, sources: [source] }, { kind: 'result', from: here, result })
  }
  function goBack(destination: WorkspaceReturn) {
    if (destination.kind === 'result') {
      const { result, from } = destination
      const screeningResult = { ...result }
      if (!onRestore(from, current => ({ ...current, screeningResult }))) onOpenLinked(from.route, { screeningResult })
      return
    }
    if (onRestore(destination.from)) return
    if (destination.kind === 'question' && !destination.from.route.conversationId) openLinkedDraft('research', destination.draft)
    else onOpen(destination.from.route)
  }
  const conversationHandoff: ConversationHandoff = {
    transfer: tab.handoff?.transfer,
    onTransferApplied: transfer => onChangeHandoff(current => current.transfer === transfer ? { ...current, transfer: undefined } : current),
    pickReport,
    returnAction: returnTo && {
      label: returnTo.kind === 'result' ? `返回筛选结果 · ${returnTo.result.stockCode}` : returnTo.kind === 'report' ? '返回研报' : '返回原问题',
      onClick: () => goBack(returnTo),
    },
    screeningResult: tab.handoff?.screeningResult,
    onReleaseScreeningResult: () => onChangeHandoff(current => current.screeningResult ? { ...current, screeningResult: undefined } : current),
  }
  const compose = () => onOpen({ page: 'conditions', view: 'compose' })
  const changeScope = (entryScope: ConversationScope) => { setSource(null); onUpdate({ page, scope: entryScope, ...(page === 'conditions' ? { view: 'conversation' } : {}) }, true) }
  const loading = error ? <div className="page-content"><div role="alert" className="workspace-error"><p>{error}</p><button className="secondary-button workspace-button" onClick={() => setRetry(value => value + 1)}>重新读取对话</button></div></div> : <LoadingState label="正在读取对话…" skeleton />

  return <Suspense fallback={<LoadingState label="正在加载页面…" skeleton />}>
    {page === 'intelligence' && <IntelligencePage key={route.briefKind || 'market'} kind={route.briefKind} runId={route.briefId}
      onLocation={(briefKind, briefId) => onUpdate({ page: 'intelligence', briefKind, ...(briefId ? { briefId } : {}) }, true)}
      onResearch={(id, value) => onConversation(id, 'news', 'research', value)} onSettings={onSettings} />}
    {page === 'qmt' && <QmtScriptsPage onOpenDraft={value => openConversation('screening', undefined, value, 'research', 'qmt-script')} />}
    {page === 'daily-signals' && <DailySignalsPage />}
    {page === 'etf' && <EtfPeersPage />}
    {page === 'data-download' && <TushareDownloadPage onSettings={onSettings} />}
    {page === 'client-service' && route.serviceView === 'opening-plan' && <OpeningPlanPage />}
    {page === 'client-service' && route.serviceView === 'suggestions' && <RebalanceSuggestionPage />}
    {page === 'client-service' && route.serviceView === 'celebrations' && <CelebrationPage />}
    {page === 'client-service' && route.serviceView !== 'opening-plan' && route.serviceView !== 'suggestions' && route.serviceView !== 'celebrations' &&
      <ClientServicePage researchDraft={tab.seed?.serviceDraft} view={route.serviceView} onViewChange={serviceView => onUpdate({ ...route, serviceView }, true)} />}
    {page === 'screening' && <div className="research-space"><div className="research-space-panel research-space-panel-screening">
      {homeDraft.trim() && <div className="legacy-draft-notice"><span>还有一个之前保存的问题</span><button className="text-button workspace-button" onClick={onLegacyDraft}>继续未发送的问题</button></div>}
      {ready ? <ResearchWorkspace onServiceDraft={draft => onOpen({ page: 'client-service' }, { serviceDraft: draft })} handoff={conversationHandoff} onStartScreening={draft => openLinkedDraft('screening', draft, { kind: 'question', from: here, draft: { prompt: draft.prompt, sources: draft.sources } })} initialCommonIndicators={route.indicators === 'common'} onStartIndicatorScreening={value => openConversation('technical', undefined, value, 'screening')} conversationUpdate={conversationUpdate} initialAssistantId={assistant} shellNavigation={session.active} onHistoryChange={onHistoryChange} data={data} initialConversationId={route.conversationId} initialNewDraft={route.newDraft} newResearchKey={newResearchKey} onNewResearchConsumed={() => { setNewResearchKey(0); setAssistant(undefined) }} initialPrompt={prompt} onPromptConsumed={() => setPrompt(undefined)} initialScope={scope} onScopeChange={changeScope} initialSource={source} onSourceChange={setSource} onOpenConversation={onConversation} onLocationChange={location} /> : loading}
    </div></div>}
    {page === 'watchlist' && <ObservationPage initialRunId={route.runId} initialCode={route.observationCode} initialCandidateId={route.candidateId} initialTab={route.observationTab} onLocationChange={(observationTab, id, userNavigation = true, code) => onUpdate({ page: 'watchlist', workspace, ...(observationTab ? { observationTab } : {}), ...(id ? observationTab === 'batches' ? { runId: id, ...(code ? { observationCode: code } : {}) } : { candidateId: id } : {}) }, userNavigation)} onStartResearch={onNewResearch} data={data} onNavigateScreening={() => openConversation('screening', undefined, undefined, 'screening')} onOpenResearch={id => onConversation(id, 'screening', 'research')} />}
    {page === 'conditions' && (ready ? <ScreeningWorkspace handoff={conversationHandoff} onResearchResult={researchStock} fixedRulesOpen={fixedRulesOpen} onCloseFixedRules={onCloseFixedRules} incomingPattern={incomingPattern} onPatternApplied={onPatternApplied} screeningMethod={screeningMethod} onScreeningMethod={method => method === 'pattern' && onOpenPatternSamples ? onOpenPatternSamples() : onOpen(screeningMethodRoute(method))} onBrowseScreeningSources={kind => onOpen({ page: 'library', libraryTab: kind, workspace: 'screening' })} initialCommonIndicators={route.indicators === 'common'} conversationUpdate={conversationUpdate} onHistoryChange={onHistoryChange} shellNavigation={session.active} onOpenDataServices={onSettings} conversationId={route.conversationId} conversationNewDraft={route.newDraft} newResearchKey={newResearchKey} onNewResearchConsumed={() => setNewResearchKey(0)} conversationPrompt={prompt} onPromptConsumed={() => setPrompt(undefined)} conversationScope={scope} conversationSource={source} onConversationScopeChange={changeScope} onConversationSourceChange={setSource} onLocationChange={location} data={data} view={view} onViewChange={(section: Section) => onOpen({ page: 'conditions', view: section, scope, ...(section === 'conversation' && route.conversationId ? { conversationId: route.conversationId } : {}) })} onReports={() => onOpen({ page: 'reports', workspace })} onCompose={compose} onCreateCondition={() => onOpen({ page: 'conditions', view: 'create' })} onResumeConversation={onConversation} onConversation={openConversation} /> : loading)}
    {page === 'patterns' && <PatternPage screeningMode={route.screeningMethod === 'pattern'} onUseSample={route.screeningMethod === 'pattern' ? onUsePattern : undefined} onScreeningHistory={() => onOpen({ page: 'conditions', view: 'history' })} onCompose={compose} onDiscuss={(id, version, name) => openConversation('pattern', { reference: { kind: 'pattern', source_id: id, version }, label: name })} />}
    {(page === 'library' || page === 'news' || page === 'reports') && <LibraryWorkspace scope={page === 'reports' || route.libraryTab === 'reports' ? 'report' : 'news'} data={data} onCompose={compose} onConversation={openConversation} onSettings={onSettings}
      linkedQuestion={reportPicker && { draft: reportPicker.draft, screening: reportPicker.from.route.page === 'conditions', onReturn: () => returnToQuestion(), onUsePage: returnToQuestion, onScreening: useReportForScreening }}
      onBrowseChange={libraryTab => onUpdate({ page: 'library', libraryTab, workspace }, true)} onHistoryChange={onHistoryChange} />}
  </Suspense>
}
