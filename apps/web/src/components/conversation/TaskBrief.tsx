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

export function TaskLogic({ task, node = task.logic_tree }: { task: ScreeningTaskRevision; node?: Record<string, unknown> | null }) {
  if (!node) return <p className="conversation-muted">组合关系待确认</p>
  if (node.op === 'condition') {
    const reference = task.references.find(item => item.reference_id === node.reference_id)
    const condition = task.conditions.find(item => item.condition_id === reference?.condition_id)
    if (!condition) return <p className="conversation-muted">条件待补充</p>
    return <article className="task-logic-condition">
      <span className="task-library-label">{libraryLabels[condition.library] ?? '条件'}</span>
      <span className="task-execution-rule"><small>{Object.keys(reference?.parameter_overrides ?? {}).length ? '计算方法（采用下方本次参数）' : '实际筛选规则'}</small><strong>{condition.description}</strong>{!!Object.keys(condition.program?.parameters ?? {}).length && <small>计算参数：{Object.entries({ ...condition.program?.parameters, ...reference?.parameter_overrides }).map(([key, value]) => `${condition.program?.parameter_specs?.[key]?.label || key} ${String(value)}`).join('；')}</small>}</span>{(reference?.source_quote || condition.source_quote) !== condition.description && <p className="task-source-quote">你的要求：{reference?.source_quote || condition.source_quote}</p>}
      {!!Object.keys(reference?.parameter_overrides ?? {}).length && <small>本次采用的参数：{Object.entries(reference!.parameter_overrides).map(([key, value]) => `${condition.program?.parameter_specs?.[key]?.label ?? parameterLabels[key] ?? key} ${String(value)}`).join('；')}</small>}
    </article>
  }
  const children = Array.isArray(node.children) ? node.children as Record<string, unknown>[] : []
  const label = ({ all: '同时满足', any: '满足任一', not: '排除以下情况' } as Record<string, string>)[String(node.op)]
  return <div className={`task-logic-group ${node.op === 'not' ? 'is-exclusion' : ''}`}>
    <span className="task-logic-label">{label ?? '组合关系待确认'}</span>
    <div>{children.map((child, index) => <TaskLogic key={index} task={task} node={child} />)}</div>
  </div>
}
