import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type Filter, type Strategy } from '../api'
import WorkbenchPage from './WorkbenchPage'
import type { Node } from './StrategyPage'

vi.mock('../api', () => ({ api: vi.fn() }))
vi.mock('../components/StockSearch', async importOriginal => ({ ...await importOriginal<typeof import('../components/StockSearch')>(), default: () => <span>股票选择</span>, StockName: ({ code }: { code: string }) => <span>{code}</span> }))
vi.mock('../components/conversation/ConversationWorkspace', () => ({ default: ({ onOpenDataServices }: { onOpenDataServices?: () => void }) => <><p>描述目标并核对选股方案</p>{onOpenDataServices && <button onClick={onOpenDataServices}>打开筛选数据服务</button>}</> }))
vi.mock('./ReportEvaluations', () => ({ default: () => <p>研报证据核验内容</p> }))
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
  await user.click(screen.getByRole('button', { name: '关闭新增条件' }))
  expect(screen.getByRole('heading', { name: '价格条件' })).toBeInTheDocument()
  expect(localStorage.getItem('workbench.prompt')).toBe(JSON.stringify('收盘价高于20日均线'))
  await user.click(screen.getByRole('button', { name: '新增可复用条件' }))
  expect(screen.getByRole('textbox', { name: '选股条件描述' })).toHaveValue('收盘价高于20日均线')
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
  expect(screen.getByRole('button', { name: '开始筛选' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '组合逻辑' }))
  await user.click(screen.getByRole('button', { name: '添加分组' }))
  await user.click(screen.getByRole('button', { name: '应用修改' }))
  expect(screen.getByRole('button', { name: '保存组合' })).toBeDisabled()
  expect(savedBodies).toHaveLength(0)
})

it('keeps the condition catalog usable when recent descriptions fail to load', async () => {
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => { if (path.startsWith('/condition-drafts')) throw new Error('历史描述暂不可用'); return original(path, options) })
  const user = userEvent.setup(); mountCompose()
  await screen.findByText(/历史描述暂不可用/)
  expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: '移除全部条目' }))
  expect(screen.getByLabelText('选择待选条件 价格条件 第 1 版')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '加入全部待选条件' })).toBeEnabled()
})

