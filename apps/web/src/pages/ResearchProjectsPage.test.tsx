import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import type { ResearchProject, ResearchNote } from '../research'
import ResearchProjectsPage from './ResearchProjectsPage'
import { useWorkspaceRoute } from '../useWorkspaceRoute'

afterEach(() => window.history.replaceState(null, '', '/'))

function HistoryProjectPage() {
  const { route, navigate } = useWorkspaceRoute()
  return <ResearchProjectsPage initialProjectId={route.projectId} onOpenConversation={vi.fn()} onLocationChange={id => navigate({ page: 'research', projectId: id })} />
}

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: vi.fn() }))
vi.mock('../components/StockSearch', () => ({ default: ({ onChange }: { onChange: (value: string) => void }) => <button onClick={() => onChange('600519.SH')}>选择贵州茅台</button>, StockName: ({ code }: { code: string }) => <span>{code}</span> }))

function existing(): ResearchProject {
  return { id: 'p1', name: '白酒盈利改善', objective: '核对经营兑现', status: 'active', revision: 1, updated_at: '2026-10-03T08:00:00Z', companies: [], conversations: [], notes: [] }
}
const summary = (project: ResearchProject) => ({ ...project, company_count: project.companies.length, note_count: project.notes.length, conversation_count: project.conversations.length })

describe('ResearchProjectsPage', () => {
  it('restores explicit project identity across prop navigation and never substitutes another project for a missing URL object', async () => {
    const first = existing(), second = { ...existing(), id: 'p2', name: '第二研究项目' }
    const location = vi.fn()
    vi.mocked(api).mockImplementation(async path => {
      if (path === '/research-projects') return { items: [summary(first), summary(second)] } as never
      if (path.endsWith('/files')) return { items: [] } as never
      if (path === '/research-projects/missing') throw new Error('找不到研究项目。')
      return (path.endsWith('/p2') ? second : first) as never
    })
    const view = render(<ResearchProjectsPage initialProjectId="p2" onLocationChange={location} onOpenConversation={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: '第二研究项目' })).toBeInTheDocument()
    expect(location).toHaveBeenCalledWith('p2', false)
    view.rerender(<ResearchProjectsPage initialProjectId="p1" onLocationChange={location} onOpenConversation={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: '白酒盈利改善' })).toBeInTheDocument()
    view.rerender(<ResearchProjectsPage initialProjectId="missing" onLocationChange={location} onOpenConversation={vi.fn()} />)
    expect(await screen.findByText('找不到研究项目。')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '白酒盈利改善' })).not.toBeInTheDocument()
    expect(location).not.toHaveBeenCalledWith('missing', false)
    expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it.each(['existing', 'new', 'project'])('closes the %s editor on browser Back and Forward, preserves its original draft and keeps same-project refresh open', async kind => {
    const user = userEvent.setup()
    const first = existing(), second = { ...existing(), id: 'p2', name: '第二研究项目' }
    const note: ResearchNote = { id: 'n1', project_id: 'p1', title: '收入兑现', body: '原笔记', stock_code: null, validation_plan: '', invalidation_condition: '', status: 'watching', revision: 1, source_conversation_id: null, source_message_id: null, updated_at: first.updated_at }
    first.notes = [note]
    vi.mocked(api).mockImplementation(async path => {
      if (path === '/research-projects') return { items: [summary(first), summary(second)] } as never
      if (path.endsWith('/files') || path.includes('/notes/')) return { items: [] } as never
      return (path.endsWith('/p2') ? second : first) as never
    })
    window.history.replaceState(null, '', '#/projects/p2')
    window.history.pushState(null, '', '#/projects/p1')
    render(<HistoryProjectPage />)
    await screen.findByRole('heading', { name: first.name })
    const openEditor = () => user.click(screen.getByRole('button', { name: kind === 'existing' ? '编辑笔记 收入兑现' : kind === 'new' ? '写研究笔记' : '编辑项目' }))
    const label = kind === 'project' ? '项目名称' : '笔记标题'
    await openEditor()
    await user.clear(screen.getByRole('textbox', { name: label }))
    await user.type(screen.getByRole('textbox', { name: label }), '项目一未保存草稿')
    const input = screen.getByRole('textbox', { name: label })
    await user.click(screen.getByRole('button', { name: '刷新研究项目' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新研究项目' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: label })).toBe(input)
    expect(input).toHaveValue('项目一未保存草稿')
    act(() => window.history.back())
    await screen.findByRole('heading', { name: second.name })
    expect(screen.queryByRole('textbox', { name: label })).not.toBeInTheDocument()
    const drafts = JSON.parse(sessionStorage.getItem(kind === 'project' ? 'research.projectDrafts' : 'research.noteDrafts')!)
    expect(Object.keys(drafts)).toEqual([kind === 'project' ? 'p1' : `p1:${kind === 'new' ? 'new' : 'n1'}`])
    act(() => window.history.forward())
    await screen.findByRole('heading', { name: first.name })
    await openEditor()
    expect(screen.getByRole('textbox', { name: label })).toHaveValue('项目一未保存草稿')
    expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it('keeps an edit targeted at the original project when the center is refreshed', async () => {
    const user = userEvent.setup()
    let project = existing()
    const writes: { path: string; method?: string }[] = []
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === '/research-projects') return { items: [summary(project)] } as never
      if (path.endsWith('/files')) return { items: [] } as never
      if (init?.method === 'PATCH') { writes.push({ path, method: init.method }); project = { ...project, ...JSON.parse(String(init.body)) }; return project as never }
      return project as never
    })
    render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
    await screen.findByRole('heading', { name: '白酒盈利改善' })
    await user.click(screen.getByRole('button', { name: '编辑项目' }))
    await user.clear(screen.getByRole('textbox', { name: '项目名称' }))
    await user.type(screen.getByRole('textbox', { name: '项目名称' }), '刷新保留的名称')
    await user.click(screen.getByRole('button', { name: '刷新研究项目' }))
    expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveValue('刷新保留的名称')
    await user.click(screen.getByRole('button', { name: '保存项目' }))
    await waitFor(() => expect(writes).toEqual([{ path: '/research-projects/p1', method: 'PATCH' }]))
    await screen.findByRole('heading', { name: '刷新保留的名称' })
  })
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
    await screen.findByRole('heading', { name: '暂无研究项目' })
    await user.click(screen.getByRole('button', { name: '新建项目' }))
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
    expect(screen.getByRole('link', { name: '结果' })).toHaveAttribute('href', '/api/v1/conversations/old/generated-files/result.csv')
    await user.click(screen.getByRole('button', { name: '查看原对话' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('old', 'report'))
    await user.click(screen.getByRole('tab', { name: /研究成果/ }))
    const downloads = screen.getAllByRole('link', { name: /result.csv/ })
    expect(downloads).toHaveLength(2)
    expect(downloads[0].getAttribute('href')).not.toBe(downloads[1].getAttribute('href'))
  })
})

