import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type Filter, type Strategy } from '../api'
import WorkbenchPage from './WorkbenchPage'
import type { Node } from './StrategyPage'

vi.mock('../api', () => ({ api: vi.fn() }))
vi.mock('../components/StockSearch', () => ({ default: () => <span>股票选择</span>, StockName: ({ code }: { code: string }) => <span>{code}</span> }))
vi.mock('../components/conversation/ConversationWorkspace', () => ({ default: () => <p>描述目标并核对选股方案</p> }))
const filter: Filter = { id: 'f1', version: 1, library: 'technical', name: '价格条件', description: '收盘价大于10', expression: { op: 'field_compare', field: 'close', operator: 'gt', value: 10 }, parameters: { value: { label: '阈值', type: 'number', min: 0, max: 1000 } }, contract: { summary: '收盘价大于10', notes: [], availability: 'market', availability_label: '行情可计算' }, created_at: '2026-10-04T08:00:00Z' }
const tree: Node = { op: 'all', children: [{ op: 'filter_ref', filter_id: 'f1', version: 1, score_weight: 1 }] }
const data = { available: true, last_date: '2026-09-28' }
let versions: Strategy[]
let savedBodies: Record<string, unknown>[]
beforeEach(() => {
  versions = []; savedBodies = []
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.startsWith('/filters?')) return { items: [filter] } as never
    if (path.startsWith('/strategies?')) return { items: versions } as never
    if (path === '/strategies' && options?.method === 'POST') {
      const body = JSON.parse(String(options.body)); savedBodies.push(body)
      const saved: Strategy = { ...body, id: 's1', version: versions.length + 1, created_at: filter.created_at }
      versions.push(saved); return saved as never
    }
    if (path === '/strategies/validate') return { valid: true, errors: [] } as never
    if (path === '/screening-runs') return { id: 'run1' } as never
    if (path === '/screening-runs/run1') return { id: 'run1', strategy_id: 's1', strategy_version: 1, as_of: '2026-09-28', status: 'queued', created_at: filter.created_at, result: {}, job: { message: '等待筛选', progress: 0 } } as never
    return { items: [] } as never
  })
})
function mountCompose() {
  localStorage.setItem('workbench.section', JSON.stringify('compose'))
  localStorage.setItem('workbench.tree', JSON.stringify(tree))
  localStorage.setItem('workbench.asOf', JSON.stringify('2026-09-28'))
  return render(<WorkbenchPage workflowOnly data={data} onReports={vi.fn()} />)
}

it('starts with a single screening path and reveals advanced tools without submitting', async () => {
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly data={data} onReports={vi.fn()} />)
  expect(screen.getByText('描述目标并核对选股方案')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /条件编排/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '高级工具' }))
  expect(screen.getByRole('button', { name: /条件编排/ })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '收起高级工具' }))
  expect(screen.queryByRole('button', { name: /我的条件/ })).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true)
})

it('creates reusable conditions from the condition library and retains the description when returning', async () => {
  localStorage.setItem('workbench.section', JSON.stringify('library'))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly data={data} onReports={vi.fn()} />)
  await screen.findByRole('heading', { name: '价格条件' })
  expect(screen.queryByRole('button', { name: '描述条件' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '新增可复用条件' }))
  expect(screen.getByRole('heading', { name: '新增可复用条件' })).toBeInTheDocument()
  expect(within(screen.getByRole('navigation', { name: '条件选股流程' })).getByRole('button', { name: /我的条件/ })).toHaveAttribute('aria-current', 'page')
  await user.type(screen.getByRole('textbox', { name: '选股条件描述' }), '收盘价高于20日均线')
  await user.click(screen.getByRole('button', { name: '返回我的条件' }))
  expect(screen.getByRole('heading', { name: '价格条件' })).toBeInTheDocument()
  expect(localStorage.getItem('workbench.prompt')).toBe(JSON.stringify('收盘价高于20日均线'))
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('blocks invalid quantities, future dates and empty groups before submitting', async () => {
  const user = userEvent.setup(); mountCompose()
  await waitFor(() => expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled())
  fireEvent.change(screen.getByLabelText('优先保留数量'), { target: { value: '1.5' } })
  expect(screen.getByRole('button', { name: '保存组合' })).toBeDisabled()
  expect(screen.getByText('保留数量必须是 1–500 的整数。')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('优先保留数量'), { target: { value: '30' } })
  fireEvent.change(screen.getByLabelText('筛选截止日期'), { target: { value: '2026-10-05' } })
  expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '保存并开始筛选' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '添加分组' }))
  expect(screen.getByRole('button', { name: '保存组合' })).toBeDisabled()
  expect(savedBodies).toHaveLength(0)
})

