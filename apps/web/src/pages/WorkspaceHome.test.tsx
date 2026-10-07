import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import WorkspaceHome from './WorkspaceHome'

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: vi.fn() }))
const callbacks = () => ({ data: { available: true, last_date: '2026-09-28', securities: 5600 }, onNavigate: vi.fn(), onNewResearch: vi.fn(), onResearch: vi.fn(), onProject: vi.fn(), onConversation: vi.fn(), onObservation: vi.fn(), onSettings: vi.fn() })

it('opens recent work and links to research and screening without starting an API job', async () => {
  vi.mocked(api).mockImplementation(async path => path === '/research-projects'
    ? { items: [{ id: 'p1', name: '订单兑现', status: 'active', company_count: 2, note_count: 3 }] } as never
    : path.startsWith('/conversations')
      ? { items: [{ id: 'c1', title: '核对订单证据', entry_scope: 'report', updated_at: '2026-10-03T08:00:00Z', last_turn_state: 'succeeded' }] } as never
      : path.startsWith('/observation/runs')
        ? { items: [{ id: 'r1', name: '趋势跟踪', signal_date: '2026-09-28', status: 'succeeded', counts: { true_count: 4 } }] } as never
        : { items: [] } as never)
  const props = callbacks()
  const user = userEvent.setup()
  render(<WorkspaceHome {...props} />)
  await user.click(await screen.findByRole('button', { name: /核对订单证据/ }))
  expect(props.onConversation).toHaveBeenCalledWith('c1', 'report')
  await user.click(screen.getByRole('button', { name: /订单兑现/ }))
  expect(props.onProject).toHaveBeenCalledWith('p1')
  await user.click(screen.getByRole('button', { name: /趋势跟踪/ }))
  expect(props.onObservation).toHaveBeenCalledWith('r1')
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /开始研究/ }))
  expect(props.onNewResearch).toHaveBeenCalledOnce()
  await user.click(screen.getByRole('button', { name: /按条件找股票/ }))
  expect(props.onNavigate).toHaveBeenCalledWith('conditions')
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('guides a confirmed first visit through three tasks and prepares a real company question without sending it', async () => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const props = callbacks()
  const user = userEvent.setup()
  render(<WorkspaceHome {...props} />)
  await screen.findByRole('heading', { name: '你想先完成哪件事？' })
  const choices = within(screen.getByRole('navigation', { name: '选择第一项任务' }))
  expect(choices.getAllByRole('button')).toHaveLength(3)
  expect(screen.queryByRole('region', { name: '活跃研究项目' })).not.toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '最近对话' })).not.toBeInTheDocument()
  const initialCalls = vi.mocked(api).mock.calls.length

  await user.click(choices.getByRole('button', { name: /研究一家公司/ }))
  expect(props.onResearch).not.toHaveBeenCalled()
  const company = screen.getByRole('textbox', { name: '公司名称或证券代码' })
  expect(company).toHaveFocus()
  expect(screen.getByRole('button', { name: '准备研究问题' })).toBeDisabled()
  await user.type(company, ' 300750 ')
  await user.click(screen.getByRole('button', { name: '准备研究问题' }))
  expect(props.onResearch).toHaveBeenCalledWith('请研究 300750：主营业务是什么，近期有哪些变化，需要核对哪些关键证据？')
  expect(props.onNewResearch).not.toHaveBeenCalled()
  await user.click(choices.getByRole('button', { name: /按条件找股票/ }))
  await user.click(choices.getByRole('button', { name: /读懂一份材料/ }))
  expect(props.onNavigate.mock.calls).toEqual([['conditions'], ['reports']])
  expect(vi.mocked(api).mock.calls).toHaveLength(initialCalls)
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('waits for every history resource before treating an empty workspace as a first visit', async () => {
  let finishProjects!: () => void
  vi.mocked(api).mockImplementation(path => path === '/research-projects'
    ? new Promise(resolve => { finishProjects = () => resolve({ items: [] } as never) })
    : Promise.resolve({ items: [] } as never))
  render(<WorkspaceHome {...callbacks()} />)
  await screen.findByText('正在读取已有工作…')
  expect(screen.queryByRole('heading', { name: '你想先完成哪件事？' })).not.toBeInTheDocument()
  await act(async () => finishProjects())
  expect(await screen.findByRole('heading', { name: '你想先完成哪件事？' })).toBeInTheDocument()
})

it.each(['/research-projects', '/conversations', '/observation/runs', '/observation/research-candidates'])('does not mistake a failed %s read for a first visit and can recover', async failedPath => {
  vi.mocked(api).mockImplementation(async path => {
    if (path.startsWith(failedPath)) throw new Error('工作记录暂时无法读取')
    return { items: [] } as never
  })
  const props = callbacks()
  const user = userEvent.setup()
  render(<WorkspaceHome {...props} />)
  await screen.findByText('工作记录暂时无法读取')
  expect(screen.queryByRole('heading', { name: '你想先完成哪件事？' })).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '首页' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /读懂一份材料/ }))
  expect(props.onNavigate).toHaveBeenCalledWith('reports')
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  await user.click(screen.getByRole('button', { name: '重试加载' }))
  expect(await screen.findByRole('heading', { name: '你想先完成哪件事？' })).toBeInTheDocument()
})

