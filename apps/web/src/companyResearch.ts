import type { ChartBar } from './components/MarketIndicatorChart'
import type { CompanyResearchContext } from './researchWorkbench'

export const researchToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
export const sourceTime = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
export const claimKinds = { fact: '事实陈述', forecast: '预测', inference: '推断' }
export const evidenceStances = { supports: '支持依据', contradicts: '反方依据', context: '背景资料' }
export type ResearchSource = { source_type: 'news' | 'report' | 'disclosure'; source_id: string; title: string; available_at: string; publication_at: string | null; page_count: number }
export type SourceListing = { items: ResearchSource[]; total: number; next_offset: number | null }
export type SourceChunk = ResearchSource & {
  text: string; page_number: number; char_start: number; char_end: number; next_offset: number | null
  original_characters: number; source_sha256: string; source_version: number | null; as_of: string
  quote?: string; quote_start?: number; quote_end?: number; snapshot?: boolean
}
export type ResearchClaim = {
  id: string; note_revision: number; stock_code: string; statement: string; kind: keyof typeof claimKinds; as_of: string
  evidence: (Omit<SourceChunk, 'text'> & { quote: string; stance: keyof typeof evidenceStances })[]
  semantic_support_verified: false
  numeric_evidence?: { kind: string; source_id: string; title: string; url: string; excerpt: string }[]
}
export type CompanyDossier = {
  stock_code: string; name: string; as_of: string; market_as_of: string | null; invalid_bars: number
  bars: (ChartBar & { quality_valid: boolean })[]; market_quality: Record<string, string>
  news: SourceListing; reports: SourceListing; pending_report_count: number; note_count: number; coverage_note: string
  research?: CompanyResearchContext
}
