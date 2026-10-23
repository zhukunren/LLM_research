import LoadingState from '../LoadingState'
import { useEffect, useState } from 'react'
import EmptyState from '../EmptyState'
import { ArrowUpRight, Bookmark, ChevronDown, RefreshCw, Search } from 'lucide-react'
import { api, type ConversationScope, type SavedScreeningTask } from '../../api'
import { TaskLogic, taskUniverseLabel } from './TaskBrief'

export default function SavedTaskLibrary({ scope, busy, onReuse, latestDate, refreshKey }: { scope: ConversationScope; busy: boolean; onReuse: (task: SavedScreeningTask, latest?: boolean) => void; latestDate?: string; refreshKey?: string }) {
  const [items, setItems] = useState<SavedScreeningTask[]>([])
  const [query, setQuery] = useState('')
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
  }, [refresh, refreshKey])
  const scoped = items.filter(item => scope === 'screening' || item.task.conditions.every(condition => condition.library === scope || condition.library === 'ranking'))
  const filtered = scoped.filter(item => `${item.name} ${item.task.conditions.map(condition => condition.description).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <div className="saved-task-library" aria-label="已保存方案列表" aria-busy={loading}>
    <label className="conversation-search workspace-field-shell"><Search size={14} /><input aria-label="搜索已保存方案" placeholder="搜索方案名称或条件" value={query} onChange={event => setQuery(event.target.value)} className="workspace-field" /></label>
    {loading ? <LoadingState compact label="正在读取已保存方案…" /> : error ? <div className="saved-task-empty workspace-error" role="alert"><p>{error}</p><button className="secondary-button compact workspace-button" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />重新加载</button></div> : !scoped.length ? <EmptyState compact icon={Bookmark} title="暂无已保存方案" description="完成一次选股后，可保存条件，下次直接复用。" /> : !filtered.length ? <EmptyState compact title="没有找到匹配的方案" description="试试方案名称或其中一条条件。" actions={<button className="secondary-button workspace-button" onClick={() => setQuery('')}>清除搜索</button>} /> : <>
      <p className="saved-task-count">{query ? `找到 ${filtered.length} 个方案` : `最近保存 · ${scoped.length} 个方案`}</p>
      <div className="saved-task-list">{filtered.map(item => <details className="saved-task-card" key={item.id}>
        <summary><Bookmark size={19} aria-hidden="true" /><span className="saved-task-title"><strong>{item.name}</strong><small>{item.task.conditions.length} 个条件 · v{item.version}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
        <div className="saved-task-body"><p>{taskUniverseLabel(item.task)}<br />截止日 {item.task.scope.as_of ?? '待确定'}</p><TaskLogic task={item.task} /></div>
        <div className="saved-task-actions">{latestDate && <button className="primary-button compact workspace-button" disabled={busy} onClick={() => onReuse(item, true)}>按最新行情复用 · {latestDate}</button>}<button className="secondary-button compact workspace-button" disabled={busy} onClick={() => onReuse(item)}><ArrowUpRight size={14} />按原日期复用</button></div>
      </details>)}</div>
    </>}
  </div>
}