it('persists transfer edits, supports undo and does not execute when moving conditions', async () => {
  const user = userEvent.setup(); mountCompose()
  await waitFor(() => expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '移除全部条目' }))
  expect(JSON.parse(localStorage.getItem('workbench.tree')!).children).toEqual([])
  await user.click(screen.getByRole('button', { name: '撤销上次组合更改' }))
  expect(JSON.parse(localStorage.getItem('workbench.tree')!)).toEqual(tree)
  expect(screen.queryByText('已移除 1 个条目。')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '移除全部条目' }))
  await user.click(screen.getByLabelText('选择待选条件 价格条件 第 1 版'))
  await user.click(screen.getByRole('button', { name: '加入勾选条件' }))
  expect(JSON.parse(localStorage.getItem('workbench.tree')!)).toEqual(tree)
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
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
  await waitFor(() => expect(screen.getByRole('button', { name: '开始筛选' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '开始筛选' }))
  await screen.findByText(/组合第 1 版已保存，但本次筛选提交未能确认/)
  await user.click(screen.getByRole('button', { name: '开始筛选' }))
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
  await screen.findByRole('heading', { name: '条件组合编辑' })
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
  expect(document.querySelector('.condition-category')).not.toBeInTheDocument()
  expect(screen.queryByText('研报条件 · v1')).not.toBeInTheDocument()
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

it('forwards the data services action into the screening conversation', async () => {
  const onOpenDataServices = vi.fn(), user = userEvent.setup()
  render(<WorkbenchPage workflowOnly data={data} onReports={vi.fn()} onOpenDataServices={onOpenDataServices} />)
  await user.click(await screen.findByRole('button', { name: '打开筛选数据服务' }))
  expect(onOpenDataServices).toHaveBeenCalledOnce()
})

it('creates a condition in a drawer while retaining the composition and unfinished description', async () => {
  localStorage.setItem('workbench.tree', JSON.stringify(tree))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation view="compose" data={data} onReports={vi.fn()} />)
  const editor = screen.getByRole('region', { name: '构建选股组合' })
  await user.click(await screen.findByRole('button', { name: '添加条件' }))
  await user.click(screen.getByRole('button', { name: '描述新条件并核对' }))
  const drawer = screen.getByRole('dialog', { name: '新增可复用条件' })
  await user.type(within(drawer).getByLabelText('选股条件描述'), '近5日涨幅大于3%')
  await user.click(within(drawer).getByRole('button', { name: '关闭新增条件' }))
  expect(screen.getByRole('region', { name: '构建选股组合' })).toBe(editor)
  expect(JSON.parse(localStorage.getItem('workbench.tree')!)).toEqual(tree)
  await user.click(screen.getByRole('button', { name: '描述新条件并核对' }))
  expect(within(screen.getByRole('dialog', { name: '新增可复用条件' })).getByLabelText('选股条件描述')).toHaveValue('近5日涨幅大于3%')
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('searches saved compositions and loads a chosen historical version without executing', async () => {
  versions = [
    { id: 'trend', name: '趋势组合', version: 1, tree, top_n: 12, created_at: '2026-09-01T00:00:00Z' },
    { id: 'trend', name: '趋势组合', version: 2, tree: { ...tree, op: 'any' }, top_n: 24, created_at: '2026-09-02T00:00:00Z' },
    { id: 'other', name: '其他组合', version: 1, tree, top_n: 30, created_at: '2026-09-03T00:00:00Z' },
  ]
  const user = userEvent.setup(); mountCompose()
  await waitFor(() => expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '切换组合' }))
  const picker = screen.getByRole('dialog', { name: '选择组合' })
  await user.type(within(picker).getByLabelText('搜索已保存组合'), '趋势')
  expect(within(picker).queryByRole('button', { name: /载入 其他组合/ })).not.toBeInTheDocument()
  await user.click(within(picker).getByText('历史版本 · 1'))
  await user.click(within(picker).getByRole('button', { name: '载入 趋势组合 第 1 版' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByLabelText('组合名称')).toHaveValue('趋势组合')
  expect(screen.getByLabelText('优先保留数量')).toHaveValue(12)
  expect(JSON.parse(localStorage.getItem('workbench.tree')!)).toEqual(tree)
  expect(screen.getByText('已保存 · v1')).toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('saves a condition revision in the detail drawer while keeping the composition on its original version', async () => {
  const original = vi.mocked(api).getMockImplementation()!
  let revised: Filter | undefined
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/filters' && options?.method === 'POST') { revised = { ...filter, version: 2, expression: { ...filter.expression, value: 15 }, description: '收盘价大于15' }; return revised as never }
    if (path.startsWith('/filters?')) return { items: revised ? [filter, revised] : [filter] } as never
    return original(path, options)
  })
  localStorage.setItem('workbench.tree', JSON.stringify(tree))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation view="library" data={data} onReports={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '查看与调整 价格条件' }))
  const drawer = screen.getByRole('dialog', { name: '价格条件' })
  expect(within(drawer).queryByLabelText('阈值')).not.toBeInTheDocument()
  await user.click(within(drawer).getByRole('button', { name: '编辑条件' }))
  fireEvent.change(within(drawer).getByLabelText('阈值'), { target: { value: '15' } })
  expect(within(drawer).getByRole('button', { name: '先保存修改再加入组合' })).toBeDisabled()
  await user.click(within(drawer).getByRole('button', { name: '保存为新版本' }))
  await within(drawer).findByText('已创建新版本。已有组合继续使用原先选定的版本。')
  expect(JSON.parse(localStorage.getItem('workbench.tree')!)).toEqual(tree)
  const save = vi.mocked(api).mock.calls.find(([path, options]) => path === '/filters' && options?.method === 'POST')!
  expect(JSON.parse(String(save[1]!.body))).toMatchObject({ id: 'f1', base_version: 1, expression: { value: 15 } })
})

it('opens report evidence from condition details in a visible drawer', async () => {
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => path.startsWith('/filters?') ? { items: [{ ...filter, library: 'report' }] } as never : original(path, options))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation view="library" data={data} onReports={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '查看与调整 价格条件' }))
  await user.click(within(screen.getByRole('dialog', { name: '价格条件' })).getByRole('button', { name: '核验研报证据' }))
  expect(screen.queryByRole('dialog', { name: '价格条件' })).not.toBeInTheDocument()
  expect(within(screen.getByRole('dialog', { name: '核验“价格条件”的研报证据' })).getByText('研报证据核验内容')).toBeVisible()
})