it('keeps the condition catalog usable when recent descriptions fail to load', async () => {
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => { if (path.startsWith('/condition-drafts')) throw new Error('历史描述暂不可用'); return original(path, options) })
  const user = userEvent.setup(); mountCompose()
  await screen.findByText(/历史描述暂不可用/)
  expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: '添加条件' }))
  expect(screen.getByRole('button', { name: '添加 价格条件 第 1 版' })).toBeInTheDocument()
})

it('locks editor and reset controls until a pending save finishes', async () => {
  let finish!: (value: never) => void
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => path === '/strategies' && options?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : original(path, options))
  const user = userEvent.setup(); mountCompose()
  await waitFor(() => expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '保存组合' }))
  expect(screen.getByLabelText('组合名称')).toBeDisabled()
  expect(screen.getByRole('button', { name: '新建组合' })).toBeDisabled()
  expect(screen.getByLabelText('筛选截止日期')).toBeDisabled()
  await act(async () => finish({ id: 's1', version: 1, name: '我的选股组合', tree, top_n: 30, created_at: filter.created_at } as never))
  await waitFor(() => expect(screen.getByLabelText('组合名称')).toBeEnabled())
  expect(screen.getByText('已保存 · v1')).toBeInTheDocument()
})

it('retains a save accepted after leaving the workflow', async () => {
  let finish!: (value: never) => void
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => path === '/strategies' && options?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : original(path, options))
  const user = userEvent.setup(); const first = mountCompose()
  await waitFor(() => expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '保存组合' }))
  first.unmount()
  await act(async () => finish({ id: 's1', version: 1, name: '我的选股组合', tree, top_n: 30, created_at: filter.created_at } as never))
  expect(JSON.parse(localStorage.getItem('workbench.savedComposition')!).strategy.id).toBe('s1')
  expect(JSON.parse(localStorage.getItem('workbench.submissionRequests')!)).toEqual({})
  mountCompose()
  expect(await screen.findByText('已保存 · v1')).toBeInTheDocument()
})

it('reuses the saved version after a failed execution and preserves success when refresh fails', async () => {
  let submissions = 0
  const requests: string[] = []
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/screening-runs' && options?.method === 'POST') { requests.push(JSON.parse(String(options.body)).request_id); if (++submissions === 1) throw new Error('提交未能确认'); return { id: 'run1' } as never }
    if (path.startsWith('/condition-drafts')) throw new Error('历史刷新失败')
    return original(path, options)
  })
  const user = userEvent.setup(); mountCompose()
  await waitFor(() => expect(screen.getByRole('button', { name: '保存并开始筛选' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '保存并开始筛选' }))
  await screen.findByText(/组合第 1 版已保存，但本次筛选提交未能确认/)
  await user.click(screen.getByRole('button', { name: '按此版本开始筛选' }))
  await waitFor(() => expect(submissions).toBe(2))
  expect(savedBodies).toHaveLength(1)
  expect(savedBodies[0]).toMatchObject({ top_n: 30, tree })
  expect(requests[0]).toBeTruthy()
  expect(requests[1]).toBe(requests[0])
})

it('preserves an uncertain save request across remounts', async () => {
  const requests: string[] = []
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/strategies' && options?.method === 'POST') {
      requests.push(JSON.parse(String(options.body)).request_id)
      if (requests.length === 1) throw new Error('响应中断')
    }
    return original(path, options)
  })
  const user = userEvent.setup(); const first = mountCompose()
  await waitFor(() => expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '保存组合' }))
  await screen.findByText(/组合保存尚未确认/)
  first.unmount(); mountCompose()
  await waitFor(() => expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '保存组合' }))
  await screen.findByText('已保存 · v1')
  expect(requests[0]).toBeTruthy()
  expect(requests[1]).toBe(requests[0])
  expect(JSON.parse(localStorage.getItem('workbench.submissionRequests')!)).toEqual({})
})

