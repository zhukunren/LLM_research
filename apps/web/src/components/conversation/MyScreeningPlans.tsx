import { useEffect, useState } from 'react'
import { Bookmark, RefreshCw, Search } from 'lucide-react'
import { api, type ConversationSourceReference, type SavedScreeningTask, type Strategy } from '../../api'
import ConditionWorkspaceDrawer from '../ConditionWorkspaceDrawer'
import LoadingState from '../LoadingState'
import { useWorkspaceSession } from '../../WorkspaceSession'
import './my-screening-plans.css'

export type ScreeningPlanSource = { reference: ConversationSourceReference; label: string }
export const isScreeningPlan = (source: ScreeningPlanSource | null) => source?.reference.kind === 'saved_screening_task' || source?.reference.kind === 'screening_strategy'
type Plan = { kind: 'saved_screening_task' | 'screening_strategy'; id: string; version: number; name: string; created_at: string }

export default function MyScreeningPlans({ disabled, initialOpen = false, onInitialOpenConsumed, onSelect }: {
  disabled?: boolean; initialOpen?: boolean; onInitialOpenConsumed?: () => void; onSelect: (source: ScreeningPlanSource) => void
}) {
  const session = useWorkspaceSession()
  const [open, setOpen] = useState(false)
  useEffect(() => { if (initialOpen && session.active) { setOpen(true); onInitialOpenConsumed?.() } }, [initialOpen, session.active])
  useEffect(() => { if (!session.active) setOpen(false) }, [session.active])
  return <>
    <button type="button" className="my-screening-plans-trigger workspace-button" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}><Bookmark size={15} aria-hidden="true" /><span>引用方案</span></button>
    {open && session.active && <PlanPicker disabled={disabled} onClose={() => setOpen(false)} onSelect={source => { setOpen(false); onSelect(source) }} />}
  </>
}

function PlanPicker({ disabled, onClose, onSelect }: { disabled?: boolean; onClose: () => void; onSelect: (source: ScreeningPlanSource) => void }) {
  const [plans, setPlans] = useState<Plan[]>([])
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | Plan['kind']>('all')
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<string[]>([])
  const [retry, setRetry] = useState(0)
  const [limit, setLimit] = useState(24)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setErrors([])
    void Promise.allSettled([
      api<{ items: SavedScreeningTask[] }>('/saved-screening-tasks?include_history=true&limit=200', { signal: controller.signal }),
      api<{ items: Strategy[] }>('/strategies?include_history=true', { signal: controller.signal }),
    ]).then(([tasks, strategies]) => {
      if (controller.signal.aborted) return
      const next: Plan[] = [], failed: string[] = []
      if (tasks.status === 'fulfilled' && Array.isArray(tasks.value.items)) next.push(...tasks.value.items.map(item => ({ ...item, kind: 'saved_screening_task' as const })))
      else failed.push('对话方案读取失败')
      if (strategies.status === 'fulfilled' && Array.isArray(strategies.value.items)) next.push(...strategies.value.items.map(item => ({ ...item, kind: 'screening_strategy' as const })))
      else failed.push('条件组合读取失败')
      setPlans(next.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.version - a.version)); setErrors(failed); setLoading(false)
    })
    return () => controller.abort()
  }, [retry])
  useEffect(() => setLimit(24), [query, kind])
  const filtered = plans.filter(item => (kind === 'all' || item.kind === kind) && item.name.toLowerCase().includes(query.trim().toLowerCase()))
  return <ConditionWorkspaceDrawer title="引用方案" description="选择一个版本加入对话，再决定只生成方案或执行选股。" closeLabel="关闭引用方案" className="my-screening-plans-drawer" onClose={onClose}>
    <div className="screening-plan-picker-toolbar"><label className="conversation-search workspace-field-shell"><Search size={15} aria-hidden="true" /><input className="workspace-field" aria-label="搜索可引用方案" placeholder="搜索方案名称" value={query} onChange={event => setQuery(event.target.value)} /></label><button type="button" className="icon-button workspace-button" aria-label="刷新可引用方案" disabled={loading} onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} /></button></div>
    <div className="screening-plan-picker-types" role="group" aria-label="可引用方案类型">{([{ id: 'all', name: '全部方案' }, { id: 'saved_screening_task', name: '对话方案' }, { id: 'screening_strategy', name: '条件组合' }] as const).map(item => <button type="button" className="workspace-button" key={item.id} aria-pressed={kind === item.id} onClick={() => setKind(item.id)}>{item.name}</button>)}</div>
    {errors.length > 0 && <div role="alert" className="workspace-error"><p>{errors.join('；')}，已读取的方案仍可选择。</p><button type="button" className="text-button workspace-button" onClick={() => setRetry(value => value + 1)}>重新读取方案</button></div>}
    {loading ? <LoadingState compact label="正在读取我的方案…" /> : <>
      {!filtered.length && <p className="conversation-muted">{query ? '没有找到匹配的方案。' : plans.length ? '此类型暂无已保存方案。' : errors.length ? '请重试读取方案。' : '暂无已保存方案，可先保存一次选股方案或条件组合。'}</p>}
      <div className="screening-plan-picker-list">{filtered.slice(0, limit).map(item => <article key={`${item.kind}:${item.id}:${item.version}`}><div><strong>{item.name}</strong><small>{item.kind === 'saved_screening_task' ? '对话方案' : '条件组合'} · v{item.version}</small></div><button type="button" className="secondary-button workspace-button" aria-label={`引用方案 ${item.name} 第 ${item.version} 版`} disabled={disabled} onClick={() => onSelect({ reference: { kind: item.kind, source_id: item.id, version: item.version }, label: `${item.name} · v${item.version}` })}>引用到对话</button></article>)}</div>
      {filtered.length > limit && <button type="button" className="text-button workspace-button" onClick={() => setLimit(value => value + 24)}>显示更多方案</button>}
    </>}
  </ConditionWorkspaceDrawer>
}
