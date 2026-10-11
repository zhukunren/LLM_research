import type { IndicatorChart } from './pages/TechnicalBrowser'

export type IndicatorParameter = number
export type IndicatorParameterSpec = {
  type: 'integer' | 'number'
  label?: string
  description?: string
  minimum?: number
  maximum?: number
}
export type DynamicIndicatorDefinition = {
  name: string
  description: string
  formula: string
  original_prompt: string
  program: {
    contract_version: 'python-indicator-v1'
    source_code: string
    required_fields: string[]
    required_history_bars: number
    parameters: Record<string, IndicatorParameter>
    parameter_specs?: Record<string, IndicatorParameterSpec>
  }
  outputs: { name: string; label: string; unit: string; placement: 'overlay' | 'pane'; kind: 'line' | 'histogram'; color?: string }[]
}
export type IndicatorValidation = {
  passed: boolean
  saveable: boolean
  checks?: unknown
  warnings?: string[]
}
export type IndicatorTrial = {
  trial_id: string
  conversation_id?: string | null
  definition_hash: string
  code_hash: string
  definition: DynamicIndicatorDefinition
  stock_code: string
  as_of: string
  actual_date: string | null
  parameters: Record<string, IndicatorParameter>
  series: Record<string, (number | null)[]>
  dates: string[]
  chart: IndicatorChart
  charts?: IndicatorChart[]
  validation: IndicatorValidation
  source_context: Record<string, unknown>
  indicator_id?: string | null
  version?: number | null
  created_at?: string
}
export type SavedIndicator = {
  id: string
  version: number
  name: string
  definition: DynamicIndicatorDefinition
  definition_hash: string
  code_hash: string
  trial_id?: string
  validation?: IndicatorValidation
  source_context?: Record<string, unknown>
  created_at: string
}
export type IndicatorTrialSummary = Pick<IndicatorTrial, 'trial_id' | 'created_at'> & Partial<IndicatorTrial> & { name?: string }
export type IndicatorComparison = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'cross_above' | 'cross_below'
export const indicatorComparisons: Record<IndicatorComparison, string> = {
  gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', eq: '等于', cross_above: '上穿', cross_below: '下穿',
}

export function describeIndicatorPrompt(description: string, stock: string, asOf: string, saved?: SavedIndicator, trial?: IndicatorTrial, limit = 500) {
  const source = saved ? `请先使用 read_dynamic_indicator 读取我的指标 ${JSON.stringify(saved.name)}（indicator_id=${saved.id}，version=${saved.version}），按下述要求修改并生成新的试算草稿。` : trial ? `请先使用 read_indicator_trial 读取当前对话的 trial_id=${trial.trial_id}，按下述要求修改并重新试算。` : '请根据下面的描述生成一个自定义数值指标。'
  return `${source}\n\n${description.trim()}\n\n请由 Codex 编写 python-indicator-v1 数值时序程序，输出与交易日期逐日对齐；不要只返回当日值或布尔选股条件，也不要受内置指标目录限制。说明公式、参数、数据需求和单位，禁止未来数据。使用 preview_dynamic_indicator 在 ${stock}${asOf ? `、截至 ${asOf}` : ''} 试算最近 ${limit} 个交易日的完整历史走势，将试算结果留在当前对话的“我的指标”供我检查和保存。不要自动保存或执行选股。`
}

export function reuseIndicatorPrompt(saved: SavedIndicator, stock: string, asOf: string, limit = 500) {
  return `请使用 read_dynamic_indicator 读取我已保存的数值指标 ${JSON.stringify(saved.name)}（indicator_id=${saved.id}，version=${saved.version}，definition_hash=${saved.definition_hash}），保持该版本的公式和参数，用 preview_dynamic_indicator 对 ${stock}${asOf ? `、截至 ${asOf}` : ''} 重新试算最近 ${limit} 个交易日的完整时序，并解释走势、数据口径和缺失值。不要改用最新版本，也不要将数值直接当作选股布尔条件。`
}

export function indicatorScreeningPrompt(saved: SavedIndicator, output: string, operator: IndicatorComparison, threshold: number) {
  const label = saved.definition.outputs.find(item => item.name === output)?.label || output
  return `请将我已保存的指标 ${JSON.stringify(saved.name)} 的固定版本加入选股草稿：\nindicator_id=${saved.id}\nversion=${saved.version}\ndefinition_hash=${saved.definition_hash}\noutput=${output}\noperator=${operator}\nthreshold=${threshold}\n\n数值输出“${label}”${indicatorComparisons[operator]}阈值 ${threshold} 才构成布尔条件。请调用 build_indicator_condition，使用此版本冻结的公式和参数，将返回的条件加入筛选方案；缺失和预热期保留 unknown，不得把非零数值直接作为 true。沿用已有选股方案的股票范围与截止日期；如未设定则请明确说明并让我确认。保留草稿，等待我确认后再执行选股，不要自动运行。`
}

export function parameterError(definition: DynamicIndicatorDefinition, parameters: Record<string, IndicatorParameter>): string {
  for (const [name, original] of Object.entries(definition.program.parameters)) {
    const value = parameters[name]
    const spec = definition.program.parameter_specs?.[name]
    const label = spec?.label || name
    if (typeof original === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} 应为有效数值。`
      if (spec?.type === 'integer' && !Number.isInteger(value)) return `${label} 应为整数。`
      if (spec?.minimum != null && value < spec.minimum) return `${label} 不能小于 ${spec.minimum}。`
      if (spec?.maximum != null && value > spec.maximum) return `${label} 不能大于 ${spec.maximum}。`
    }
  }
  return ''
}

// An uncertain save can outlive its drawer. Reopening retries the exact server
// request instead of creating a second version after a lost response.
export function indicatorSaveRequestId(key: string): string {
  const storageKey = 'dynamicIndicators.saveRequests'
  let entries: [string, string][] = []
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(storageKey) || '[]')
    if (Array.isArray(parsed)) entries = parsed.filter((entry): entry is [string, string] => Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string'))
  } catch { /* An in-memory attempt still protects repeated clicks. */ }
  const existing = entries.find(([saved]) => saved === key)
  if (existing) return existing[1]
  const id = crypto.randomUUID()
  try { sessionStorage.setItem(storageKey, JSON.stringify([...entries.slice(-49), [key, id]])) } catch { /* Storage is optional. */ }
  return id
}
