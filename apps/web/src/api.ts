export type ApiError = { code: string; message: string; details?: unknown }

const API = '/api/v1'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!(init?.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(`${API}${path}`, { ...init, headers })
  } catch (error) {
    if (init?.signal?.aborted || (error as Error).name === 'AbortError') throw error
    throw new Error('暂时无法连接本地服务，请稍后重试。')
  }
  if (response.status === 204) return undefined as T
  let body
  try { body = await response.json() }
  catch (error) {
    if (init?.signal?.aborted) throw error
    throw new Error(response.ok ? '服务返回的数据格式异常，请重试。' : `服务暂时不可用（${response.status}），请重试。`)
  }
  if (!response.ok) {
    const message = typeof body?.message === 'string' ? body.message : typeof body?.detail?.message === 'string' ? body.detail.message : typeof body?.detail === 'string' ? body.detail : `请求失败 (${response.status})`
    const detail = Array.isArray(body?.details) ? `：${body.details.join('；')}` : ''
    throw new Error(message + detail)
  }
  return body as T
}

export type DataStatus = {
  available: boolean
  rows?: number
  securities?: number
  first_date?: string
  last_date?: string
  latest_day_rows?: number
  markets?: Record<string, number>
  bytes?: number
  duplicate_keys?: number
  null_ohlc?: number
  invalid_ohlc?: number
  negative_volume?: number
  negative_amount?: number
  high_below_body?: number
  low_above_body?: number
  nonpositive_prices?: number
  null_keys?: number
  nonfinite_prices?: number
  sha256?: string
  price_basis?: string
  volume_unit?: string
  amount_unit?: string
  quality_status?: string
  formal_execution_ready?: boolean
  formal_blockers?: string[]
}

export type Filter = {
  id: string
  library: 'news' | 'technical' | 'report'
  name: string
  description: string
  version: number
  expression: Record<string, unknown>
  parameters?: Record<string, { label: string; type: 'integer' | 'number' | 'enum'; min?: number; max?: number; options?: Record<string, string> }>
  created_at: string
  contract?: { summary: string; notes: string[]; availability: string; availability_label: string; minimum_bars?: number }
  provenance?: { original_prompt?: string; prompt?: string; source_quote?: string; source?: string; model?: string; compiler_version?: string; confirmed_at?: string; based_on_version?: number; assumptions?: string[]; original_expression?: Record<string, unknown>; confirmation_edits?: { name?: string; parameters?: Record<string, string | number> }; source_document?: { document_id: string; title: string; page: number } }
}

export type Pattern = {
  id: string
  name: string
  version: number
  input_type: 'drawing' | 'screenshot' | 'market_window' | 'natural_language'
  representation: 'price_path' | 'ohlc_sequence'
  target_bars: number
  points: number[]
  candlesticks: { open: number; high: number; low: number; close: number }[]
  params: Record<string, unknown>
  source_image?: { filename: string; mime_type: 'image/png' | 'image/jpeg' | 'image/webp'; sha256: string }
  created_at: string
  provenance?: { draft_id: string; prompt: string; source: string; model: string | null; compiler_version: string; assumptions: string[] }
}

export type Strategy = {
  id: string
  version: number
  name: string
  tree: Record<string, unknown>
  top_n: number
  created_at: string
}

export type ConversationScope = 'technical' | 'news' | 'report' | 'pattern' | 'screening'
export type ConversationSourceReference = {
  kind: 'report_page' | 'news_item' | 'security' | 'screening_run' | 'pattern' | 'condition'
  source_id: string
  page_number?: number
  version?: number
}
export type ConversationMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  source_refs: Record<string, unknown>[]
  created_at: string
}
export type ConversationTurn = {
  id: string
  user_message_id: string
  base_revision: number
  state: 'awaiting_agent' | 'running' | 'awaiting_user' | 'succeeded' | 'failed' | 'cancelled'
  response_text: string | null
  result: {
    intent?: string
    task_revision?: number
    revision_changes?: string[]
    execution_authorized?: boolean
    ready_to_execute?: boolean
    execution_authorization_message_id?: string | null
  }
  created_at: string
  updated_at: string
}
export type Conversation = {
  id: string
  task_id: string
  entry_scope: ConversationScope
  task_revision: number
  active_run_id: string | null
  pending_execution: boolean
  state: 'active' | 'archived'
  messages: ConversationMessage[]
  turns: ConversationTurn[]
  created_at: string
  updated_at: string
}
export type ScreeningTaskRevision = {
  task_id: string
  revision: number
  original_user_messages: string[]
  conditions: { condition_id: string; library: string; source_quote: string; description: string; expression: Record<string, unknown>; program?: { parameters?: Record<string, number>; parameter_specs?: Record<string, { label: string }> } | null }[]
  references: { reference_id: string; condition_id: string; parameter_overrides: Record<string, unknown>; source_quote?: string | null }[]
  logic_tree: Record<string, unknown> | null
  scope: {
    universe: { kind: string; watchlist_id?: string | null; stock_codes: string[] } | null
    as_of: string | null
    report_lookback_calendar_days: number | null
    news_lookback_calendar_days: number | null
    price_basis: string | null
    ranking: Record<string, unknown> | null
  }
  unresolved: { kind: string; source_quote: string; question: string; suggestion?: string | null }[]
}
export type ScreeningTaskRunSummary = {
  id: string
  task_revision: number
  as_of: string
  status: string
  job_id: string
  created_at: string
  finished_at: string | null
}
export type SavedScreeningTask = {
  id: string
  name: string
  version: number
  task: ScreeningTaskRevision
  created_at: string
}
export type ScreeningTaskDecision = {
  stock_code: string
  state: 'true' | 'false' | 'unknown'
  evaluation_status: 'completed' | 'failed' | 'not_evaluated'
  reason_code: string
  condition_decisions: {
    condition_id: string
    reference_id: string
    state: 'true' | 'false' | 'unknown'
    evaluation_status: 'completed' | 'failed' | 'not_evaluated'
    reason_code: string
    explanation: string
    actual_values: Record<string, unknown>
    thresholds: Record<string, unknown>
    units: Record<string, string>
  }[]
}
