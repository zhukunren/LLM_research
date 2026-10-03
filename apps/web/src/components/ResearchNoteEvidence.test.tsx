import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import type { ResearchNote, ResearchProject } from '../research'
import ResearchNoteEvidence from './ResearchNoteEvidence'

vi.mock('../api', () => ({ api: vi.fn() }))

describe('ResearchNoteEvidence', () => {
  it('keeps a claim attached to its original notebook version and opens the frozen source', async () => {
    const user = userEvent.setup()
    const note = { id: 'n1', revision: 2 } as ResearchNote
    const project = { id: 'p1', status: 'archived', companies: [] } as unknown as ResearchProject
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes('/claims?')) return { items: [{ id: 'claim', statement: '原判断', kind: 'forecast', note_revision: 1, as_of: '2026-09-10', evidence: [{ source_id: 'original', title: '原资讯', source_type: 'news', source_version: 1, quote: '原始依据', stance: 'contradicts' }] }], next_offset: null } as never
      return { source_type: 'news', source_id: 'original', source_version: 1, title: '原资讯', text: '开头。原始依据。', char_start: 0, quote_start: 3, quote_end: 7, quote: '原始依据', page_number: 1, available_at: '2026-09-10', as_of: '2026-09-10', snapshot: true } as never
    })
    const { container } = render(<ResearchNoteEvidence project={project} note={note} asOf="2026-09-10" />)
    await user.click(screen.getByText('判断与原文依据'))
    await screen.findByText('原判断')
    expect(screen.getByText('关联第 1 版笔记')).toBeVisible()
    expect(screen.getByText(/反方依据/)).toBeVisible()
    expect(screen.queryByRole('button', { name: '添加判断与依据' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '定位原文' }))
    await screen.findByText(/保存时的原文摘录/)
    expect(container.querySelector('mark')).toHaveTextContent('原始依据')
    expect(api).toHaveBeenCalledWith('/research-projects/p1/claims/claim/evidence/0')
  })
})
