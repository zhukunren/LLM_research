import { useMemo, useState } from 'react'
import { Check, FolderOpen, Search } from 'lucide-react'
import type { Strategy } from '../api'
import { countConditions } from '../screeningWorkflow'
import type { Node } from '../pages/StrategyPage'
import ConditionWorkspaceDrawer from './ConditionWorkspaceDrawer'

export default function CompositionPicker({ strategies, currentId, currentVersion, disabled, onSelect }: {
  strategies: Strategy[]; currentId: string; currentVersion?: number; disabled: boolean; onSelect: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const byId = new Map<string, Strategy[]>()
    strategies.forEach(item => byId.set(item.id, [...(byId.get(item.id) ?? []), item]))
    return [...byId.values()].map(items => items.sort((a, b) => b.version - a.version))
      .filter(items => items.some(item => item.name.toLowerCase().includes(query.trim().toLowerCase())))
      .sort((a, b) => b[0].created_at.localeCompare(a[0].created_at))
  }, [strategies, query])
  function choose(item: Strategy) { onSelect(`${item.id}@${item.version}`); setOpen(false) }
  const versionButton = (item: Strategy) => <button type="button" key={item.version} className="workspace-button composition-picker-item" disabled={disabled} aria-label={`载入 ${item.name} 第 ${item.version} 版`} onClick={() => choose(item)}>
    <span><strong>{item.name}</strong><small>{countConditions(item.tree as Node)} 项条件 · v{item.version} · {item.created_at.slice(0, 10)}</small></span>
    {item.id === currentId && item.version === currentVersion && <Check size={16} aria-label="当前版本" />}
  </button>
  return <>
    <button type="button" className="secondary-button workspace-button" disabled={disabled} aria-expanded={open} onClick={() => { setQuery(''); setOpen(true) }}><FolderOpen size={15} />切换组合</button>
    {open && <ConditionWorkspaceDrawer title="选择组合" closeLabel="关闭组合选择" className="composition-picker-drawer" onClose={() => setOpen(false)}>
      <label className="composition-picker-search workspace-field-label"><Search size={16} /><input aria-label="搜索已保存组合" placeholder="搜索组合名称" value={query} onChange={event => setQuery(event.target.value)} className="workspace-field" /></label>
      <div className="composition-picker-list">{groups.map(([latest, ...history]) => <article key={latest.id}>
        {versionButton(latest)}
        {!!history.length && <details><summary>历史版本 · {history.length}</summary>{history.map(versionButton)}</details>}
      </article>)}</div>
      {!groups.length && <p className="composition-picker-empty">{query ? '没有找到匹配的组合。' : '还没有保存的组合。编辑后可在底部保存。'}</p>}
    </ConditionWorkspaceDrawer>}
  </>
}