it('combines note content and opinion status filters and offers a complete reset', async () => {
  const user = userEvent.setup()
  const project = existing()
  const base: ResearchNote = { id: 'n1', project_id: project.id, title: '订单验证', body: '核对订单兑现', stock_code: null, validation_plan: '联系供应商核对交付', invalidation_condition: '', status: 'watching', revision: 1, source_conversation_id: null, source_message_id: null, updated_at: project.updated_at }
  project.notes = [base, { ...base, id: 'n2', title: '收入兑现', body: '供应商反馈稳定', status: 'supported' }]
  vi.mocked(api).mockImplementation(async path => path === '/research-projects' ? { items: [summary(project)] } as never : path.endsWith('/files') ? { items: [] } as never : path.endsWith('/claims') || path.endsWith('/revisions') ? { items: [] } as never : project as never)
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await screen.findByRole('heading', { name: '订单验证' })
  await user.type(screen.getByRole('searchbox', { name: '搜索研究笔记' }), '供应商')
  expect(screen.getByRole('heading', { name: '订单验证' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '收入兑现' })).toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('筛选笔记状态'), 'supported')
  expect(screen.queryByRole('heading', { name: '订单验证' })).not.toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('筛选笔记状态'), 'invalidated')
  expect(screen.getByRole('button', { name: '查看全部笔记' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: '查看全部笔记' }))
  expect(screen.getByRole('heading', { name: '订单验证' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '收入兑现' })).toBeInTheDocument()
})

it('filters pending judgments directly and changes note order without losing reading controls', async () => {
  const user = userEvent.setup()
  const project = existing()
  const base: ResearchNote = { id: 'n1', project_id: project.id, title: 'A 订单', body: '待核对交付', stock_code: null, validation_plan: '', invalidation_condition: '', status: 'watching', revision: 1, source_conversation_id: null, source_message_id: null, updated_at: '2026-10-03T08:00:00Z' }
  project.notes = [base, { ...base, id: 'n2', title: 'B 收入', body: '已核对毛利', status: 'supported', updated_at: '2026-10-04T08:00:00Z' }]
  vi.mocked(api).mockImplementation(async path => path === '/research-projects' ? { items: [summary(project)] } as never : path.endsWith('/files') || path.endsWith('/claims') || path.endsWith('/revisions') ? { items: [] } as never : project as never)
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  const recent = await screen.findByRole('button', { name: 'B 收入' })
  expect(recent).toHaveAttribute('aria-expanded', 'true')
  expect(screen.queryByRole('group', { name: '项目概览' })).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '观点与验证' })).not.toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('筛选笔记状态'), 'watching')
  expect(screen.queryByRole('button', { name: 'B 收入' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'A 订单' })).toHaveAttribute('aria-expanded', 'true')
  await user.selectOptions(screen.getByLabelText('筛选笔记状态'), '')
  await user.selectOptions(screen.getByLabelText('笔记排序'), 'title')
  const titles = screen.getAllByRole('button', { name: /^(A 订单|B 收入)$/ })
  expect(titles.map(button => button.textContent)).toEqual(['A 订单', 'B 收入'])
  await user.click(titles[0])
  expect(titles[0]).toHaveAttribute('aria-expanded', 'false')
  await user.click(titles[1])
  expect(titles[1]).toHaveAttribute('aria-expanded', 'true')
})

