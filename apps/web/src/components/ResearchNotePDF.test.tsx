import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import ResearchNotePDF from './ResearchNotePDF'

vi.mock('../api', () => ({ api: vi.fn() }))

it('queues the exact missing revision only after an explicit click and shows background generation', async () => {
  const user = userEvent.setup()
  vi.mocked(api).mockResolvedValue({ id: 'pdf', name: '历史.pdf', status: 'queued', url: null, bytes: 0, modified_at: 0, conversation_id: '' })
  const view = render(<ResearchNotePDF projectId="project" noteId="note" revision={2} pdf={null} />)
  expect(api).not.toHaveBeenCalled()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '生成第 2 版 PDF' }))
  expect(await screen.findByText('PDF 后台生成中 · 正文已保存')).toBeInTheDocument()
  expect(api).toHaveBeenCalledWith('/research-projects/project/notes/note/pdf-jobs', { method: 'POST', body: JSON.stringify({ revision: 2 }) })
  view.unmount()
})

it('retries only the failed PDF job while preserving the note version', async () => {
  const user = userEvent.setup()
  vi.mocked(api).mockResolvedValue({ id: 'pdf', status: 'queued', url: null })
  const view = render(<ResearchNotePDF projectId="project" noteId="note" revision={1} pdf={{ id: 'pdf', name: '原版.pdf', bytes: 0, modified_at: 0, conversation_id: '', status: 'failed', url: null, retry_url: '/api/v1/research-projects/project/research-pdf-jobs/pdf/retry' }} />)
  await user.click(screen.getByRole('button', { name: '重试报告' }))
  expect(api).toHaveBeenCalledWith('/research-projects/project/research-pdf-jobs/pdf/retry', { method: 'POST' })
  expect(screen.getByText('PDF 后台生成中 · 正文已保存')).toBeInTheDocument()
  view.unmount()
})
