import { useEffect } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import LibraryWorkspace from './LibraryWorkspace'
import type { LibrarySeed } from '../libraryContext'

vi.mock('./ReportPage', () => ({ default: ({ onDescribe, onDefineCondition, onSourceChange }: { onDescribe: (seed: Omit<LibrarySeed, 'id'>) => void; onDefineCondition: (seed: Omit<LibrarySeed, 'id'>) => void; onSourceChange: (source: unknown) => void }) => {
  useEffect(() => { onSourceChange({ reference: { kind: 'report_page', source_id: 'report', page_number: 3 }, label: '订单研究 · 第3页' }) }, [onSourceChange])
  return <><button onClick={() => onDescribe({ source_document_id: 'report', source_page: 3, title: '订单研究' })}>研究此页</button><button onClick={() => onDefineCondition({ source_document_id: 'report', source_page: 3, title: '订单研究' })}>据此定义条件</button></>
} }))
vi.mock('./NewsPage', () => ({ default: ({ onSourceChange }: { onSourceChange: (source: unknown) => void }) => {
  useEffect(() => { onSourceChange({ reference: { kind: 'news_item', source_id: 'news-1' }, label: '订单资讯' }) }, [onSourceChange])
  return <p>当前资讯</p>
} }))
vi.mock('./WorkbenchPage', () => ({ default: ({ view }: { view: string }) => <p>条件工具视图：{view}</p> }))

it('unifies reading categories and removes duplicated condition workspaces', async () => {
  const user = userEvent.setup(), onConversation = vi.fn(), onBrowseChange = vi.fn()
  render(<LibraryWorkspace scope="report" data={null} onCompose={vi.fn()} onConversation={onConversation} onSettings={vi.fn()} onBrowseChange={onBrowseChange} />)
  expect(screen.getByRole('heading', { name: '资料库' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '选股与条件工具' })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: '创建条件' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '资讯' }))
  expect(onBrowseChange).toHaveBeenCalledWith('news')
  expect(onConversation).not.toHaveBeenCalled()
})

it('old advanced-view preferences no longer hide the original reading surface', async () => {
  sessionStorage.setItem('library.report.tab', JSON.stringify('library'))
  render(<LibraryWorkspace scope="report" data={null} onCompose={vi.fn()} onConversation={vi.fn()} onSettings={vi.fn()} />)
  expect(await screen.findByRole('button', { name: '研究此页' })).toBeInTheDocument()
  expect(screen.queryByText('条件工具视图：library')).not.toBeInTheDocument()
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

it.each(['report', 'news'] as const)('attaches the currently selected %s to header research', async scope => {
  const onConversation = vi.fn()
  render(<LibraryWorkspace scope={scope} data={null} onCompose={vi.fn()} onConversation={onConversation} onSettings={vi.fn()} />)
  await screen.findByText(scope === 'report' ? '研究此页' : '当前资讯')
  await userEvent.click(screen.getByRole('button', { name: '发起研究' }))
  expect(onConversation).toHaveBeenCalledWith(scope, scope === 'report'
    ? { reference: { kind: 'report_page', source_id: 'report', page_number: 3 }, label: '订单研究 · 第3页' }
    : { reference: { kind: 'news_item', source_id: 'news-1' }, label: '订单资讯' }, undefined, 'research')
})
