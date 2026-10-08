export type ModelSelection = { model_id: string; reasoning_effort: string }
export type ResearchModel = {
  id: string
  label: string
  description: string
  available: boolean
  unavailable_reason: string | null
  reasoning_efforts: { id: string; label: string }[]
  default_reasoning_effort: string
}
export type ResearchModelCatalog = {
  models: ResearchModel[]
  default_model_id: string
  default_reasoning_effort: string
  account_tier: string
  discovery_status?: string
}

const preferenceKey = 'research.modelPreference'
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

function validatedPreference(value: unknown): ModelSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => key !== 'model_id' && key !== 'reasoning_effort')) return null
  if (typeof item.model_id !== 'string' || !modelPattern.test(item.model_id)
    || typeof item.reasoning_effort !== 'string' || !efforts.has(item.reasoning_effort)) return null
  return { model_id: item.model_id, reasoning_effort: item.reasoning_effort }
}

export function readModelPreference(): ModelSelection | null {
  try {
    const stored = sessionStorage.getItem(preferenceKey)
    return stored ? validatedPreference(JSON.parse(stored)) : null
  } catch { return null }
}

export function writeModelPreference(value: ModelSelection): void {
  const validated = validatedPreference(value)
  if (!validated) return
  try { sessionStorage.setItem(preferenceKey, JSON.stringify(validated)) } catch { /* Storage can be unavailable in private browsing. */ }
}

export function validateModelCatalog(value: unknown): ResearchModelCatalog {
  if (!value || typeof value !== 'object') throw new Error('模型目录格式异常，请重试。')
  const item = value as ResearchModelCatalog
  if (!Array.isArray(item.models) || !item.models.length || typeof item.account_tier !== 'string'
    || typeof item.default_model_id !== 'string' || typeof item.default_reasoning_effort !== 'string') throw new Error('模型目录格式异常，请重试。')
  const ids = new Set<string>()
  for (const model of item.models) {
    if (!model || typeof model.id !== 'string' || !modelPattern.test(model.id) || ids.has(model.id)
      || typeof model.label !== 'string' || !model.label.trim() || typeof model.description !== 'string'
      || typeof model.available !== 'boolean' || !(model.unavailable_reason == null || typeof model.unavailable_reason === 'string')
      || !Array.isArray(model.reasoning_efforts) || !model.reasoning_efforts.length
      || model.reasoning_efforts.some(effort => !effort || !efforts.has(effort.id) || typeof effort.label !== 'string' || !effort.label.trim())
      || new Set(model.reasoning_efforts.map(effort => effort.id)).size !== model.reasoning_efforts.length
      || !model.reasoning_efforts.some(effort => effort.id === model.default_reasoning_effort)) throw new Error('模型目录格式异常，请重试。')
    ids.add(model.id)
  }
  const defaultModel = item.models.find(model => model.id === item.default_model_id)
  if (!defaultModel || !defaultModel.reasoning_efforts.some(effort => effort.id === item.default_reasoning_effort)) throw new Error('模型目录格式异常，请重试。')
  return item
}
