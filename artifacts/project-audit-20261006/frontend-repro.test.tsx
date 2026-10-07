import { render, screen, waitFor } from '../../apps/web/node_modules/@testing-library/react/dist/index.js'
import userEvent from '../../apps/web/node_modules/@testing-library/user-event/dist/esm/index.js'
import { expect, it, vi } from 'vitest'
import { api } from '../../apps/web/src/api'
import ConversationWorkspace from '../../apps/web/src/components/conversation/ConversationWorkspace'
import ResearchProjectsPage from '../../apps/web/src/pages/ResearchProjectsPage'

vi.mock('../../apps/web/src/api', async importOriginal => ({ ...await importOriginal<typeof import('../../apps/web/src/api')>(), api: vi.fn() }))
vi.mock('../../apps/web/src/components/StockSearch', () => ({ default: () => null, StockName: ({ code }: { code: string }) => <span>{code}</span> }))

const date = '2026-10-06T08:00:00Z'
const emptyConversation = { id: 'created', task_id: 'created', entry_scope: 'screening', workflow_type: 'research', task_revision: 0, active_run_id: null, pending_execution: false, state: 'active', messages: [], turns: [], created_at: date, updated_at: date }
const existingProject = () => ({ id: 'p1', name: '审查测试项目', objective: '', status: 'active', revision: 1, updated_at: date, companies: [], conversations: [], notes: [{ id: 'n1', project_id: 'p1', title: '审查测试笔记', body: '原文', stock_code: null, validation_plan: '', invalidation_condition: '', status: 'watching', revision: 1, source_conversation_id: null, source_message_id: null, updated_at: date }] })
const summary = (project: ReturnType<typeof existingProject>) => ({ ...project, company_count: 0, note_count: project.notes.length, conversation_count: 0 })

it('keeps a first unsent question visible after creation succeeds but message POST fails', async () => {
  const user = userEvent.setup()
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/conversations') return (init?.method === 'POST' ? emptyConversation : { items: [] }) as never
    if (path === '/conversations/created/messages') throw new Error('测试：消息未保存')
    if (path === '/conversations/created') return emptyConversation as never
    return { items: [] } as never
  })
  render(<ConversationWorkspace />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '必须保留的首次研究问题')
  await user.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByText('测试：消息未保存')
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getByLabelText('研究要求')).toHaveValue('必须保留的首次研究问题')
})

it('clears a saved note draft before unmount so reopening uses the current revision', async () => {
  const user = userEvent.setup()
  let project = existingProject()
  const revisions: number[] = []
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/research-projects') return { items: [summary(project)] } as never
    if (path.endsWith('/files')) return { items: [] } as never
    if (path === '/research-projects/p1/notes/n1' && init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body))
      revisions.push(payload.base_revision)
      project = { ...project, notes: [{ ...project.notes[0], ...payload, revision: 2 }] }
      return project.notes[0] as never
    }
    if (path === '/research-projects/p1') return project as never
    return { items: [] } as never
  })
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '编辑笔记 审查测试笔记' }))
  await user.clear(screen.getByLabelText('研究内容'))
  await user.type(screen.getByLabelText('研究内容'), '第一批内容')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('第一批内容')
  await user.click(await screen.findByRole('button', { name: '编辑笔记 审查测试笔记' }))
  await user.type(screen.getByLabelText('研究内容'), '；第二批内容')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await waitFor(() => expect(revisions).toHaveLength(2))
  expect(revisions).toEqual([1, 2])
})

it('uses a fresh request identity when changing a new note after a lost save response', async () => {
  const user = userEvent.setup()
  const project = { ...existingProject(), notes: [] }
  const writes: Record<string, unknown>[] = []
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/research-projects') return { items: [summary(project)] } as never
    if (path.endsWith('/files')) return { items: [] } as never
    if (path === '/research-projects/p1/notes' && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      throw new Error(writes.length === 1 ? '测试：保存响应丢失' : '相同保存请求不能使用不同的笔记内容。')
    }
    if (path === '/research-projects/p1') return project as never
    return { items: [] } as never
  })
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '写研究笔记' }))
  await user.type(screen.getByLabelText('笔记标题'), '新笔记')
  await user.type(screen.getByLabelText('研究内容'), '第一版')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('测试：保存响应丢失')
  await user.type(screen.getByLabelText('研究内容'), '增加补充')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('相同保存请求不能使用不同的笔记内容。')
  expect(writes).toHaveLength(2)
  expect(writes[1].request_id).not.toBe(writes[0].request_id)
})

it('starts the next new note with an empty draft after a successful new note save', async () => {
  const user = userEvent.setup()
  let project = { ...existingProject(), notes: [] as ReturnType<typeof existingProject>['notes'] }
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/research-projects') return { items: [summary(project)] } as never
    if (path.endsWith('/files')) return { items: [] } as never
    if (path === '/research-projects/p1/notes' && init?.method === 'POST') {
      const content = JSON.parse(String(init.body))
      const note = { ...existingProject().notes[0], ...content, title: content.title, body: content.body }
      project = { ...project, notes: [note] }
      return note as never
    }
    if (path === '/research-projects/p1') return project as never
    return { items: [] } as never
  })
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '写研究笔记' }))
  await user.type(screen.getByLabelText('笔记标题'), '已经保存的新笔记')
  await user.type(screen.getByLabelText('研究内容'), '已经保存的正文')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('已经保存的正文')
  await user.click(screen.getByRole('button', { name: '写研究笔记' }))
  expect(screen.getByLabelText('笔记标题')).toHaveValue('')
  expect(screen.getByLabelText('研究内容')).toHaveValue('')
})
