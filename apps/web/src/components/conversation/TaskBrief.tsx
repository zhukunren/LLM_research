import { StockText } from '../StockMentions'
import { Trash2 } from 'lucide-react'
import { useId } from 'react'
import type { ScreeningTaskRevision } from '../../api'

const libraryLabels: Record<string, string> = { technical: '行情', report: '研报', news: '资讯', pattern: '形态', ranking: '排名' }
const parameterLabels: Record<string, string> = { window: '周期', period: '周期', threshold: '阈值', limit: '下限', direction: '方向', operator: '比较方式' }

export function taskUniverseLabel(task: ScreeningTaskRevision) {
  const universe = task.scope.universe
  if (!universe) return '待确定股票范围'
  if (universe.kind === 'all_a_shares') return '全部 A 股'
  if (universe.kind === 'watchlist') return '自选股票池'
  return `指定证券 · ${universe.stock_codes.length} 只`
}

export type CompositionEdit = { logic_mode?: 'all' | 'any'; remove_reference_id?: string }

function logicContainsReference(node: unknown, referenceId: string): boolean {
  if (!node || typeof node !== 'object') return false
  const value = node as Record<string, unknown>
  if (value.op === 'condition') return value.reference_id === referenceId
  return Array.isArray(value.children) && value.children.some(child => logicContainsReference(child, referenceId))
}

function ConditionRow({ task, referenceId, disabled, onRemove }: {
  task: ScreeningTaskRevision
  referenceId: string
  disabled?: boolean
  onRemove?: (referenceId: string) => void
}) {
  const reference = task.references.find(item => item.reference_id === referenceId)
  const condition = task.conditions.find(item => item.condition_id === reference?.condition_id)
  if (!condition) return <StockText><p className="conversation-muted">条件待补充</p></StockText>
  const overrides = reference?.parameter_overrides ?? {}
  const protectedReference = condition.library === 'ranking'
    || task.scope.ranking?.metric_reference_id === referenceId
    || logicContainsReference(task.scope.ranking?.population_logic_tree, referenceId)
  const removeDisabled = disabled || task.references.length <= 1 || protectedReference
  const removeReason = protectedReference ? '排名计算依赖此条件' : task.references.length <= 1 ? '至少保留一条筛选条件' : '移除条件'
  return <StockText><article className="task-logic-condition">
    <span className="task-library-label">{libraryLabels[condition.library] ?? '条件'}</span>
    <span className="task-execution-rule"><small>{Object.keys(overrides).length ? '计算方法' : '实际筛选规则'}</small><strong>{condition.description}</strong>{!!Object.keys(condition.program?.parameters ?? {}).length && <small>计算参数：{Object.entries({ ...condition.program?.parameters, ...overrides }).map(([key, value]) => `${condition.program?.parameter_specs?.[key]?.label || key} ${String(value)}`).join('；')}</small>}</span>
    {(reference?.source_quote || condition.source_quote) !== condition.description && <p className="task-source-quote">你的要求：{reference?.source_quote || condition.source_quote}</p>}
    {!!Object.keys(overrides).length && <small>本次采用的参数：{Object.entries(overrides).map(([key, value]) => `${condition.program?.parameter_specs?.[key]?.label ?? parameterLabels[key] ?? key} ${String(value)}`).join('；')}</small>}
    {onRemove && <button type="button" className="icon-button task-composition-remove workspace-button" disabled={removeDisabled} data-tooltip={removeReason} aria-label={`${removeDisabled ? `无法移除，${removeReason}` : '移除条件'}：${condition.description}`} onClick={() => onRemove(referenceId)}><Trash2 size={15} aria-hidden="true" /></button>}
  </article></StockText>
}

export function TaskLogic({ task, node = task.logic_tree, onRemoveReference, disabled }: {
  task: ScreeningTaskRevision
  node?: Record<string, unknown> | null
  onRemoveReference?: (referenceId: string) => void
  disabled?: boolean
}) {
  if (!node) return <StockText><p className="conversation-muted">组合关系待确认</p></StockText>
  if (node.op === 'condition') {
    return <ConditionRow task={task} referenceId={String(node.reference_id)} disabled={disabled} onRemove={onRemoveReference} />
  }
  const children = Array.isArray(node.children) ? node.children as Record<string, unknown>[] : []
  const label = ({ all: '同时满足', any: '满足任一', not: '排除以下情况' } as Record<string, string>)[String(node.op)]
  return <StockText><div className={`task-logic-group ${node.op === 'not' ? 'is-exclusion' : ''}`}>
    <span className="task-logic-label">{label ?? '组合关系待确认'}</span>
    <div>{children.map((child, index) => <TaskLogic key={index} task={task} node={child} onRemoveReference={onRemoveReference} disabled={disabled} />)}</div>
  </div></StockText>
}

export function TaskCompositionEditor({ task, disabled, saving, onEdit }: {
  task: ScreeningTaskRevision
  disabled: boolean
  saving: boolean
  onEdit: (change: CompositionEdit) => void
}) {
  const modeId = useId()
  const tree = task.logic_tree
  const isFlat = tree?.op === 'condition' && task.references.length === 1
    || (tree?.op === 'all' || tree?.op === 'any')
      && Array.isArray(tree.children)
      && tree.children.every(child => typeof child === 'object' && child !== null && child.op === 'condition')
  if (!isFlat) return <details className="screening-plan-edit task-composition-advanced">
    <summary>查看高级组合并编辑条件</summary>
    <TaskLogic task={task} onRemoveReference={referenceId => onEdit({ remove_reference_id: referenceId })} disabled={disabled} />
    {saving && <small role="status">正在保存组合…</small>}
  </details>

  const logicMode = tree?.op === 'any' ? 'any' : 'all'
  const references = tree?.op === 'condition'
    ? task.references
    : (tree?.children as Record<string, unknown>[] | undefined)?.map(child => task.references.find(item => item.reference_id === child.reference_id)).filter((item): item is ScreeningTaskRevision['references'][number] => !!item) ?? []
  return <section className="task-composition-editor" aria-label="条件组合编辑">
    {references.length > 1 && <div className="task-composition-controls">
      <span id={`${modeId}-label`}>组合方式</span>
      <div role="radiogroup" aria-labelledby={`${modeId}-label`} className="task-composition-mode">
        <label><input type="radio" name={modeId} checked={logicMode === 'all'} disabled={disabled} onChange={() => onEdit({ logic_mode: 'all' })} /><span>全部满足</span></label>
        <label><input type="radio" name={modeId} checked={logicMode === 'any'} disabled={disabled} onChange={() => onEdit({ logic_mode: 'any' })} /><span>满足任一</span></label>
      </div>
    </div>}
    <div className="task-composition-list">
      {references.map(reference => <ConditionRow key={reference.reference_id} task={task} referenceId={reference.reference_id} disabled={disabled} onRemove={referenceId => onEdit({ remove_reference_id: referenceId })} />)}
    </div>
    {saving && <small role="status">正在保存组合…</small>}
  </section>
}
