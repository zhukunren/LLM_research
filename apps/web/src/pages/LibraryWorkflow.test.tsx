import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import LibraryWorkspace from './LibraryWorkspace'
import type { LibrarySeed } from '../libraryContext'

vi.mock('./ReportPage', () => ({ default: ({ onDescribe, onDefineCondition }: { onDescribe: (seed: Omit<LibrarySeed, 'id'>) => void; onDefineCondition: (seed: Omit<LibrarySeed, 'id'>) => void }) => <><button onClick={() => onDescribe({ source_document_id: 'report', source_page: 3, title: '订单研究' })}>研究此页</button><button onClick={() => onDefineCondition({ source_document_id: 'report', source_page: 3, title: '订单研究' })}>据此定义条件</button></> }))
vi.mock('./WorkbenchPage', () => ({ default: ({ view }: { view: string }) => <p>条件工具视图：{view}</p> }))

it('starts with reading and progressively reveals reusable condition tools', async () => {
  const user = userEvent.setup(), onConversation = vi.fn()
  render(<LibraryWorkspace scope="report" data={null} onCompose={vi.fn()} onConversation={onConversation} onSettings={vi.fn()} />)
  expect(screen.queryByRole('tab', { name: '创建条件' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '选股与条件工具' }))
  await user.click(screen.getByRole('tab', { name: '创建条件' }))
  expect(screen.getByText('条件工具视图：create')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '收起高级工具' }))
  expect(await screen.findByRole('button', { name: '研究此页' })).toBeInTheDocument()
  expect(onConversation).not.toHaveBeenCalled()
})

it('restores an existing advanced condition view after refresh', () => {
  sessionStorage.setItem('library.report.tab', JSON.stringify('library'))
  render(<LibraryWorkspace scope="report" data={null} onCompose={vi.fn()} onConversation={vi.fn()} onSettings={vi.fn()} />)
  expect(screen.getByRole('tab', { name: '独立条件库' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('button', { name: '收起高级工具' })).toHaveAttribute('aria-expanded', 'true')
})

it('keeps reading research distinct from defining a screening condition from the same original page', async () => {
  const onConversation = vi.fn()
  const user = userEvent.setup()
  render(<LibraryWorkspace scope="report" data={null} onCompose={vi.fn()} onConversation={onConversation} onSettings={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '研究此页' }))
  const researchCall = onConversation.mock.calls[0]
  expect(researchCall[3]).toBe('research')
  expect(researchCall[2]).toContain('区分事实、预测和推断')
  expect(researchCall[2]).not.toContain('选股条件')
  await user.click(screen.getByRole('button', { name: '据此定义条件' }))
  expect(onConversation.mock.calls[1][3]).toBe('screening')
  expect(onConversation.mock.calls[1][2]).toContain('先形成草稿')
  expect(onConversation.mock.calls[1][1]).toEqual(researchCall[1])
  expect(researchCall[1].reference).toEqual({ kind: 'report_page', source_id: 'report', page_number: 3 })
})
