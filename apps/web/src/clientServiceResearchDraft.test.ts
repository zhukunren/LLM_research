import { expect, it } from 'vitest'
import type { Conversation, ConversationMessage } from './api'
import { isServiceResearchDraft, serviceResearchDraft } from './clientServiceResearchDraft'

it('uses the answer turn date rather than the latest conversation scope', () => {
  const message = { id: 'answer', role: 'assistant', turn_id: 'original', content: '原研究结论。', created_at: '2026-11-16T08:00:00Z', source_refs: [{ kind: 'security', source_id: '000001.SZ' }] } as ConversationMessage
  const conversation = { id: 'research-one', messages: [message], turns: [{ id: 'original', research_scope: { as_of: '2026-11-13' }, result: {} }, { id: 'later', research_scope: { as_of: '2026-11-16' }, result: {} }] } as unknown as Conversation
  expect(serviceResearchDraft(conversation, message)).toMatchObject({ asOf: '2026-11-13', excerpt: '原研究结论。', messageId: 'answer', references: message.source_refs })
  expect(isServiceResearchDraft(serviceResearchDraft(conversation, message))).toBe(true)
  expect(isServiceResearchDraft({ conversationId: '../bad' })).toBe(false)
  const structured = serviceResearchDraft(conversation, { ...message, content: JSON.stringify({ summary: '市场成交有所收缩。', metrics: [{ value: '123' }] }) })
  expect(structured.excerpt).toBe('市场成交有所收缩。')
  const longAnswer = serviceResearchDraft(conversation, { ...message, content: `## 经营变化\n${'长'.repeat(170)}\n后续要跟踪订单交付与现金流。` })
  expect(longAnswer).toMatchObject({ excerpt: '', passages: ['后续要跟踪订单交付与现金流。'] })
})