it('continues the latest screening work with a screening label and the saved conversation', async () => {
  vi.mocked(api).mockImplementation(async path => ({ items: path.startsWith('/conversations')
    ? [{ id: 'screening-1', title: '低估值选股', workflow_type: 'screening', entry_scope: 'screening', updated_at: '2026-10-05T08:00:00Z', last_turn_state: 'awaiting_user' }]
    : [] }) as never)
  const props = callbacks()
  const user = userEvent.setup()
  render(<WorkspaceHome {...props} />)
  await user.click(await screen.findByRole('button', { name: '继续上次选股' }))
  expect(props.onConversation).toHaveBeenCalledWith('screening-1', 'screening')
  expect(screen.queryByRole('button', { name: '继续上次研究' })).not.toBeInTheDocument()
  expect(screen.queryByRole('navigation', { name: '选择第一项任务' })).not.toBeInTheDocument()
})

it('counts saved candidates with complete plans as history without asking to complete them again', async () => {
  vi.mocked(api).mockImplementation(async path => ({ items: path.startsWith('/observation/research-candidates')
    ? [{ id: 'candidate-1', stock_code: '300750.SZ', name: '宁德时代', status: 'watching', verification: '核对下季度订单', note: '观察订单兑现' }]
    : [] }) as never)
  render(<WorkspaceHome {...callbacks()} />)
  await waitFor(() => expect(screen.queryByText('正在读取已有工作…')).not.toBeInTheDocument())
  expect(screen.getByRole('heading', { name: '首页' })).toBeInTheDocument()
  expect(screen.queryByRole('navigation', { name: '选择第一项任务' })).not.toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '待完善验证计划' })).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('needs_verification=true'))).toBe(false)
})

it('keeps an unsent question as returning work even when all saved lists are empty', async () => {
  sessionStorage.setItem('home.researchDraft', JSON.stringify('核对订单兑现'))
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const props = callbacks()
  const user = userEvent.setup()
  render(<WorkspaceHome {...props} />)
  await waitFor(() => expect(screen.queryByText('正在读取已有工作…')).not.toBeInTheDocument())
  expect(screen.queryByRole('navigation', { name: '选择第一项任务' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '继续未发送的问题' }))
  expect(props.onResearch).toHaveBeenCalledWith('核对订单兑现')
})

it('reports market date, quality and formal readiness separately from file availability', async () => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const props = callbacks()
  const user = userEvent.setup()
  const view = render(<WorkspaceHome {...props} />)
  let status = screen.getByRole('button', { name: /本地行情已载入/ })
  expect(status).toHaveTextContent('行情截至 2026-09-28')
  expect(status).toHaveTextContent('基础质量待检查')
  expect(status).toHaveTextContent('正式选股就绪状态待确认')
  expect(status.querySelector('.status-dot')).toHaveClass('warning')
  await user.click(status)
  expect(props.onSettings).toHaveBeenCalledOnce()

  view.rerender(<WorkspaceHome {...props} data={{ ...props.data, quality_status: 'basic_checks_passed', formal_execution_ready: true }} />)
  status = screen.getByRole('button', { name: /本地行情已载入/ })
  expect(status).toHaveTextContent('基础质量检查通过')
  expect(status).toHaveTextContent('正式选股已就绪')
  expect(status.querySelector('.status-dot')).toHaveClass('good')

  view.rerender(<WorkspaceHome {...props} data={{ ...props.data, quality_status: 'issues_found', formal_execution_ready: true }} />)
  status = screen.getByRole('button', { name: /本地行情已载入/ })
  expect(status).toHaveTextContent('基础质量检查发现异常')
  expect(status).toHaveTextContent('正式选股尚未就绪')
  expect(status.querySelector('.status-dot')).toHaveClass('warning')
})

it('keeps the home question draft and isolates one resource failure from the other panels', async () => {
  sessionStorage.setItem('home.researchDraft', JSON.stringify('还没有写完的研究问题'))
  vi.mocked(api).mockImplementation(async path => {
    if (path === '/research-projects') throw new Error('项目暂时无法读取')
    return { items: [] } as never
  })
  const props = callbacks()
  const user = userEvent.setup()
  const view = render(<WorkspaceHome {...props} />)
  await screen.findByText('项目暂时无法读取')
  expect(screen.getByRole('region', { name: '最近对话' })).toBeInTheDocument()
  view.unmount()
  render(<WorkspaceHome {...props} />)
  expect(screen.getByText('还没有写完的研究问题')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '继续未发送的问题' }))
  expect(props.onResearch).toHaveBeenCalledWith('还没有写完的研究问题')
  await user.click(screen.getByRole('button', { name: /资讯库/ }))
  await waitFor(() => expect(props.onNavigate).toHaveBeenCalledWith('news'))
})
