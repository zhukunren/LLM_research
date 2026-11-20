import type { Conversation, ConversationMessage } from './api'
import { conclusionLimit } from './clientService'
import { researchAnswerExcerpt, researchAnswerTurn } from './components/conversation/researchResultNextSteps'

export type ServiceResearchDraft = {
  conversationId: string; messageId: string; createdAt: string; asOf: string | null
  excerpt: string; references: Record<string, unknown>[]; passages?: string[]
}

export function serviceResearchPassages(text: string): string[] {
  const paragraphs = text.replace(/```[\s\S]*?```/g, '').split(/\r?\n/).map(line => researchAnswerExcerpt(line, 20000))
  const fitting = paragraphs.flatMap(paragraph => paragraph.length > conclusionLimit
    ? paragraph.split(/(?<=[。！？!?])\s*/).map(sentence => sentence.trim()) : [paragraph])
  return [...new Set(fitting.filter(passage => passage.length > 0 && passage.length <= conclusionLimit))].slice(0, 16)
}

export function serviceResearchDraft(conversation: Conversation, message: ConversationMessage): ServiceResearchDraft {
  const turn = researchAnswerTurn(conversation, message)
  let content = message.content
  try {
    const parsed: unknown = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
    if (parsed && typeof parsed === 'object') {
      const summary = (parsed as { summary?: unknown }).summary
      if (typeof summary === 'string') content = summary
    }
  } catch { /* Prose answers already provide an editable excerpt. */ }
  const conclusion = turn?.result.research_summary?.conclusion?.trim()
  const excerpt = conclusion || researchAnswerExcerpt(content, 1800)
  return {
    conversationId: conversation.id, messageId: message.id, createdAt: message.created_at,
    asOf: turn?.research_scope?.as_of || null,
    excerpt: excerpt.length <= conclusionLimit ? excerpt : '',
    passages: serviceResearchPassages(conclusion ? `${conclusion}\n${content}` : content),
    references: message.source_refs,
  }
}
export function isServiceResearchDraft(value: unknown): value is ServiceResearchDraft | null {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const draft = value as ServiceResearchDraft
  return typeof draft.conversationId === 'string' && /^[\w-]+$/.test(draft.conversationId) && typeof draft.messageId === 'string' && typeof draft.createdAt === 'string' && (draft.asOf === null || typeof draft.asOf === 'string') && typeof draft.excerpt === 'string' && draft.excerpt.length <= 20000 && Array.isArray(draft.references)
    && (draft.passages === undefined || Array.isArray(draft.passages) && draft.passages.length <= 16 && draft.passages.every(passage => typeof passage === 'string' && passage.length <= conclusionLimit))
}
