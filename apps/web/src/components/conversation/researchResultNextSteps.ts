import type { Conversation, ConversationMessage, ConversationTurn, ResearchScope } from '../../api'
import type { Security } from '../StockSearch'

type FrozenResearchTurn = ConversationTurn & { research_scope?: ResearchScope }

export function researchAnswerTurn(conversation: Conversation, message: ConversationMessage): FrozenResearchTurn | undefined {
  if (message.turn_id) return conversation.turns.find(item => item.id === message.turn_id) as FrozenResearchTurn | undefined
  const index = conversation.messages.findIndex(item => item.id === message.id)
  if (index < 0) return undefined
  const question = conversation.messages.slice(0, index).reverse().find(item => item.role === 'user')
  return conversation.turns.find(item => item.user_message_id === question?.id) as FrozenResearchTurn | undefined
}

/** Use the answer's own turn and sources. A later scope edit must not relabel an old answer. */
export function researchAnswerSecurityCodes(conversation: Conversation, message: ConversationMessage): string[] {
  const index = conversation.messages.findIndex(item => item.id === message.id)
  const question = index < 0 ? undefined : conversation.messages.slice(0, index).reverse().find(item => item.role === 'user')
  const turn = researchAnswerTurn(conversation, message)
  const codes = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === 'string' && /^\d{6}\.(SH|SZ|BJ)$/i.test(value.trim())) codes.add(value.trim().toUpperCase())
  }
  turn?.research_scope?.stock_codes?.forEach(add)
  for (const reference of [...(question?.source_refs ?? []), ...message.source_refs]) {
    if (reference.kind === 'security') add(reference.source_id)
    if (reference.kind === 'report_page' && reference.security_binding_status === 'confirmed') add(reference.stock_code)
    if (reference.kind === 'news_item' && Array.isArray(reference.stock_codes)) reference.stock_codes.forEach(add)
  }
  return [...codes]
}

export function uniqueResearchSecurity(codes: string[], securities: Security[]): Security | undefined {
  return codes.length === 1 ? securities.find(item => item.stock_code === codes[0] && item.market !== '指数') : undefined
}

/** An editable excerpt, not a newly inferred investment judgment. */
export function researchAnswerExcerpt(content: string, limit = 600): string {
  const prose = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*|>\s*)/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (prose.length <= limit) return prose
  const prefix = prose.slice(0, limit)
  const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？'), prefix.lastIndexOf('；'))
  return (boundary >= limit / 2 ? prefix.slice(0, boundary + 1) : prefix.trimEnd()) + '…'
}

export function researchAnswerScreeningDraft(content: string): string {
  const excerpt = researchAnswerExcerpt(content, 1800)
  return excerpt ? `请依据这段研究摘录整理可以逐项核对的选股条件，先明确需要我确认的计算口径和证据要求：\n\n${excerpt}` : ''
}
