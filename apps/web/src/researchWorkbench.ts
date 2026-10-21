import type { ResearchClaim, SourceChunk } from './companyResearch'
import type { ResearchNote } from './research'

export type CompanyResearchContext = {
  notes: Pick<ResearchNote, 'id' | 'title' | 'status' | 'revision' | 'validation_plan' | 'invalidation_condition' | 'updated_at'>[]
  claims: (ResearchClaim & { note_id: string; note_title: string; current_note_revision: number; note_status: ResearchNote['status']; needs_revalidation: boolean })[]
  observations: { id: string; status: string; note: string; verification: string; invalidation: string }[]
  note: string
}
export const cellStatuses = { pending: '待填写', evidence_found: '已找到依据', conflicting: '存在矛盾', not_found: '给定资料未找到', not_disclosed: '原文说明未披露', not_applicable: '不适用', needs_review: '需要复核' }
export type MatrixDefinition = { id: string; project_id: string; name: string; stock_codes: string[]; questions: { id: string; label: string; prompt: string }[] }
export type MatrixCell = { stock_code: string; question_id: string; answer: string; status: keyof typeof cellStatuses; comment?: string; review_revision: number; validation_note?: string; evidence: (Omit<SourceChunk, 'text'> & { quote: string; stance: 'supports' | 'contradicts' | 'context' })[] }
export type MatrixRun = { id: string; matrix_id: string; job_id: string | null; as_of: string; mode: string; status: string; created_at: string; cells: MatrixCell[]; note: string; previous_run_id: string | null; summary: { total: number; located: number; reviewed: number }; changes: { stock_code: string; question_id: string; previous_answer: string; answer: string; previous_status: string; status: string }[]; coverage: Record<string, { reports: number; news: number; read_chunks: number; note: string }>; measurements?: Record<string, { seconds: number; model_called: boolean; model?: string; tokens?: Record<string, number> }> }
export type TrackingChange = { key: string; type: 'added' | 'updated' | 'unavailable'; category: string; title: string; source_type?: 'news' | 'report' | 'disclosure'; source_id?: string; page_count?: number; available_at: string; review: { comment: string; created_at: string } | null; event?: string; original_check?: unknown; point?: { value: string | null; unit: string; reason: string }; affected_notes?: { note_id: string; title: string; url?: string }[]; previous?: { title: string; point?: { value: string | null; unit: string; reason: string } } }
export type TrackingCheck = { id: string; as_of: string; baseline: boolean; created_at: string; changes: TrackingChange[]; unreviewed_count: number; note: string; coverage: { reports: number; news: number; inventory_complete: boolean }; review_questions: { note_id: string; title: string; revision: number; validation_plan: string; invalidation_condition: string }[] }
export type ProjectQuality = { checked_at: string; metrics: { claims: number; references: number; valid_references: number; stale_claims: number; matrix_cells: number; reviewed_cells: number; needs_review_cells: number }; issues: { kind: string; id: string; note_id?: string; run_id?: string; title: string; code: string }[]; issue_count: number; note: string; limits: { claims: number; matrix_runs: number } }
