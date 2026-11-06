export type BriefKind = 'market' | 'policy' | 'industry' | 'closing' | 'stock-analysis' | 'stock-rationale'
export type BriefScope = {
  markets: ('CN' | 'HK' | 'US' | 'GLOBAL')[]
  lookback_hours: 24 | 72 | 168
  industries: string[]
  source_preference: 'primary' | 'broad'
  max_items: 5 | 10 | 15
  focus: string
  advisor?: AdvisorScope | null
}
export const briefKinds = [
  { id: 'closing' as const, name: '收评', description: '复盘交易日，整理盘面要点、次日观察与每日股评稿。' },
  { id: 'stock-analysis' as const, name: '个股分析', description: '围绕买入咨询或持仓问题，核对经营、估值、走势与风险。' },
  { id: 'stock-rationale' as const, name: '个股推荐理由', description: '为已选股票整理有据可查的推荐逻辑、反方依据与沟通稿。' },
  { id: 'market' as const, name: '市场简报', description: '从市场变化出发，核对事件、影响与原始证据。' },
  { id: 'policy' as const, name: '政策追踪', description: '查阅政策原文，核对发布阶段、变化和影响范围。' },
  { id: 'industry' as const, name: '产业跟踪', description: '跟进供需、价格、订单与产能，保留实际产业证据。' },
]
export const briefMarkets = { CN: '中国内地', HK: '中国香港', US: '美国', GLOBAL: '全球' }
export const briefStates: Record<string, string> = {
  queued: '等待执行', running: '正在整理', blocked: '等待恢复', succeeded: '已完成',
  partial: '已完成 · 有待核验项', failed: '未完成', cancelled: '已停止',
  evidence_gap: '原文获取未完成',
}
export const defaultBriefScope: BriefScope = { markets: ['CN'], lookback_hours: 24, industries: [], source_preference: 'primary', max_items: 10, focus: '' }
export const briefTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
export const briefScopeLabel = (scope: BriefScope) => [scope.advisor?.stock_code || '', scope.advisor?.trade_date || '', scope.markets.map(value => briefMarkets[value]).join('、'), '近 ' + (scope.lookback_hours === 168 ? '7 天' : scope.lookback_hours === 72 ? '3 天' : '24 小时'), scope.industries.join('、')].filter(Boolean).join(' · ')
export const briefActive = (state: string) => state === 'queued' || state === 'running'
export type BriefCitation = {
  source_id: string; title: string; url: string; quote: string; quote_start: number; quote_end: number
  quote_verified: boolean; published_at: string | null; publication_precision: string
  publication_quote: string; publication_basis: string; time_status: string; source_type: string
  retrieved_at: string; sha256: string
}
export type BriefItem = {
  event_key: string; title: string; event_date: string; facts: string; analysis: string
  importance: 'high' | 'medium' | 'low'; ranking_reason: string; affected: string[]
  uncertainties: string[]; next_check: string; policy_stage: string | null; industry_dimension: string | null
  analysis_dimension?: string | null
  evidence: BriefCitation[]; verification: 'quoted' | 'time_pending'; change: 'new' | 'updated' | 'unchanged'
}
export type AdvisorValidationResult = { errors: string[]; warnings: string[]; suggestions: string[] }
export type BriefResult = {
  validation_result?: AdvisorValidationResult
  validation_level?: 'off' | 'basic' | 'strict'
  advisor_report?: AdvisorReport | null
  outcome?: 'events' | 'no_updates' | 'evidence_gap'
  title: string; summary: string; items: BriefItem[]; coverage: string; limitations: string[]
  no_updates_reason: string; not_in_current: { event_key: string; title: string }[]
  comparison: string; verification_note: string
}
export type BriefRun = {
  id: string; request_id?: string; kind: BriefKind; version: number; scope: BriefScope; cutoff_at: string
  window_start: string; created_at: string; finished_at: string | null; state: string
  previous_id: string | null; conversation_id: string | null; turn_id: string | null; retry_of: string | null
  title: string; item_count: number | null; error: string | null
}
export type BriefDetail = BriefRun & {
  advisor_context?: AdvisorContext | null
  result: BriefResult | null; source_count: number; search_count: number
  validation_result?: AdvisorValidationResult | null
  activity: { id: number | string; stage: string; message: string; created_at: string }[]
  sources: { id: string; url: string; title: string; retrieved_at: string; sha256: string }[]
}
export type BriefCatalog = { items: BriefRun[]; total: number; next_offset: number | null; latest_result_id: string | null; default_scope: BriefScope; legacy: { conversation_id: string; started_at: string; title: string }[] }
export type BriefSource = { id: string; url: string; title: string; text: string; sha256: string; retrieved_at: string; publisher_date: string | null }
export type BriefRequest = { request_id: string; kind: BriefKind; scope: BriefScope; cutoff_at: string | null; retry_of?: string }