it('appends a confirmed plan to the existing composition and can restore it', async () => {
  localStorage.setItem('workbench.section', JSON.stringify('create'))
  const existing: Node = { op: 'any', children: [tree.children![0], { ...tree.children![0], parameter_overrides: { value: 12 } }] }
  localStorage.setItem('workbench.tree', JSON.stringify(existing))
  localStorage.setItem('workbench.prompt', JSON.stringify('收盘价大于10'))
  localStorage.setItem('workbench.draft', JSON.stringify('d1'))
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => path === '/condition-drafts/d1' ? { id: 'd1', prompt: '收盘价大于10', original_prompt: '收盘价大于10', source: 'local_parser', status: 'ready', assumptions: [], issues: [], conditions: [], tree: null, saved: { filters: [filter], tree } } as never : original(path, options))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly data={data} onReports={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '用这些条件组合选股' }))
  await screen.findByRole('heading', { name: '构建选股组合' })
  expect(JSON.parse(localStorage.getItem('workbench.tree')!).children[0]).toEqual(existing)
  await user.click(screen.getByRole('button', { name: '撤销上次组合更改' }))
  await waitFor(() => expect(JSON.parse(localStorage.getItem('workbench.tree')!)).toEqual(existing))
})

it('finds conditions by normalized text and restores category filters', async () => {
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => path.startsWith('/filters?') ? { items: [
    { ...filter, name: 'RSI 超跌', contract: { ...filter.contract!, summary: 'RSI14小于30' } },
    { ...filter, id: 'report', library: 'report', name: '订单增长', contract: { ...filter.contract!, summary: '研报出现订单证据' } },
  ] } as never : original(path, options))
  localStorage.setItem('workbench.section', JSON.stringify('library'))
  const user = userEvent.setup(); render(<WorkbenchPage workflowOnly data={data} onReports={vi.fn()} />)
  await screen.findByRole('heading', { name: 'RSI 超跌' })
  await user.type(screen.getByLabelText('搜索我的条件'), '  rsi14  ')
  expect(screen.getByRole('heading', { name: 'RSI 超跌' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '订单增长' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '清除条件搜索' }))
  await user.selectOptions(screen.getByLabelText('条件类型'), 'report')
  expect(screen.queryByRole('heading', { name: 'RSI 超跌' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重置筛选' }))
  expect(screen.getByRole('heading', { name: 'RSI 超跌' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '订单增长' })).toBeInTheDocument()
})

it('reveals more conditions and resets the page when sorting or searching', async () => {
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => path.startsWith('/filters?') ? { items: Array.from({ length: 14 }, (_, index) => ({ ...filter, id: `f${index}`, name: `条件${String(index).padStart(2, '0')}`, created_at: `2026-10-${String(index + 1).padStart(2, '0')}T08:00:00Z` })) } as never : original(path, options))
  localStorage.setItem('workbench.section', JSON.stringify('library'))
  const user = userEvent.setup(); const { container } = render(<WorkbenchPage workflowOnly data={data} onReports={vi.fn()} />)
  await waitFor(() => expect(container.querySelectorAll('.saved-condition-card')).toHaveLength(12))
  expect(container.querySelector('.saved-condition-card h3')).toHaveTextContent('条件13')
  await user.click(screen.getByRole('button', { name: '显示更多条件' }))
  expect(container.querySelectorAll('.saved-condition-card')).toHaveLength(14)
  await user.selectOptions(screen.getByLabelText('条件排序'), 'name')
  expect(container.querySelectorAll('.saved-condition-card')).toHaveLength(12)
  expect(container.querySelector('.saved-condition-card h3')).toHaveTextContent('条件00')
  await user.type(screen.getByLabelText('搜索我的条件'), '条件13')
  expect(container.querySelectorAll('.saved-condition-card')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: '显示更多条件' })).not.toBeInTheDocument()
})

it('shows a recoverable record error instead of an endless loading message', async () => {
  let reads = 0
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/screening-runs/run1' && ++reads === 1) throw new Error('记录暂时不可用')
    return original(path, options)
  })
  localStorage.setItem('workbench.section', JSON.stringify('history'))
  localStorage.setItem('workbench.runId', JSON.stringify('run1'))
  const user = userEvent.setup(); render(<WorkbenchPage workflowOnly data={data} onReports={vi.fn()} />)
  await screen.findByRole('heading', { name: '暂时无法读取记录' })
  expect(screen.queryByRole('heading', { name: '正在读取筛选记录' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重新读取记录' }))
  await screen.findByText('等待筛选')
  expect(reads).toBe(2)
  expect(screen.queryByRole('heading', { name: '暂时无法读取记录' })).not.toBeInTheDocument()
})
