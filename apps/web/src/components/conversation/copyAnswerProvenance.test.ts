import { expect, it } from 'vitest'
import type { ConversationMessage } from '../../api'
import { copyAnswerProvenance } from './copyAnswerProvenance'
it('does not invent source dates or URLs and preserves exact answer units', () => {
  const message = { id: 'answer', role: 'assistant', content: '2025年营业收入 12340000000 元', source_refs: [{ kind: 'report_page', source_id: 'report-id', page_number: 8, title: '原始研报' }], created_at: '2026-01-01T10:00:00+08:00' } as ConversationMessage
  const text = copyAnswerProvenance(message, [])
  expect(text).toContain(message.content)
  expect(text).toContain('引用页码：8')
  expect(text).toContain('来源标识：report-id')
  expect(text).toContain('答复记录时间：2026-01-01T10:00:00+08:00')
  expect(text).not.toContain('发布日期：')
  expect(text).not.toContain('链接：')
})
it('distinguishes consulted sources and does not manufacture missing evidence', () => {
  const message = { content: '正文', source_refs: [], created_at: '' } as unknown as ConversationMessage
  expect(copyAnswerProvenance(message, [])).toContain('未附来源。')
  expect(copyAnswerProvenance(message, [{ title: '查阅材料', relation: 'consulted', source_id: 'lookup', recorded_at: '2026-02-02' }])).toContain('关系：研究中查阅')
})
