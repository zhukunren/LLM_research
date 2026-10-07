import type { Asset, Node } from './pages/StrategyPage'

export const compositionFingerprint = (name: string, tree: Node, topN: number) => JSON.stringify({ name: name.trim(), tree, top_n: topN })
export const countConditions = (node: Node): number => node.op.endsWith('_ref') ? 1 : (node.children ?? []).reduce((sum, child) => sum + countConditions(child), 0)
export function appendConditionPlan(current: Node, incoming: Node): Node {
  if (!countConditions(current)) return incoming.op.endsWith('_ref') ? { op: 'all', children: [incoming] } : incoming
  return { op: 'all', children: current.op === 'all' ? [...(current.children ?? []), incoming] : [current, incoming] }
}

export function executionDateIssue(value: string, lastDate?: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '请选择有效的筛选截止日期。'
  const date = new Date(value + 'T00:00:00Z')
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return '请选择有效的筛选截止日期。'
  return lastDate && value > lastDate ? `截止日期不能晚于行情水位 ${lastDate}。` : ''
}

export function compositionIssues(tree: Node, catalog: Asset[]): string[] {
  const issues: string[] = []
  let nodes = 0
  function visit(node: Node, path: string, depth: number) {
    if (++nodes > 200) { if (nodes === 201) issues.push('组合最多包含 200 个节点。'); return }
    if (depth > 16) { issues.push('分组嵌套过深，请简化组合。'); return }
    if (node.op === 'filter_ref' || node.op === 'pattern_ref') {
      const key = `${node.op === 'filter_ref' ? 'filter' : 'pattern'}:${node.filter_id ?? node.pattern_id}@${node.version}`
      const asset = catalog.find(item => item.key === key)
      if (!asset) { issues.push(`${path}引用的版本未载入，请刷新条件目录。`); return }
      const weight = node.score_weight ?? 1
      if (!Number.isFinite(weight) || weight < 0 || weight > 100) issues.push(`${path}的排序权重应在 0–100 之间。`)
      for (const [name, value] of Object.entries(node.parameter_overrides ?? {})) {
        const spec = asset.filter?.parameters?.[name]
        if (!spec) { issues.push(`${path}存在当前版本不支持的参数，请恢复默认或重新核对。`); continue }
        if (spec.type === 'enum') {
          if (!Object.hasOwn(spec.options ?? {}, String(value))) issues.push(`${path}的“${spec.label}”选项无效。`)
        } else {
          const number = Number(value)
          if (!Number.isFinite(number) || (spec.type === 'integer' && !Number.isInteger(number)) || (spec.min != null && number < spec.min) || (spec.max != null && number > spec.max)) issues.push(`${path}的“${spec.label}”超出允许范围。`)
        }
      }
      if (node.op === 'pattern_ref') {
        const similarity = node.min_similarity ?? Number(asset.pattern?.params.min_similarity ?? 80)
        if (!Number.isFinite(similarity) || similarity < 0 || similarity > 100) issues.push(`${path}的相似度应在 0–100 之间。`)
        const mode = node.match_mode ?? asset.pattern?.params.match_mode ?? 'current'
        const lookback = node.recent_bars ?? Number(asset.pattern?.params.recent_bars ?? 20)
        if (!['current', 'recent'].includes(String(mode))) issues.push(`${path}的形态匹配窗口无效。`)
        if (!Number.isInteger(lookback) || lookback < 1 || lookback > 120) issues.push(`${path}的近期回看应为 1–120 个交易日。`)
      }
      return
    }
    if (!['all', 'any', 'not'].includes(node.op)) { issues.push(`${path}的组合关系无效。`); return }
    const children = node.children ?? []
    if (!children.length) { issues.push(`${path}还没有条件，请添加条件或移除空分组。`); return }
    if (node.op === 'not' && children.length !== 1) issues.push(`${path}的排除关系需要一个完整子组。`)
    children.forEach((child, index) => visit(child, `${path} · 第 ${index + 1} 项`, depth + 1))
  }
  visit(tree, '当前组合', 1)
  return [...new Set(issues)]
}