export type AdvisorScope = {
  stock_code: string | null; trade_date: string | null; horizon: 'short' | 'medium' | 'long'
  position: 'watching' | 'holding'; holding_cost: number | null
  risk_preference: 'unspecified' | 'cautious' | 'balanced' | 'growth'
  question: string; recommendation_background: string; audience: 'client' | 'internal'
}
export const defaultAdvisorScope: AdvisorScope = { stock_code: null, trade_date: null, horizon: 'medium', position: 'watching', holding_cost: null, risk_preference: 'unspecified', question: '', recommendation_background: '', audience: 'client' }
export const isAdvisorKind = (kind: BriefKind) => ['closing', 'stock-analysis', 'stock-rationale'].includes(kind)
export const isStockKind = (kind: BriefKind) => kind === 'stock-analysis' || kind === 'stock-rationale'
export const taskNoun = (kind: BriefKind) => kind === 'closing' ? '收评' : kind === 'stock-analysis' ? '诊股报告' : kind === 'stock-rationale' ? '推荐理由' : '简报'
export const advisorVerdicts: Record<string, string> = { review: '市场复盘', support: '逻辑有依据', conditional: '有条件支持', watch: '继续观察', insufficient: '证据不足', against: '暂不支持' }
export const analysisDimensions: Record<string, string> = { market: '市场表现', business: '公司业务', financial: '财务质量', valuation: '估值口径', technical: '量价走势', catalyst: '催化与变化', risk: '风险与反证' }
export type AdvisorPoint = { title: string; explanation: string; evidence_keys: string[] }
export type ClosingReview = {
  turnover: { market_scope: 'SH_SZ' | 'SH_SZ_BJ'; amount_yi: number; evidence_keys: string[]
    comparison: { market_scope: 'SH_SZ' | 'SH_SZ_BJ'; change_yi: number; evidence_keys: string[] } | null } | null
  events: { title: string; evidence_keys: string[]; local_start: string | null; source_timezone: string | null
    beijing_start: string | null; session_relation: string; client_copy_excerpt: string }[]
  scope_notes: string
}
export type AdvisorReport = {
  stock_code: string | null; verdict: string; conclusion: string; effective_date: string
  session_status: 'closed' | 'not_closed' | 'data_missing' | null
  supporting_points: AdvisorPoint[]; contrary_points: AdvisorPoint[]; risks: string[]
  invalidation_conditions: string[]; action_conditions: string[]; suitability: string
  client_copy: string; full_copy: string
  closing_review?: ClosingReview | null
}
export type AdvisorContext = {
  stock: { stock_code: string; name: string; market: string } | null
  advisor: AdvisorScope; requested_trade_date: string; research_cutoff: string
  actual_market_date: string | null; session_status: string; gaps: string[]; market_source_ids: string[]
  observations: {stock_code: string; name: string; trade_date: string; close: number; change_pct: number | null}[]
  closing_policy?: { revision: string; preferred_turnover_scope: string; event_timezone: string }
}
