import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import ResearchNoteHistory from './ResearchNoteHistory'

vi.mock('../api', () => ({ api: vi.fn() }))

describe('ResearchNoteHistory', () => {
  it('loads older source-linked conclusions only when history is opened', async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockResolvedValue({ items: [{ revision: 1, updated_at: '2026-10-03T08:00:00Z', status: 'watching', title: '原判断', body: '[原结果](outputs/original.csv)', source_conversation_id: 'source', validation_plan: '', invalidation_condition: '' }] })
    render(<ResearchNoteHistory projectId="project" noteId="note" />)
    expect(api).not.toHaveBeenCalled()
    await user.click(screen.getByText('历史版本'))
    await user.click(await screen.findByText(/第 1 版/, { selector: 'summary' }))
    expect(screen.getByRole('link', { name: '原结果' })).toHaveAttribute('href', '/api/v1/conversations/source/generated-files/original.csv')
    expect(screen.getByRole('link', { name: '下载第 1 版 PDF' })).toHaveAttribute('href', '/api/v1/research-projects/project/notes/note/pdf?revision=1')
    expect(api).toHaveBeenCalledWith('/research-projects/project/notes/note/history', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
})
