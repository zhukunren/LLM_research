import LoadingState from '../LoadingState'
import { useEffect, useRef, useState } from 'react'
import EmptyState from '../EmptyState'
import { ArrowLeft, ArrowUpRight, Bookmark, RefreshCw, Search } from 'lucide-react'
import { api, type ConversationScope, type SavedScreeningTask } from '../../api'
import { taskUniverseLabel } from './TaskBrief'
import SavedPlanDetails from './SavedPlanDetails'
import ConditionWorkspaceDrawer from '../ConditionWorkspaceDrawer'
import { useWorkspaceSession } from '../../WorkspaceSession'
import './saved-plan-list.css'

export default function SavedTaskLibrary({ scope, busy, onReuse, latestDate, refreshKey, embedded = false, searchQuery, onSearchQueryChange, hideToolbar = false, refreshToken = 0 }: { searchQuery?: string; onSearchQueryChange?: (query: string) => void; hideToolbar?: boolean; refreshToken?: number; scope: ConversationScope; busy: boolean; onReuse: (task: SavedScreeningTask, latest?: boolean) => void; latestDate?: string; refreshKey?: string; embedded?: boolean }) {
  const session = useWorkspaceSession()
  const [selected, setSelected] = useState<SavedScreeningTask | null>(null)
  const detailsBack = useRef<HTMLButtonElement>(null), searchInput = useRef<HTMLInputElement>(null)
  const embeddedDetailsOpen = useRef(false)
  const [items, setItems] = useState<SavedScreeningTask[]>([])
  const [localQuery, setLocalQuery] = useState('')
  const query = searchQuery ?? localQuery
  const setQuery = (value: string) => { if (searchQuery === undefined) setLocalQuery(value); onSearchQueryChange?.(value) }
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    api<{ items: SavedScreeningTask[] }>('/saved-screening-tasks?limit=200').then(result => {
      if (active) setItems(result.items)
    }).catch(reason => { if (active) setError((reason as Error).message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh, refreshKey, refreshToken])
  useEffect(() => { if (!session.active) setSelected(null) }, [session.active])
  useEffect(() => {
    if (!embedded) return
    if (selected) { embeddedDetailsOpen.current = true; detailsBack.current?.focus() }
    else if (embeddedDetailsOpen.current) { embeddedDetailsOpen.current = false; searchInput.current?.focus({ preventScroll: true }) }
  }, [embedded, selected])
  function reuse(item: SavedScreeningTask, latest: boolean) {
    if (busy || latest && !latestDate) return
    setSelected(null)
    onReuse(item, latest)
  }
  const detailsFooter = selected ? <div className="saved-plan-details-footer">
    <button type="button" className="secondary-button workspace-button" disabled={busy} onClick={() => reuse(selected, false)}>按原日期运行</button>
    <button type="button" className="primary-button workspace-button" disabled={busy || !latestDate} onClick={() => reuse(selected, true)}>按最新行情运行</button>
  </div> : null
  const reuseNote = <p className="saved-plan-reuse-note">运行后打开选股对话，保留完整逻辑与条件参数；此类方案不转换为条件组合。{latestDate ? '最新行情：' + latestDate : '最新行情日期尚未就绪，可按原日期复用。'}</p>
  if (embedded && selected) return <section className="saved-task-library saved-plan-library saved-plan-embedded-detail" aria-label="方案详情">
    <header><button ref={detailsBack} type="button" className="text-button workspace-button" onClick={() => setSelected(null)}><ArrowLeft size={14} />返回方案列表</button><h3>{selected.name}</h3></header>
    <SavedPlanDetails item={selected} /><footer>{reuseNote}{detailsFooter}</footer>
  </section>
  const scoped = items.filter(item => scope === 'screening' || item.task.conditions.every(condition => condition.library === scope || condition.library === 'ranking'))
  const filtered = scoped.filter(item => `${item.name} ${item.task.conditions.map(condition => condition.description).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <div className="saved-task-library saved-plan-library" aria-label="已保存对话方案列表" aria-busy={loading}>
    {!hideToolbar && <div className="saved-plan-toolbar"><label className="conversation-search workspace-field-shell"><Search size={14} /><input ref={searchInput} aria-label="搜索已保存方案" placeholder="搜索方案名称或条件" value={query} onChange={event => setQuery(event.target.value)} className="workspace-field" /></label><span className="saved-plan-latest-date">{latestDate ? '最新行情 ' + latestDate : '行情日期未就绪，可在详情按原日期复用'}</span><button type="button" className="icon-button workspace-button" aria-label="刷新已保存方案" disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /></button></div>}
    {loading ? <LoadingState compact label="正在读取已保存方案…" /> : error ? <div className="saved-task-empty workspace-error" role="alert"><p>{error}</p><button className="secondary-button compact workspace-button" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />重新加载</button></div> : !scoped.length ? <EmptyState compact icon={Bookmark} title="暂无已保存方案" description="完成一次对话选股后，可保存为对话方案，下次直接运行。" /> : !filtered.length ? <EmptyState compact title="没有找到匹配的方案" description="试试方案名称或其中一条条件。" actions={<button className="secondary-button workspace-button" onClick={() => setQuery('')}>清除搜索</button>} /> : <>
      <p className="saved-plan-count">{query ? `找到 ${filtered.length} 个方案` : `最近保存 · ${scoped.length} 个方案`}</p>
      <div className="saved-plan-list" role="list" aria-label="方案紧凑列表">{filtered.map(item => <article className="saved-plan-row" role="listitem" key={item.id + '@' + item.version}>
        <button type="button" className="saved-plan-open workspace-button" aria-label={'查看方案 ' + item.name + ' 详情'} onClick={() => setSelected(item)}><Bookmark size={16} aria-hidden="true" /><span><h3>{item.name}</h3><p>对话方案 · {item.task.conditions.length} 个条件 · v{item.version} · {taskUniverseLabel(item.task)}</p></span></button>
        <button type="button" className="secondary-button saved-plan-reuse workspace-button" disabled={busy || !latestDate} onClick={() => reuse(item, true)}><ArrowUpRight size={14} />按最新行情运行</button>
        <button type="button" className="text-button workspace-button" aria-label={'查看 ' + item.name + ' 详情'} onClick={() => setSelected(item)}>详情</button>
      </article>)}</div>
    </>}
    {!embedded && selected && session.active && <ConditionWorkspaceDrawer title="方案详情" description={selected.name} closeLabel="关闭方案详情" className="saved-plan-details-drawer" onClose={() => setSelected(null)} footer={detailsFooter}>
      <SavedPlanDetails item={selected} />{reuseNote}
    </ConditionWorkspaceDrawer>}
  </div>
}
