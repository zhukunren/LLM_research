import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import type { ResearchProject, ResearchNote } from '../research'
import ResearchProjectsPage from './ResearchProjectsPage'

vi.mock('../api', () => ({ api: vi.fn() }))
vi.mock('../components/StockSearch', () => ({ default: ({ onChange }: { onChange: (value: string) => void }) => <button onClick={() => onChange('600519.SH')}>选择贵州茅台</button>, StockName: ({ code }: { code: string }) => <span>{code}</span> }))

function existing(): ResearchProject {
  return { id: 'p1', name: '白酒盈利改善', objective: '核对经营兑现', status: 'active', revision: 1, updated_at: '2026-10-03T08:00:00Z', companies: [], conversations: [], notes: [] }
}
const summary = (project: ResearchProject) => ({ ...project, company_count: project.companies.length, note_count: project.notes.length, conversation_count: project.conversations.length })

describe('ResearchProjectsPage', () => {
  it('creates a persistent project, associates a company and starts a conversation in that project', async () => {
    const user = userEvent.setup()
    let project: ResearchProject | null = null
    const open = vi.fn()
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === '/research-projects' && init?.method === 'POST') { project = { ...existing(), ...JSON.parse(String(init.body)) }; return project as never }
      if (path === '/research-projects') return { items: project ? [summary(project)] : [] } as never
      if (path.endsWith('/files')) return { items: [] } as never
      if (path.endsWith('/companies')) { project = { ...project!, companies: [{ stock_code: '600519.SH', name: '贵州茅台' }] }; return project as never }
      if (path === '/conversations') { expect(JSON.parse(String(init?.body))).toMatchObject({ project_id: 'p1', research_mode: 'research' }); return { id: 'c1', entry_scope: 'screening' } as never }
      if (path === '/research-projects/p1') return project as never
      throw new Error(path)
    })
    render(<ResearchProjectsPage onOpenConversation={open} />)
    await screen.findByText('从一个研究问题开始')
    await user.click(screen.getByRole('button', { name: '创建第一个项目' }))
    await user.type(screen.getByRole('textbox', { name: '项目名称' }), '白酒盈利改善')
    await user.type(screen.getByRole('textbox', { name: '研究目标' }), '核对经营兑现')
    await user.click(screen.getByRole('button', { name: '保存项目' }))
    await screen.findByRole('heading', { name: '白酒盈利改善' })
    await user.click(screen.getByRole('button', { name: '选择贵州茅台' }))
    await user.click(screen.getByRole('button', { name: '加入' }))
    await screen.findByRole('button', { name: '600519.SH' })
    await user.click(screen.getByRole('button', { name: '开始研究' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('c1', 'screening'))
  })

  it('preserves unsaved note content across navigation and prevents a stale save from silently overwriting newer content', async () => {
    const user = userEvent.setup()
    let project = existing()
    const note: ResearchNote = { id: 'n1', project_id: 'p1', title: '收入兑现', body: '原笔记', stock_code: null, validation_plan: '', invalidation_condition: '', status: 'watching', revision: 1, source_conversation_id: null, source_message_id: null, updated_at: project.updated_at }
    project.notes = [note]
    let conflicts = false
    const writes: Record<string, unknown>[] = []
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === '/research-projects') return { items: [summary(project)] } as never
      if (path.endsWith('/files')) return { items: [] } as never
      if (path.endsWith('/notes/n1') && init?.method === 'PATCH') {
        writes.push(JSON.parse(String(init.body)))
        if (!conflicts) { conflicts = true; project = { ...project, notes: [{ ...note, body: '另一处的最新研究', revision: 2 }] }; throw new Error('这份笔记已在另一处修改。当前输入仍保留。') }
        return {} as never
      }
      if (path === '/research-projects/p1') return project as never
      throw new Error(path)
    })
    render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
    await screen.findByRole('heading', { name: '收入兑现' })
    await user.click(screen.getByRole('button', { name: '编辑笔记 收入兑现' }))
    await user.clear(screen.getByRole('textbox', { name: '研究内容' }))
    await user.type(screen.getByRole('textbox', { name: '研究内容' }), '我的待合并研究')
    await user.click(screen.getByRole('button', { name: '关闭编辑' }))
    await user.click(screen.getByRole('button', { name: '编辑笔记 收入兑现' }))
    expect(screen.getByRole('textbox', { name: '研究内容' })).toHaveValue('我的待合并研究')
    await user.click(screen.getByRole('button', { name: '保存笔记' }))
    await screen.findByText('另一处的最新研究')
    expect(screen.getByRole('textbox', { name: '研究内容' })).toHaveValue('我的待合并研究')
    expect(screen.getByRole('button', { name: '保存笔记' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '继续合并我的修改' }))
    await user.click(screen.getByRole('button', { name: '保存笔记' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[0]).toMatchObject({ base_revision: 1, body: '我的待合并研究' })
    expect(writes[1]).toMatchObject({ base_revision: 2, body: '我的待合并研究' })
  })

  it('keeps duplicate filenames from different conversations distinct and offers source conversation recovery', async () => {
    const user = userEvent.setup()
    const project = existing()
    project.notes = [{ id: 'n1', project_id: 'p1', title: '旧对话成果', body: '[结果](outputs/result.csv)', stock_code: null, validation_plan: '', invalidation_condition: '', status: 'watching', revision: 1, source_conversation_id: 'old', source_message_id: 'a1', updated_at: project.updated_at }]
    const open = vi.fn()
    vi.mocked(api).mockImplementation(async path => {
      if (path === '/research-projects') return { items: [summary(project)] } as never
      if (path.endsWith('/files')) return { items: ['c1', 'c2'].map(conversation_id => ({ name: 'result.csv', bytes: 100, modified_at: 1791014400, conversation_id, url: `/api/v1/conversations/${conversation_id}/research-files/result.csv` })) } as never
      if (path === '/conversations/old') return { id: 'old', entry_scope: 'report' } as never
      return project as never
    })
    render(<ResearchProjectsPage onOpenConversation={open} />)
    await screen.findByRole('heading', { name: '旧对话成果' })
    expect(screen.getByRole('link', { name: '结果' })).toHaveAttribute('href', '/api/v1/conversations/old/research-files/result.csv')
    await user.click(screen.getByRole('button', { name: '查看原对话' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('old', 'report'))
    await user.click(screen.getByRole('tab', { name: /研究成果/ }))
    const downloads = screen.getAllByRole('link', { name: /result.csv/ })
    expect(downloads).toHaveLength(2)
    expect(downloads[0].getAttribute('href')).not.toBe(downloads[1].getAttribute('href'))
  })
})