it('offers a catalog retry without showing first-project onboarding when the catalog request fails', async () => {
  vi.mocked(api).mockRejectedValue(new Error('目录服务不可用'))
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await screen.findByText('目录服务不可用')
  expect(screen.queryByRole('heading', { name: '从一个研究问题开始' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
})

const savedNote = (project: ResearchProject): ResearchNote => ({ id: 'n1', project_id: project.id, title: '已保存笔记', body: '原文', stock_code: null, validation_plan: '', invalidation_condition: '', status: 'watching', revision: 1, source_conversation_id: null, source_message_id: null, updated_at: project.updated_at })

it('clears successful note drafts before closing so the next edit uses the saved revision', async () => {
  const user = userEvent.setup()
  let project = existing()
  project.notes = [savedNote(project)]
  const revisions: number[] = []
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/research-projects') return { items: [summary(project)] } as never
    if (path.endsWith('/files') || path.endsWith('/claims') || path.endsWith('/revisions')) return { items: [] } as never
    if (path === '/research-projects/p1/notes/n1' && init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body)); revisions.push(payload.base_revision)
      if (payload.base_revision !== project.notes[0].revision) throw new Error('版本已更新')
      project = { ...project, notes: [{ ...project.notes[0], ...payload, revision: project.notes[0].revision + 1 }] }
      return project.notes[0] as never
    }
    return project as never
  })
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '编辑笔记 已保存笔记' }))
  await user.clear(screen.getByLabelText('研究内容'))
  await user.type(screen.getByLabelText('研究内容'), '第一批内容')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('第一批内容')
  expect(JSON.parse(sessionStorage.getItem('research.noteDrafts')!)).toEqual({})
  await user.click(screen.getByRole('button', { name: '编辑笔记 已保存笔记' }))
  await user.type(screen.getByLabelText('研究内容'), '；第二批内容')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('第一批内容；第二批内容')
  expect(revisions).toEqual([1, 2])
})

it('starts a blank next note and project after successful creation', async () => {
  const user = userEvent.setup()
  let project = existing()
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/research-projects' && init?.method === 'POST') { project = { ...project, ...JSON.parse(String(init.body)) }; return project as never }
    if (path === '/research-projects') return { items: [summary(project)] } as never
    if (path.endsWith('/notes') && init?.method === 'POST') { const note = { ...savedNote(project), ...JSON.parse(String(init.body)) }; project = { ...project, notes: [note] }; return note as never }
    if (path.endsWith('/files') || path.endsWith('/claims') || path.endsWith('/revisions')) return { items: [] } as never
    return project as never
  })
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '写研究笔记' }))
  await user.type(screen.getByLabelText('笔记标题'), '新笔记')
  await user.type(screen.getByLabelText('研究内容'), '已保存的正文')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('已保存的正文')
  await user.click(screen.getByRole('button', { name: '写研究笔记' }))
  expect(screen.getByLabelText('笔记标题')).toHaveValue('')
  expect(screen.getByLabelText('研究内容')).toHaveValue('')
  await user.click(screen.getByRole('button', { name: '关闭编辑' }))
  await user.click(screen.getByRole('button', { name: '新建项目' }))
  await user.type(screen.getByLabelText('项目名称'), '已经保存的新项目')
  await user.click(screen.getByRole('button', { name: '保存项目' }))
  await screen.findByRole('heading', { name: '已经保存的新项目' })
  await user.click(screen.getByRole('button', { name: '新建项目' }))
  expect(screen.getByLabelText('项目名称')).toHaveValue('')
  expect(screen.getByLabelText('研究目标')).toHaveValue('')
  expect(JSON.parse(sessionStorage.getItem('research.projectDrafts')!)).toEqual({})
})

