import { useMemo } from 'react'
import { GitBranch } from 'lucide-react'
import type { Strategy } from '../api'
import type { Node } from '../pages/StrategyPage'
import { countConditions } from '../screeningWorkflow'
import EmptyState from './EmptyState'
import LoadingState from './LoadingState'

/** Discover versioned compositions without converting them to conversation tasks. */
export default function CompositionPlanList({ strategies, query, loading = false, error, disabled = false, onOpen, onCreate, onRefresh }: {
  strategies: Strategy[]; query: string; loading?: boolean; error?: string; disabled?: boolean
  onOpen?: (key: string) => void; onCreate?: () => void; onRefresh?: () => void
}) {
  const groups = useMemo(() => {
    const byId = new Map<string, Strategy[]>()
    strategies.forEach(item => byId.set(item.id, [...(byId.get(item.id) ?? []), item]))
    return [...byId.values()].map(items => items.sort((a, b) => b.version - a.version))
      .filter(items => items.some(item => item.name.toLowerCase().includes(query.trim().toLowerCase())))
      .sort((a, b) => b[0].created_at.localeCompare(a[0].created_at))
  }, [strategies, query])
  const metadata = (item: Strategy) => `条件组合 · ${countConditions(item.tree as Node)} 个条件 · v${item.version} · 保存于 ${item.created_at.slice(0, 10)}`
  return <div className="composition-plan-list" aria-label="已保存条件组合列表" aria-busy={loading}>
    {error && <div className="workspace-error" role="alert"><p>条件组合未能更新：{error}</p>{onRefresh && <button className="text-button workspace-button" onClick={onRefresh} disabled={loading || disabled}>重试读取组合</button>}</div>}
    {loading && <LoadingState compact label="正在读取条件组合…" />}
    {!loading && !error && !groups.length && <EmptyState compact icon={GitBranch} title={query ? '没有匹配的条件组合' : '暂无已保存的条件组合'} description={query ? '试试其他名称，或切换方案类型。' : '新建组合，添加条件并核对逻辑后保存。'} actions={!query && onCreate ? <button className="secondary-button workspace-button" disabled={disabled} onClick={onCreate}>新建条件组合</button> : undefined} />}
    {groups.map(([latest, ...history]) => <article key={latest.id} className="composition-plan-entry">
      <div className="saved-plan-row">
        <button type="button" className="saved-plan-open workspace-button" disabled={disabled || !onOpen} aria-label={`打开编辑 ${latest.name} 第 ${latest.version} 版`} onClick={() => onOpen?.(`${latest.id}@${latest.version}`)}><GitBranch size={16} aria-hidden="true" /><span><h3>{latest.name}</h3><p>{metadata(latest)}</p></span></button>
        <button type="button" className="secondary-button saved-plan-reuse workspace-button" disabled={disabled || !onOpen} onClick={() => onOpen?.(`${latest.id}@${latest.version}`)}>打开编辑</button>
      </div>
      {!!history.length && <details className="composition-plan-history"><summary>历史版本 · {history.length}</summary>{history.map(item => <button key={item.version} type="button" className="composition-plan-version workspace-button" disabled={disabled || !onOpen} aria-label={`打开编辑 ${item.name} 第 ${item.version} 版`} onClick={() => onOpen?.(`${item.id}@${item.version}`)}><span>{item.name} · v{item.version} · {item.created_at.slice(0, 10)}</span><span>打开编辑</span></button>)}</details>}
    </article>)}
  </div>
}
