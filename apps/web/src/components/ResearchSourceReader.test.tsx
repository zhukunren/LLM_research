import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import type { SourceChunk } from '../companyResearch'
import ResearchSourceReader, { CompanySources } from './ResearchSourceReader'

vi.mock('../api', () => ({ api: vi.fn() }))

describe('ResearchSourceReader', () => {
  it('highlights the exact saved source range even when an emoji precedes it', () => {
    const snapshot = { source_type: 'news', source_id: 'source', source_version: 1, title: '保存来源', text: '🔎前文。原始引用。后文。', char_start: 100, quote_start: 104, quote_end: 109, quote: '原始引用。', available_at: '2026-09-10T16:01:00Z', as_of: '2026-09-11', page_number: 1 } as SourceChunk
    const { container } = render(<ResearchSourceReader projectId="p1" snapshot={snapshot} />)
    expect(container.querySelector('mark')).toHaveTextContent('原始引用。')
    expect(screen.getByText(/首次可得/)).toHaveTextContent('2026/9/11')
    expect(api).not.toHaveBeenCalled()
  })

  it('requires selection inside the loaded source and forwards unicode character positions', async () => {
    const user = userEvent.setup()
    const onQuote = vi.fn()
    const source = { source_id: 'n1', source_type: 'news', title: '原文', page_count: 1 } as const
    vi.mocked(api).mockResolvedValue({ ...source, text: '🔎原文核验。', char_start: 0, char_end: 6, original_characters: 6, next_offset: null, as_of: '2026-09-10', available_at: '2026-09-10', page_number: 1, source_version: 1 })
    const { container } = render(<ResearchSourceReader projectId="p1" code="600519.SH" asOf="2026-09-10" source={{ ...source, available_at: '', publication_at: '' }} onQuote={onQuote} />)
    await screen.findByText('🔎原文核验。')
    await user.click(screen.getByRole('button', { name: '引用所选原文' }))
    expect(onQuote).not.toHaveBeenCalled()
    const node = container.querySelector('pre')!.firstChild!
    const range = document.createRange()
    range.setStart(node, 2); range.setEnd(node, node.textContent!.length)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    await user.click(screen.getByRole('button', { name: '引用所选原文' }))
    expect(onQuote).toHaveBeenCalledWith('原文核验。', 1, expect.objectContaining({ source_id: 'n1' }))
    selection.removeAllRanges()
  })

  it('uses the explicit research date when switching document types', async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockResolvedValue({ items: [], total: 0, next_offset: null })
    render(<CompanySources projectId="p1" code="600519.SH" asOf="2026-09-10" onChoose={vi.fn()} />)
    await screen.findByText(/该截止日前没有/)
    await user.click(screen.getByRole('button', { name: '研报' }))
    expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toContain('kind=report&as_of=2026-09-10')
  })
})
