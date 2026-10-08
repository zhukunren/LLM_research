import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import ResearchAnswer from './ResearchAnswer'
import AnswerSources from './AnswerSources'
import ActiveTasks from '../ActiveTasks'
import type { Conversation } from '../../api'

vi.mock('./ProjectMembership', () => ({ default: () => <span>项目归属</span> }))
const timestamp = '2026-10-05T00:00:00Z'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function restore(content: string, failed = false) {
  const stored: Conversation = { id: 'research', task_id: 'research', entry_scope: 'report', workflow_type: 'research', project_id: null, task_revision: 0, active_run_id: null, pending_execution: false, state: 'active', research_scope: { as_of: '2026-09-28', stock_codes: [] },
    messages: [{ id: 'question', role: 'user', content: '核对现金流', source_refs: [], created_at: timestamp }, { id: 'answer', role: 'assistant', content, source_refs: [], created_at: timestamp }],
    turns: [{ id: 'turn', user_message_id: 'question', base_revision: 0, state: failed ? 'failed' : 'succeeded', response_text: content, result: {}, created_at: timestamp, updated_at: timestamp }], created_at: timestamp, updated_at: timestamp }
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (options?.method === 'POST') { writes.push(path); return json({ id: 'note', project_id: 'inbox' }) }
    return json(path === '/api/v1/conversations' ? { items: [{ ...stored, title: '现金流研究' }] } : path === '/api/v1/conversations/research' ? stored : { items: [] })
  }))
  return writes
}

it('shows a recoverable failure without exposing logs as a research answer or offering result actions', async () => {
  const writes = restore('Codex 运行失败：process closed stdout. stderr_tail=拒绝访问。', true)
  render(<ConversationWorkspace initialScope="report" initialConversationId="research" />)
  expect(await screen.findByText('研究服务暂时无法启动')).toBeInTheDocument()
  expect(screen.getByText('查看技术详情').closest('details')).not.toHaveAttribute('open')
  for (const name of ['转为选股草稿', '加入观察', '保存为研究笔记', '复制答复']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重新处理' })).toBeEnabled()
  expect(writes).toHaveLength(0)
})

it('saves an independent answer to the inbox without changing project membership or starting research', async () => {
  const writes = restore('经营改善仍需核对现金流。')
  const openProject = vi.fn(), user = userEvent.setup()
  render(<ConversationWorkspace initialScope="report" initialConversationId="research" onOpenProject={openProject} />)
  await user.click(await screen.findByRole('button', { name: '保存为研究笔记' }))
  await screen.findByText(/研究笔记已保存/)
  await user.click(screen.getByRole('button', { name: '查看笔记' }))
  expect(openProject).toHaveBeenCalledWith('inbox')
  expect(writes).toEqual(['/api/v1/conversations/research/notes/from-message'])
  await user.click(screen.getByRole('button', { name: '研究对话选项' }))
  expect(screen.getByRole('dialog', { name: '项目归属' })).toBeInTheDocument()
})

it('keeps long research answers readable without opening nested sections', async () => {
  const content = `## 核心结论\n经营判断需要进一步核对。\n\n## 原文依据\n${'来自经营公告的证据。'.repeat(150)}\n\n## 反证与风险\n现金流可能恶化。\n\n\`\`\`python\n# 这不是章节\nprint(1)\n\`\`\``
  const { container } = render(<ResearchAnswer conversationId="research" messageId="answer" content={content} />)
  expect(container.querySelector('.answer-section')).toBeNull()
  expect(screen.getByRole('heading', { name: '原文依据' })).toBeVisible()
  expect(screen.getByText(/来自经营公告的证据/)).toBeVisible()
  expect(screen.getByText(/现金流可能恶化/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '这不是章节' })).not.toBeInTheDocument()
  expect(screen.getByText('代码与数据').closest('details')).not.toHaveAttribute('open')
})

it('opens a report at its cited page and reads the exact referenced news without altering it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ title: '经营公告', body: '原始披露内容', source: '公司公告', published_at: timestamp })))
  const user = userEvent.setup()
  render(<AnswerSources references={[{ kind: 'report_page', source_id: 'report', title: '经营分析', page_number: 3 }, { kind: 'news_item', source_id: 'news', title: '经营公告' }]} />)
  await user.click(screen.getByText('资料来源 · 2'))
  expect(screen.getByRole('link', { name: '经营分析 · 第 3 页' })).toHaveAttribute('href', '/api/v1/documents/report/pdf#page=3')
  await user.click(screen.getByRole('button', { name: '经营公告 · 查看原文' }))
  await screen.findByText('原始披露内容')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '经营公告 · 查看原文' })).toHaveFocus()
})

it('returns to a running task without sending a new prompt and restores keyboard focus on close', async () => {
  const fetcher = vi.fn(async () => json({ active_count: 1, items: [{ id: 'job:ongoing', title: '订单研究', kind: 'research_turn', kind_label: '研究对话', state: 'running', state_label: '处理中', stage: '正在核对原文。', updated_at: timestamp, action_label: '查看进展', destination: { kind: 'conversation', conversation_id: 'ongoing', scope: 'report' } }] }))
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup(), open = vi.fn()
  render(<ActiveTasks onConversation={open} />)
  await user.click(screen.getByRole('button', { name: '运行任务' }))
  await user.click(await screen.findByRole('button', { name: /订单研究/ }))
  expect(open).toHaveBeenCalledWith('ongoing', 'report')
  expect(fetcher.mock.calls[0]).toBeDefined()
  expect(screen.getByRole('button', { name: '运行任务' })).toHaveFocus()
})