it.each([true, false])('replays an unknown note creation before patching edited content without duplicates (committed=%s)', async committed => {
  const user = userEvent.setup()
  let project = existing()
  const writes: { method: string; body: Record<string, unknown> }[] = []
  let original: Record<string, unknown> | undefined
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/research-projects') return { items: [summary(project)] } as never
    if (path.endsWith('/files') || path.endsWith('/claims') || path.endsWith('/revisions')) return { items: [] } as never
    if (path === '/research-projects/p1/notes' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes.push({ method: 'POST', body })
      if (!original) {
        original = body
        if (committed) project = { ...project, notes: [{ ...savedNote(project), ...body }] }
        throw new Error('保存响应丢失，当前输入保留')
      }
      expect(body).toEqual(original)
      if (!project.notes.length) project = { ...project, notes: [{ ...savedNote(project), ...body }] }
      return project.notes[0] as never
    }
    if (path === '/research-projects/p1/notes/n1' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); writes.push({ method: 'PATCH', body })
      expect(body.base_revision).toBe(1)
      project = { ...project, notes: [{ ...project.notes[0], ...body, revision: 2 }] }
      return project.notes[0] as never
    }
    return project as never
  })
  const view = render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '写研究笔记' }))
  await user.type(screen.getByLabelText('笔记标题'), '新笔记')
  await user.type(screen.getByLabelText('研究内容'), '第一次提交')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('保存响应丢失，当前输入保留')
  await user.type(screen.getByLabelText('研究内容'), '；后来补充')
  view.unmount()
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '写研究笔记' }))
  expect(screen.getByLabelText('研究内容')).toHaveValue('第一次提交；后来补充')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('第一次提交；后来补充')
  expect(writes.map(item => item.method)).toEqual(['POST', 'POST', 'PATCH'])
  expect(project.notes).toHaveLength(1)
  expect(project.notes[0].revision).toBe(2)
  expect(JSON.parse(sessionStorage.getItem('research.noteDrafts')!)).toEqual({})
})

it('recognizes a committed note PATCH after its response is lost without overwriting or retrying it', async () => {
  const user = userEvent.setup()
  let project = existing()
  project.notes = [savedNote(project)]
  let writes = 0
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/research-projects') return { items: [summary(project)] } as never
    if (path.endsWith('/files') || path.endsWith('/claims') || path.endsWith('/revisions')) return { items: [] } as never
    if (path.endsWith('/notes/n1') && init?.method === 'PATCH') {
      writes++
      project = { ...project, notes: [{ ...project.notes[0], ...JSON.parse(String(init.body)), revision: 2 }] }
      throw new Error('更新响应丢失')
    }
    return project as never
  })
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '编辑笔记 已保存笔记' }))
  await user.type(screen.getByLabelText('研究内容'), '；已提交更新')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('原文；已提交更新')
  expect(screen.queryByLabelText('研究内容')).not.toBeInTheDocument()
  expect(writes).toBe(1)
  expect(project.notes).toHaveLength(1)
})

it('requires a merge when an unknown creation was changed elsewhere before its original replay', async () => {
  const user = userEvent.setup()
  let project = existing()
  let creates = 0
  const revisions: number[] = []
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/research-projects') return { items: [summary(project)] } as never
    if (path.endsWith('/files') || path.endsWith('/claims') || path.endsWith('/revisions')) return { items: [] } as never
    if (path === '/research-projects/p1/notes' && init?.method === 'POST') {
      creates++
      if (creates === 1) {
        const note = { ...savedNote(project), ...JSON.parse(String(init.body)), body: '另一处的新判断', revision: 2 }
        project = { ...project, notes: [note] }
        throw new Error('原保存响应丢失')
      }
      throw new Error('相同保存请求不能使用不同的笔记内容。')
    }
    if (path === '/research-projects/p1/notes/n1' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); revisions.push(body.base_revision)
      project = { ...project, notes: [{ ...project.notes[0], ...body, revision: 3 }] }
      return project.notes[0] as never
    }
    return project as never
  })
  render(<ResearchProjectsPage onOpenConversation={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '写研究笔记' }))
  await user.type(screen.getByLabelText('笔记标题'), '新笔记')
  await user.type(screen.getByLabelText('研究内容'), '我的判断')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('原保存响应丢失')
  await user.type(screen.getByLabelText('研究内容'), '；保留的修改')
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('另一处的新判断')
  expect(screen.getByRole('button', { name: '保存笔记' })).toBeDisabled()
  expect(screen.getByLabelText('研究内容')).toHaveValue('我的判断；保留的修改')
  expect(revisions).toEqual([])
  await user.click(screen.getByRole('button', { name: '继续合并我的修改' }))
  await user.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('我的判断；保留的修改')
  expect(revisions).toEqual([2])
  expect(creates).toBe(2)
  expect(project.notes).toHaveLength(1)
})
