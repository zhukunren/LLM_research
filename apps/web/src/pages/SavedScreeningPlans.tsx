import { StockText } from '../components/StockMentions'
import { useEffect, useRef, useState } from 'react'
import { api, type Conversation, type ConversationScope, type DataStatus, type SavedScreeningTask, type Strategy, type WorkflowType } from '../api'
import SavedTaskLibrary from '../components/conversation/SavedTaskLibrary'
import { readModelPreference } from '../modelSelection'
import { Library, Plus, RefreshCw, Search, X } from 'lucide-react'
import CompositionPlanList from '../components/CompositionPlanList'
import './scheme-center.css'
import { useWorkspaceSession } from '../WorkspaceSession'

export default function SavedScreeningPlans({ data, onOpenConversation, strategies = [], loading = false, compositionError, onRefreshCompositions, onOpenComposition, onNewComposition, onOpenConditionLibrary, onContinueComposition, compositionDraft, externalBusy = false }: {
  data?: DataStatus | null
  externalBusy?: boolean
  strategies?: Strategy[]
  onContinueComposition?: () => void
  compositionDraft?: { name: string; conditionCount: number; saved: boolean; version?: number }
  loading?: boolean
  compositionError?: string
  onRefreshCompositions?: () => void
  onOpenComposition?: (key: string) => void
  onNewComposition?: () => void
  onOpenConditionLibrary?: () => void
  onOpenConversation?: (id: string, scope: ConversationScope, workflow?: WorkflowType) => void
}) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | 'composition' | 'conversation'>('all')
  const [refresh, setRefresh] = useState(0)
  const [reuseBusy, setBusy] = useState(false)
  const busy = externalBusy || reuseBusy
  const session = useWorkspaceSession()
  const sessionState = useRef({ id: session.id, active: session.active, generation: 0 })
  if (sessionState.current.active !== session.active || sessionState.current.id !== session.id) sessionState.current = { id: session.id, active: session.active, generation: sessionState.current.generation + 1 }
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const attempt = useRef<{ key: string; requestId: string; messageKey: string; conversation?: Conversation; messageId?: string } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function reuse(saved: SavedScreeningTask, latest = false) {
    if (inFlight.current || externalBusy || !session.active) return
    const generation = sessionState.current.generation
    if (latest && !data?.last_date) { setError('最新行情日期尚未就绪，可稍后重试或在详情中按原日期复用。'); return }
    const asOf = latest ? data?.last_date : undefined
    const key = JSON.stringify([saved.id, saved.version, asOf])
    if (attempt.current?.key !== key) attempt.current = { key, requestId: crypto.randomUUID(), messageKey: crypto.randomUUID() }
    const currentAttempt = attempt.current
    inFlight.current = true; setBusy(true); setError('')
    try {
      if (!currentAttempt.conversation) currentAttempt.conversation = await api<Conversation>('/conversations', {
        method: 'POST', body: JSON.stringify({ request_id: currentAttempt.requestId, entry_scope: 'screening', workflow_type: 'screening', ...readModelPreference() }),
      })
      const conversation = currentAttempt.conversation
      if (!currentAttempt.messageId) {
        const message = await api<{ message_id: string }>(`/conversations/${conversation.id}/messages`, {
          method: 'POST', body: JSON.stringify({ client_message_id: currentAttempt.messageKey, base_revision: 0,
            content: `复用已保存方案“${saved.name}”（第${saved.version}版）${asOf ? `，采用${asOf}的行情` : '，保留原截止日'}` }),
        })
        currentAttempt.messageId = message.message_id
      }
      await api(`/conversations/${conversation.id}/saved-screening-tasks/${saved.id}/reuse`, {
        method: 'POST', body: JSON.stringify({ base_revision: 0, source_message_id: currentAttempt.messageId, version: saved.version, ...(asOf ? { as_of: asOf } : {}) }),
      })
      if (mounted.current && sessionState.current.active && sessionState.current.generation === generation) onOpenConversation?.(conversation.id, 'screening', 'screening')
      attempt.current = null
    } catch (reason) { if (mounted.current) setError(`复用未完成：${(reason as Error).message} 可以再次点击复用以继续。`) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  return <StockText><section className="scheme-center saved-screening-page" aria-label="我的筛选方案">
    <header className="scheme-center-heading"><div><h1>我的筛选方案</h1><p className="page-description">打开条件组合继续编辑，或直接运行已保存的对话方案。历史运行结果保持原样。</p></div><div className="scheme-center-actions">{onOpenConditionLibrary && <button type="button" className="secondary-button workspace-button" disabled={busy} onClick={onOpenConditionLibrary}><Library size={15} />管理条件库</button>}{onNewComposition && <button type="button" className="primary-button workspace-button" disabled={busy} onClick={onNewComposition}><Plus size={15} />新建条件组合</button>}</div></header>
    {compositionDraft && onContinueComposition && <section className="scheme-current-draft" aria-label="当前组合草稿"><div><strong>{compositionDraft.name}</strong><p>{compositionDraft.conditionCount} 个条件 · {compositionDraft.saved ? `已保存${compositionDraft.version ? ` v${compositionDraft.version}` : ''}` : '当前草稿，尚未保存为方案版本'}</p></div><button type="button" className="secondary-button workspace-button" disabled={busy} onClick={onContinueComposition}>{compositionDraft.saved ? '打开当前方案' : '继续编辑草稿'}</button></section>}
    <div className="saved-plan-toolbar scheme-center-toolbar"><label className="conversation-search workspace-field-shell"><Search size={16} /><input aria-label="搜索全部筛选方案" placeholder="搜索方案名称或对话方案中的条件" value={query} onChange={event => setQuery(event.target.value)} className="workspace-field" />{query && <button type="button" className="icon-button workspace-button" aria-label="清除方案搜索" onClick={() => setQuery('')}><X size={14} /></button>}</label><button type="button" className="icon-button workspace-button" aria-label="刷新方案来源" disabled={busy || loading} onClick={() => { setRefresh(value => value + 1); onRefreshCompositions?.() }}><RefreshCw size={16} /></button></div>
    <nav className="scheme-center-types" aria-label="方案类型">{([{ key: 'all', label: '全部方案' }, { key: 'composition', label: '条件组合' }, { key: 'conversation', label: '对话方案' }] as const).map(item => <button type="button" key={item.key} className="workspace-button" aria-pressed={kind === item.key} onClick={() => setKind(item.key)}>{item.label}</button>)}</nav>
    {error && <p className="research-error workspace-error" role="alert">{error}</p>}
    <div className="scheme-center-results">
      <section className="scheme-center-source" aria-label="条件组合" hidden={kind === 'conversation'}><h2>条件组合</h2><p className="scheme-source-note">固定条件版本与嵌套逻辑；打开编辑不会开始筛选。</p><CompositionPlanList strategies={strategies} query={query} loading={loading} error={compositionError} disabled={busy} onOpen={onOpenComposition} onCreate={onNewComposition} onRefresh={onRefreshCompositions} /></section>
      <section className="scheme-center-source" aria-label="对话方案" hidden={kind === 'composition'}><h2>对话方案</h2><p className="scheme-source-note">保留对话生成的完整方案；先查看详情，再按原日期或最新行情运行。不转换为条件组合。</p><SavedTaskLibrary scope="screening" busy={busy} latestDate={data?.last_date} onReuse={(saved, latest) => void reuse(saved, latest)} searchQuery={query} onSearchQueryChange={setQuery} hideToolbar refreshToken={refresh} /></section>
    </div>
  </section></StockText>
}
