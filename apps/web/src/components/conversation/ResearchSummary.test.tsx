import { render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { ResearchReadingBrief } from '../../api'
import ResearchAnswer from './ResearchAnswer'

const summary: ResearchReadingBrief = { version: 1, turn_id: 'turn', conclusion: '增长还需要后续现金流验证。', key_points: [{ kind: 'fact', text: '公告已披露报告期。' }, { kind: 'inference', text: '增长持续性有待观察。' }, { kind: 'unknown', text: '尚无下一期资料。' }], risks: ['资料覆盖有限。'], next_steps: ['核对下一期经营现金流。'], data_as_of: null, data_note: '不同资料的报告期见正文。' }

it('shows the saved brief with evidence types and dates while preserving the complete answer', () => {
  render(<ResearchAnswer conversationId="one" content="完整正文包含[公告](https://example.com/notice)。" summary={summary} />)
  const brief = screen.getByRole('region', { name: '研究摘要' })
  expect(brief).toHaveTextContent(summary.conclusion)
  for (const label of ['有据事实', '研究推断', '待核实', '主要风险', '待验证事项', '资料未统一截止日']) expect(within(brief).getByText(label)).toBeVisible()
  expect(screen.getByRole('link', { name: '公告' })).toHaveAttribute('href', 'https://example.com/notice')
})

it('uses only the recorded evidence cutoff and escapes brief content as plain text', () => {
  const { container } = render(<ResearchAnswer conversationId="one" content="完整正文" summary={{ ...summary, conclusion: '<script>alert(1)</script>', data_as_of: '2026-09-30', data_note: null }} />)
  expect(screen.getByText('资料截至 2026-09-30')).toBeVisible()
  expect(container.querySelector('script')).toBeNull()
  expect(screen.getByText('<script>alert(1)</script>')).toBeVisible()
})

it('does not manufacture a summary from legacy headings or the first paragraph', () => {
  render(<ResearchAnswer conversationId="one" content={'## 研究结论\n\n这仍是历史完整正文。'} />)
  expect(screen.queryByRole('region', { name: '研究摘要' })).not.toBeInTheDocument()
  expect(screen.getByText('这仍是历史完整正文。')).toBeVisible()
})