it('preserves saved settings through parameter editing, explicit version updates, ranking and saving', async () => {
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => path.startsWith('/filters?') ? { items: [filter, { ...filter, version: 2, name: '价格条件新版' }] } as never : original(path, options))
  const existing: Node = { op: 'any', children: [{ op: 'filter_ref', filter_id: 'f1', version: 1, score_weight: 4, parameter_overrides: { value: 15 } }, { op: 'not', children: [{ op: 'filter_ref', filter_id: 'f1', version: 1, score_weight: 0, parameter_overrides: { value: 30 } }] }] }
  localStorage.setItem('workbench.tree', JSON.stringify(existing))
  localStorage.setItem('workbench.asOf', JSON.stringify('2026-09-28'))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation view="compose" data={data} onReports={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled())
  expect(JSON.parse(localStorage.getItem('workbench.tree')!)).toEqual(existing)
  await user.click(screen.getByRole('button', { name: '编辑第 1 项参数' }))
  expect(screen.queryByLabelText('评分权重')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('引用版本')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('阈值'), { target: { value: '16' } })
  await user.click(screen.getByRole('button', { name: '条件详情' }))
  const details = screen.getByRole('dialog', { name: '条件详情' })
  expect(within(details).getByText('已固定 v1')).toBeInTheDocument()
  await user.click(within(details).getByRole('button', { name: '更新到 v2' }))
  await user.click(within(details).getByRole('button', { name: '关闭条件引用详情' }))
  await user.click(screen.getByRole('button', { name: '排序设置' }))
  const ranking = screen.getByRole('dialog', { name: '排序设置' })
  expect(within(ranking).getByLabelText('第 1 项评分权重')).toHaveValue(4)
  expect(within(ranking).getByLabelText('第 2 项评分权重')).toHaveValue(0)
  fireEvent.change(within(ranking).getByLabelText('第 2 项评分权重'), { target: { value: '2.5' } })
  await user.click(within(ranking).getByRole('button', { name: '应用排序设置' }))
  await user.click(screen.getByRole('button', { name: '保存组合' }))
  await waitFor(() => expect(savedBodies).toHaveLength(1))
  expect(savedBodies[0].tree).toEqual({ op: 'any', children: [{ ...existing.children![0], version: 2, parameter_overrides: { value: 16 } }, { op: 'not', children: [{ ...existing.children![1].children![0], score_weight: 2.5 }] }] })
  expect(existing.children![1].children![0].score_weight).toBe(0)
})

it('uses the same compact list and evidence sidebar for combination and conversation history', async () => {
  const original = vi.mocked(api).getMockImplementation()!
  const task = { task_id: 'task', revision: 1, original_user_messages: ['价格条件'], conditions: [{ condition_id: 'condition', library: 'technical', description: '对话价格条件', source_quote: '价格条件', expression: {} }], references: [{ reference_id: 'ref', condition_id: 'condition', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'ref' }, scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: data.last_date, report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null }, unresolved: [] }
  const raw = { stock_code: '600000.SH', state: 'true', close: 11, score: 3, as_of: data.last_date, details: [{ name: '价格条件', state: 'true', actual: 11, threshold: 10, version: 1, effective_expression: filter.expression, formula_trace: { op: 'field', label: '原始收盘价', value: 11 }, assessments: [{ document_id: 'report', title: '公司年报', criteria: [{ label: '营收增长', state: 'true', summary: '原文已核对', evidence: [{ page: 12, quote: '营业收入增长25%' }] }] }] }] }
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/screening-history') return { items: [
      { id: 'legacy', name: '组合历史', strategy_id: 's1', strategy_version: 1, as_of: data.last_date, status: 'succeeded', created_at: filter.created_at },
      { id: 'conversation-run', name: '对话历史', kind: 'conversation', conversation_id: 'conversation', strategy_id: '', strategy_version: 1, as_of: data.last_date, status: 'succeeded', created_at: filter.created_at },
    ] } as never
    if (path === '/screening-runs/legacy') return { id: 'legacy', strategy_id: 's1', strategy_version: 1, as_of: data.last_date, status: 'succeeded', created_at: filter.created_at, result: { counts: { evaluated: 1, true: 1, false: 0, unknown: 0 }, trace_version: 'v1' } } as never
    if (path.startsWith('/screening-runs/legacy/decisions')) return { items: [raw], total: 1 } as never
    if (path === '/conversations/conversation/screening-runs/conversation-run') return { id: 'conversation-run', as_of: data.last_date, status: 'succeeded', task_revision: 1, task, job: { message: '完成', progress: 1 }, result: { coverage: { target_total: 1, true_count: 1, false_count: 0, unknown_count: 0 } } } as never
    if (path.startsWith('/conversations/conversation/screening-runs/conversation-run/decisions')) return { items: [{ stock_code: '600001.SH', state: 'true', condition_decisions: [{ condition_id: 'condition', state: 'true', explanation: '对话条件的原始判断依据' }] }], total: 1 } as never
    return original(path, options)
  })
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation view="history" data={data} onReports={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: /组合历史/ }))
  expect(await screen.findByRole('table', { name: '筛选结果股票列表' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '详细卡片' })).not.toBeInTheDocument()
  expect(screen.getByText(/排序得分 3/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '查看 600000.SH 条件与依据' }))
  const evidence = screen.getByRole('dialog', { name: '个股条件与依据' })
  expect(within(evidence).getByText('第 12 页：“营业收入增长25%”')).toBeInTheDocument()
  await user.click(within(evidence).getByText('查看逐项计算过程'))
  expect(within(evidence).getByText('原始收盘价')).toBeVisible()
  await user.click(within(evidence).getByRole('button', { name: '关闭个股依据' }))
  expect(screen.getByRole('button', { name: '查看 600000.SH 条件与依据' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: '切换筛选记录' }))
  const picker = screen.getByRole('dialog', { name: '选择筛选记录' })
  await user.type(within(picker).getByLabelText('搜索筛选记录'), '对话')
  await user.click(within(picker).getByRole('button', { name: /对话历史/ }))
  expect(await screen.findByRole('button', { name: '查看 600001.SH 条件与依据' })).toBeInTheDocument()
  expect(screen.getByRole('table', { name: '筛选结果股票列表' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '查看 600001.SH 条件与依据' }))
  expect(within(screen.getByRole('dialog', { name: '个股条件与依据' })).getByText('对话条件的原始判断依据')).toBeVisible()
})

