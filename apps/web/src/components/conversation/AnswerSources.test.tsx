import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import AnswerSources from './AnswerSources'

vi.mock('../PdfReader', () => ({ default: ({ url, page }: { url: string; page: number }) => <div aria-label="研报内容">{url} · 第 {page} 页</div> }))

it('reads a report in the side panel at the cited page, preserves its external link and restores focus', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup()
  render(<AnswerSources references={[{ kind: 'report_page', source_id: 'report-one', title: '经营证据', page_number: 3 }]} />)
  await user.click(screen.getByText('资料来源 · 1'))
  const link = screen.getByRole('link', { name: '经营证据 · 第 3 页' })
  await user.click(link)
  expect(await screen.findByLabelText('研报内容')).toHaveTextContent('/api/v1/documents/report-one/pdf · 第 3 页')
  expect(screen.getByRole('dialog', { name: '引用研报原文' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '在新窗口打开' })).toHaveAttribute('href', '/api/v1/documents/report-one/pdf#page=3')
  expect(fetcher).not.toHaveBeenCalled()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(link).toHaveFocus()
})
