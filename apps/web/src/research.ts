import type { ConversationScope } from './api'

export type ResearchProjectSummary = {
  id: string; name: string; objective: string; status: 'active' | 'archived'; revision: number
  company_count: number; conversation_count: number; note_count: number; updated_at: string
}
export type ProjectConversation = {
  id: string; title: string | null; entry_scope: ConversationScope; state: 'active' | 'archived'
  research_mode: string; last_turn_state: string | null; updated_at: string
}
export type ResearchNote = {
  id: string; project_id: string; title: string; body: string; stock_code: string | null
  validation_plan: string; invalidation_condition: string
  status: 'watching' | 'supported' | 'challenged' | 'invalidated'; revision: number
  source_conversation_id: string | null; source_message_id: string | null; updated_at: string
}
export type ResearchProject = Omit<ResearchProjectSummary, 'company_count' | 'conversation_count' | 'note_count'> & {
  companies: { stock_code: string; name: string }[]
  conversations: ProjectConversation[]
  notes: ResearchNote[]
}
export type ResearchFile = { name: string; bytes: number; url: string; modified_at: number; conversation_id: string }

export const noteStatuses: Record<ResearchNote['status'], string> = {
  watching: '待验证', supported: '得到支持', challenged: '存在反证', invalidated: '判断失效',
}
