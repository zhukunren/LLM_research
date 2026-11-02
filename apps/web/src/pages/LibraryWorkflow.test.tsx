import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import LibraryWorkspace from './LibraryWorkspace'
import type { LibrarySeed } from '../libraryContext'
import LibraryReadingActions from '../components/LibraryReadingActions'
vi.mock('../components/conversation/ConversationWorkspace', () => ({ default: ({ initialScope, initialWorkflowType, initialSource, initialPrompt }: { initialScope: string; initialWorkflowType: string; initialSource: unknown; initialPrompt: string }) => <><p data-testid="quick-workflow">{initialWorkflowType}</p><p data-testid="quick-scope">{initialScope}</p><p data-testid="quick-source">{JSON.stringify(initialSource)}</p><p data-testid="quick-prompt">{initialPrompt}</p></> }))

vi.mock('./ReportPage', () => ({ default: ({ onDescribe, onDefineCondition }: { onDescribe: (seed: Omit<LibrarySeed, 'id'>) => void; onDefineCondition: (seed: Omit<LibrarySeed, 'id'>) => void }) => {
  return <LibraryReadingActions onResearch={() => onDescribe({ source_document_id: 'report', source_page: 3, title: '订单研究' })} onScreening={() => onDefineCondition({ source_document_id: 'report', source_page: 3, title: '订单研究' })} />
} }))
vi.mock('./NewsPage', () => ({ default: ({ onDiscuss, onDefineCondition }: { onDiscuss: (item: { id: string; title: string }) => void; onDefineCondition: (item: { id: string; title: string }) => void }) => {
  return <LibraryReadingActions onResearch={() => onDiscuss({ id: 'news-1', title: '订单资讯' })} onScreening={() => onDefineCondition({ id: 'news-1', title: '订单资讯' })} />
} }))
vi.mock('../components/DisclosuresPanel', () => ({ default: ({ onDescribe, onDefineCondition }: { onDescribe: (seed: Omit<LibrarySeed, 'id'>) => void; onDefineCondition: (seed: Omit<LibrarySeed, 'id'>) => void }) => <LibraryReadingActions onResearch={() => onDescribe({ source_document_id: 'disclosure-document', source_page: 2, title: '原始年报' })} onScreening={() => onDefineCondition({ source_document_id: 'disclosure-document', source_page: 2, title: '原始年报' })} /> }))
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
  expect(await screen.findByRole('button', { name: '研究当前资料' })).toBeInTheDocument()
  expect(screen.queryByText('条件工具视图：library')).not.toBeInTheDocument()
})

it('keeps reading research distinct from defining a screening condition from the same original page', async () => {
  const onConversation = vi.fn()
  const user = userEvent.setup()
  render(<LibraryWorkspace scope="report" data={null} onCompose={vi.fn()} onConversation={onConversation} onSettings={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '研究当前资料' }))
  expect(await screen.findByTestId('quick-workflow')).toHaveTextContent('research')
  expect(screen.getByTestId('quick-prompt')).toHaveTextContent('区分事实、预测和推断')
  expect(screen.getByTestId('quick-prompt')).not.toHaveTextContent('选股条件')
  const source = screen.getByTestId('quick-source').textContent
  expect(JSON.parse(source!).reference).toEqual({ kind: 'report_page', source_id: 'report', page_number: 3 })
  await user.click(screen.getByRole('button', { name: '关闭资料助手' }))
  await user.click(screen.getByRole('button', { name: '用于选股' }))
  expect(await screen.findByTestId('quick-workflow')).toHaveTextContent('screening')
  expect(screen.getByTestId('quick-prompt')).toHaveTextContent('先形成草稿')
  expect(screen.getByTestId('quick-source').textContent).toEqual(source)
  expect(onConversation).not.toHaveBeenCalled()
})

it.each(['report', 'news'] as const)('attaches the selected %s to the reading actions and removes header research', async scope => {
  const onConversation = vi.fn()
  render(<LibraryWorkspace scope={scope} data={null} onCompose={vi.fn()} onConversation={onConversation} onSettings={vi.fn()} />)
  expect(screen.queryByRole('button', { name: '发起研究' })).not.toBeInTheDocument()
  await userEvent.click(await screen.findByRole('button', { name: '研究当前资料' }))
  expect(await screen.findByTestId('quick-scope')).toHaveTextContent(scope)
  expect(JSON.parse(screen.getByTestId('quick-source').textContent!)).toEqual(scope === 'report'
    ? { reference: { kind: 'report_page', source_id: 'report', page_number: 3 }, label: '订单研究 · 第3页' }
    : { reference: { kind: 'news_item', source_id: 'news-1' }, label: '订单资讯' })
  expect(onConversation).not.toHaveBeenCalled()
})

it('uses the original disclosure document and physical page even when opened from news', async () => {
  const onConversation = vi.fn(), user = userEvent.setup()
  render(<LibraryWorkspace scope="news" data={null} onCompose={vi.fn()} onConversation={onConversation} onSettings={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: '原始披露' }))
  await user.click(await screen.findByRole('button', { name: '研究当前资料' }))
  expect(await screen.findByTestId('quick-scope')).toHaveTextContent('report')
  const source = screen.getByTestId('quick-source').textContent
  expect(JSON.parse(source!)).toEqual({ reference: { kind: 'report_page', source_id: 'disclosure-document', page_number: 2 }, label: '原始年报 · 第2页' })
  await user.click(screen.getByRole('button', { name: '关闭资料助手' }))
  await user.click(screen.getByRole('button', { name: '用于选股' }))
  expect(await screen.findByTestId('quick-workflow')).toHaveTextContent('screening')
  expect(screen.getByTestId('quick-source').textContent).toEqual(source)
  expect(onConversation).not.toHaveBeenCalled()
})
