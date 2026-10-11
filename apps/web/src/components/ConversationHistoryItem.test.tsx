import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import ConversationHistoryItem, { type RecentConversation } from './ConversationHistoryItem'

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: vi.fn() }))
const item: RecentConversation = { id: 'research-one', title: '研究现金流', entry_scope: 'screening', workflow_type: 'research', state: 'active' }
function setup(overrides: Partial<RecentConversation> = {}) {
  const onOpen = vi.fn(), onChange = vi.fn(), user = userEvent.setup()
  render(<ConversationHistoryItem item={{ ...item, ...overrides }} current={false} onOpen={onOpen} onChange={onChange} />)
  return { user, onOpen, onChange }
}
async function open(user: ReturnType<typeof userEvent.setup>) { await user.click(screen.getByRole('button', { name: '更多操作：研究现金流' })) }

it('opens all six actions without navigating and restores focus on Escape', async () => {
  const { user, onOpen } = setup()
  await open(user)
  for (const name of ['重命名', '置顶', '分享', '归档', '删除', '移至项目']) expect(screen.getByRole('menuitem', { name })).toBeInTheDocument()
  expect(onOpen).not.toHaveBeenCalled()
  expect(screen.getByRole('menuitem', { name: '重命名' })).toHaveFocus()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('menuitem', { name: '置顶' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '更多操作：研究现金流' })).toHaveFocus()
})

it('closes the menu when clicking outside', async () => {
  const { user } = setup()
  await open(user)
  await user.click(document.body)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('does not render a zero when the stored pin flag is numeric', () => {
  setup({ pinned: 0 as unknown as boolean })
  expect(document.querySelector('.chat-history-row')?.textContent).toBe('研究现金流')
})

it('renames a conversation and prevents blank titles', async () => {
  vi.mocked(api).mockResolvedValue({} as never)
  const { user, onChange } = setup()
  await open(user); await user.click(screen.getByRole('menuitem', { name: '重命名' }))
  const input = screen.getByRole('textbox', { name: '对话名称' })
  expect(input).toHaveFocus()
  await user.clear(input)
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  await user.type(input, ' 新研究名称 '); await user.keyboard('{Enter}')
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(item.id, { title: '新研究名称' }))
  expect(api).toHaveBeenCalledWith('/conversations/research-one', { method: 'PATCH', body: JSON.stringify({ title: '新研究名称' }) })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('keeps failed mutations visible without changing history', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('保存失败，请重试'))
  const { user, onChange } = setup()
  await open(user); await user.click(screen.getByRole('menuitem', { name: '置顶' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败，请重试')
  expect(screen.getByRole('menu')).toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
  vi.mocked(api).mockResolvedValueOnce({} as never)
  await user.click(screen.getByRole('menuitem', { name: '置顶' }))
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(item.id, { pinned: true }))
})

it('offers unpin and restores archived conversations', async () => {
  vi.mocked(api).mockResolvedValue({} as never)
  const { user, onChange } = setup({ pinned: true, state: 'archived' })
  expect(screen.getByLabelText('已置顶')).toBeInTheDocument()
  await open(user)
  expect(screen.getByRole('menuitem', { name: '取消置顶' })).toBeInTheDocument()
  await user.click(screen.getByRole('menuitem', { name: '恢复对话' }))
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(item.id, { state: 'active' }))
})

it('requires delete confirmation and allows cancellation', async () => {
  vi.mocked(api).mockResolvedValue({} as never)
  const { user, onChange } = setup()
  await open(user); await user.click(screen.getByRole('menuitem', { name: '删除' }))
  expect(api).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: '删除对话' })).toHaveTextContent('已保存的研究笔记会保留')
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(onChange).not.toHaveBeenCalled()
  await open(user); await user.click(screen.getByRole('menuitem', { name: '删除' })); await user.click(screen.getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(item.id, { deleted: true }))
  expect(api).toHaveBeenCalledWith('/conversations/research-one', { method: 'DELETE', body: undefined })
})

it('loads active projects and moves without opening the conversation', async () => {
  vi.mocked(api).mockImplementation(async path => path === '/research-projects' ? { items: [
    { id: 'active', name: '产业链', status: 'active' }, { id: 'archived', name: '旧项目', status: 'archived' },
  ] } as never : {} as never)
  const { user, onChange, onOpen } = setup()
  await open(user); await user.click(screen.getByRole('menuitem', { name: '移至项目' }))
  await user.click(await screen.findByRole('menuitemradio', { name: '产业链' }))
  expect(screen.queryByRole('menuitemradio', { name: '旧项目' })).not.toBeInTheDocument()
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(item.id, { project_id: 'active' }))
  expect(api).toHaveBeenCalledWith('/conversations/research-one/project', { method: 'PATCH', body: JSON.stringify({ project_id: 'active' }) })
  expect(onOpen).not.toHaveBeenCalled()
})

it('creates a public snapshot for the latest answer and provides a download', async () => {
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/conversations/research-one') return { messages: [{ id: 'latest-answer', role: 'assistant' }] } as never
    return (init?.method === 'POST' ? { id: 'share', url: 'https://share.example.test/s/token' } : { share: null }) as never
  })
  const { user } = setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  await open(user); await user.click(screen.getByRole('menuitem', { name: '分享' }))
  await user.click(await screen.findByRole('button', { name: '创建分享链接' }))
  expect((await screen.findByRole('textbox', { name: '对话链接' }) as HTMLInputElement).value).toBe('https://share.example.test/s/token')
  expect(screen.getByRole('link', { name: '下载对话' })).toHaveAttribute('href', '/api/v1/conversations/research-one/export')
  await user.click(screen.getByRole('button', { name: '复制链接' }))
  expect(writeText).toHaveBeenCalledWith('https://share.example.test/s/token')
  expect(await screen.findByRole('status')).toHaveTextContent('对话链接已复制')
})

it('disables destructive operations and reassignment while a task is active', async () => {
  const { user } = setup({ last_turn_state: 'running' })
  await open(user)
  for (const name of ['归档', '删除', '移至项目']) expect(screen.getByRole('menuitem', { name })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '重命名' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '分享' })).toBeEnabled()
})
