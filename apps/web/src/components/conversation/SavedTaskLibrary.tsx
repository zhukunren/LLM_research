import { useEffect, useState } from 'react'
import { ArrowUpRight, Bookmark, RefreshCw, Search } from 'lucide-react'
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
    <label className="conversation-search"><Search size={14} /><input aria-label="搜索已保存方案" placeholder="搜索方案名称或条件" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {loading ? <p className="conversation-muted" role="status">正在读取已保存方案…</p> : error ? <div className="saved-task-empty" role="alert"><p>{error}</p><button className="secondary-button compact" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />重新加载</button></div> : !scoped.length ? <div className="saved-task-empty"><Bookmark size={22} /><strong>把好用的条件留下来</strong><p>核对右侧任务后点击“保存方案”，下次可直接复用。</p></div> : !filtered.length ? <div className="saved-task-empty"><p>没有找到匹配的方案</p><button className="text-button" onClick={() => setQuery('')}>清除搜索</button></div> : <>
      <p className="saved-task-count">{query ? `找到 ${filtered.length} 个方案` : `最近保存 · ${scoped.length} 个方案`}</p>
      <div className="saved-task-list">{filtered.map(item => <details className="saved-task-card" key={item.id}>
        <summary><strong>{item.name}</strong><span>{item.task.conditions.length} 个条件 · v{item.version}</span></summary>
        <p>{taskUniverseLabel(item.task)}<br />截止日 {item.task.scope.as_of ?? '待确定'}</p>
        <TaskLogic task={item.task} />
        {latestDate && <button className="primary-button compact" disabled={busy} onClick={() => onReuse(item, true)}>按最新行情复用 · {latestDate}</button>}<button className="secondary-button compact" disabled={busy} onClick={() => onReuse(item)}><ArrowUpRight size={14} />按原日期复用</button>
      </details>)}</div>
    </>}
  </div>
}