it('retries a failed history result read without treating it as zero matches', async () => {
  const original = vi.mocked(api).getMockImplementation()!
  let requests = 0
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/screening-runs/run1') return { id: 'run1', strategy_id: 's1', strategy_version: 1, as_of: data.last_date, status: 'succeeded', created_at: filter.created_at, result: { counts: { evaluated: 1, true: 1, false: 0, unknown: 0 }, trace_version: 'v1' } } as never
    if (path.startsWith('/screening-runs/run1/decisions')) { if (++requests === 1) throw new Error('结果暂时不可用'); return { items: [{ stock_code: '600000.SH', state: 'true', close: 11, score: 1, as_of: data.last_date, details: [{ name: '价格条件', state: 'unknown', actual: null, reason: '历史数据暂缺' }] }], total: 1 } as never }
    return original(path, options)
  })
  localStorage.setItem('workbench.runId', JSON.stringify('run1'))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation view="history" data={data} onReports={vi.fn()} />)
  await screen.findByText('筛选结果加载失败')
  expect(screen.queryByText('本次没有找到符合条件的股票')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重新加载结果' }))
  await user.click(await screen.findByRole('button', { name: '查看 600000.SH 条件与依据' }))
  expect(within(screen.getByRole('dialog', { name: '个股条件与依据' })).getByText('历史数据暂缺')).toBeVisible()
  expect(requests).toBe(2)
})

it('returns to the scheme center and continues the same unsaved composition without running', async () => {
  localStorage.setItem('workbench.section', JSON.stringify('compose'))
  localStorage.setItem('workbench.tree', JSON.stringify(tree))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation data={data} onReports={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '保存组合' })).toBeEnabled())
  fireEvent.change(screen.getByLabelText('组合名称'), { target: { value: '我的未保存研究草稿' } })
  await user.click(screen.getByRole('button', { name: '我的筛选方案' }))
  expect(await screen.findByRole('heading', { name: '我的筛选方案' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '当前组合草稿' })).toHaveTextContent('我的未保存研究草稿')
  await user.click(screen.getByRole('button', { name: '继续编辑草稿' }))
  expect(screen.getByLabelText('组合名称')).toHaveValue('我的未保存研究草稿')
  expect(JSON.parse(localStorage.getItem('workbench.tree')!)).toEqual(tree)
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true)
})

it('opens historical compositions from the center and undo restores the previous saved version even with identical rules', async () => {
  const first: Strategy = { id: 'stable', name: '固定版本方案', version: 1, tree, top_n: 30, created_at: filter.created_at }
  versions = [first, { ...first, version: 2 }]
  localStorage.setItem('workbench.section', JSON.stringify('saved'))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation data={data} onReports={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '打开编辑 固定版本方案 第 2 版' }))
  expect(screen.getByText('已保存 · v2')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '我的筛选方案' }))
  await user.click(screen.getByText('历史版本 · 1'))
  await user.click(screen.getByRole('button', { name: '打开编辑 固定版本方案 第 1 版' }))
  expect(screen.getByText('已保存 · v1')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '撤销上次组合更改' }))
  expect(screen.getByText('已保存 · v2')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '保存组合' })).toBeDisabled()
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true)
})

it('retains the previous draft across repeated new-composition clicks and the library round trip', async () => {
  localStorage.setItem('workbench.section', JSON.stringify('saved'))
  localStorage.setItem('workbench.tree', JSON.stringify(tree))
  localStorage.setItem('workbench.strategyName', JSON.stringify('需要恢复的草稿'))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation data={data} onReports={vi.fn()} />)
  await user.click((await screen.findAllByRole('button', { name: '新建条件组合' }))[0])
  await user.click(screen.getByRole('button', { name: '新建组合' }))
  await user.click(screen.getByRole('button', { name: '管理条件库' }))
  await screen.findByRole('heading', { name: '价格条件' })
  expect(screen.getByText('v1')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /查看组合/ }))
  await user.click(screen.getByRole('button', { name: '撤销上次组合更改' }))
  expect(screen.getByLabelText('组合名称')).toHaveValue('需要恢复的草稿')
  expect(JSON.parse(localStorage.getItem('workbench.tree')!)).toEqual(tree)
})

it('cancels asset editing without changing its version or the current composition', async () => {
  localStorage.setItem('workbench.tree', JSON.stringify(tree))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation view="library" data={data} onReports={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '查看与调整 价格条件' }))
  const drawer = screen.getByRole('dialog', { name: '价格条件' })
  expect(within(drawer).queryByLabelText('阈值')).not.toBeInTheDocument()
  await user.click(within(drawer).getByRole('button', { name: '编辑条件' }))
  fireEvent.change(within(drawer).getByLabelText('阈值'), { target: { value: '99' } })
  await user.click(within(drawer).getByRole('button', { name: '取消编辑' }))
  expect(within(drawer).queryByLabelText('阈值')).not.toBeInTheDocument()
  await user.click(within(drawer).getByRole('button', { name: '编辑条件' }))
  expect(within(drawer).getByLabelText('阈值')).toHaveValue(10)
  expect(JSON.parse(localStorage.getItem('workbench.tree')!)).toEqual(tree)
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true)
})

it('keeps a confirmed AI condition append on the current strategy identity until explicit new composition', async () => {
  localStorage.setItem('workbench.section', JSON.stringify('create'))
  localStorage.setItem('workbench.strategyId', JSON.stringify('existing-strategy'))
  localStorage.setItem('workbench.tree', JSON.stringify(tree))
  localStorage.setItem('workbench.draft', JSON.stringify('confirmed'))
  localStorage.setItem('workbench.prompt', JSON.stringify('价格条件'))
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, options) => path === '/condition-drafts/confirmed' ? { id: 'confirmed', prompt: '价格条件', original_prompt: '价格条件', source: 'local_parser', status: 'ready', assumptions: [], issues: [], conditions: [], tree: null, saved: { filters: [filter], tree } } as never : original(path, options))
  const user = userEvent.setup()
  render(<WorkbenchPage workflowOnly shellNavigation data={data} onReports={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '用这些条件组合选股' }))
  expect(await screen.findByRole('heading', { name: '条件组合编辑' })).toBeInTheDocument()
  expect(JSON.parse(localStorage.getItem('workbench.strategyId')!)).toBe('existing-strategy')
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true)
})

it('does not submit generated conditions on an IME composing shortcut from a legacy create link', async () => {
  const onViewChange = vi.fn()
  render(<WorkbenchPage workflowOnly shellNavigation view="create" onViewChange={onViewChange} data={data} onReports={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: '选股条件描述' })
  fireEvent.change(input, { target: { value: '最近二十日涨幅' } })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true })
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true)
  await userEvent.click(screen.getByRole('button', { name: '关闭新增条件' }))
  expect(onViewChange).toHaveBeenLastCalledWith('compose')
  expect(JSON.parse(localStorage.getItem('workbench.prompt')!)).toBe('最近二十日涨幅')
})
