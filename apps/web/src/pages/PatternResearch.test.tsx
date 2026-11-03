import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type Pattern } from '../api'
import PatternPage from './PatternPage'
import PatternResearchRecords from './PatternResearchRecords'

vi.mock('../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const bars = Array.from({ length: 10 }, (_, i) => ({ trade_date: `2026-09-${String(i + 1).padStart(2, '0')}`, open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i }))
const template: Pattern = { id: 'research-pattern', name: '研究形态', version: 2, note: '原备注', input_type: 'drawing', representation: 'price_path', target_bars: 10, points: bars.map(bar => bar.close), candlesticks: [], params: { min_similarity: 80 }, created_at: '2026-09-10' }
const candidate = { stock_code: '600001.SH', bars, similarity: 88, start_date: '2026-09-01', end_date: '2026-09-10' }
const result = { ...candidate, items: [candidate], search_run_id: 'run1', as_of: '2026-09-10' }
const run = { id: 'run1', name: template.name, requested_as_of: '2026-09-10', as_of: '2026-09-10', created_at: '2026-09-10T12:00:00Z', selected_key: '', note: '', template, request: {}, result }
beforeEach(() => {
  vi.clearAllMocks()
  mocked.mockImplementation(async (path, init) => {
    if (path === '/patterns') return init?.method === 'POST' ? { ...template, ...JSON.parse(String(init.body)), id: 'copy-id', version: 1 } : { items: [template] }
    if (path === '/patterns?include_history=true') return { items: [template, { ...template, version: 1, note: '第一版' }] }
    if (path === '/patterns/search-runs') return { items: [run] }
    if (path === '/patterns/search-runs/run1') return init?.method === 'PATCH' ? { ...run, ...JSON.parse(String(init.body)) } : run
    if (path === '/security-catalog') return { items: [] }
    return result
  })
})
async function loadTemplate() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  await user.click(await screen.findByRole('button', { name: '载入对照' }))
  await user.click(screen.getByLabelText('模板备注').closest('details')!.querySelector('summary')!)
  return user
}
it('shows separate contracts and copies a selected historical version without its identity', async () => {
  render(<PatternPage />)
  const user = await loadTemplate()
  expect(screen.getByLabelText('模板备注')).toHaveValue('原备注')
  expect(screen.queryByText(/不是当前选股命中列表/)).not.toBeInTheDocument()
  expect(screen.queryByLabelText('检索截止日')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '查看历史版本' }))
  await user.selectOptions(await screen.findByLabelText('模板版本'), '1')
  expect(screen.getByLabelText('模板备注')).toHaveValue('第一版')
  await user.click(screen.getByRole('button', { name: '另存为副本' }))
  await waitFor(() => expect(mocked.mock.calls.some(([path, init]) => path === '/patterns' && init?.method === 'POST')).toBe(true))
  const body = JSON.parse(String(mocked.mock.calls.find(([path, init]) => path === '/patterns' && init?.method === 'POST')![1]!.body))
  expect(body.id).toBeUndefined()
  expect(body.note).toBe('第一版')
  expect(body.name).toBe('研究形态 副本')
})
it('ignores a legacy editor cutoff and starts new searches with latest market data', async () => {
  const view = render(<PatternPage />)
  const user = await loadTemplate()
  view.unmount()
  const snapshot = JSON.parse(sessionStorage.getItem('pattern.editor') || '{}')
  const target = snapshot.target
  sessionStorage.setItem('pattern.editor', JSON.stringify({ ...target, panel: 'create', asOf: '2026-09-10', marketSelection: snapshot.market, imageData: target.image.data, savedImageUrl: target.image.url, imageMime: target.image.mime, imageName: target.image.name, crop: target.image.crop }))
  render(<PatternPage />)
  expect(screen.queryByLabelText('检索截止日')).not.toBeInTheDocument()
  await user.click(await screen.findByRole('button', { name: '匹配相似形态' }))
  await waitFor(() => expect(mocked).toHaveBeenCalledWith('/patterns/research-pattern/search?version=2&limit=12', expect.objectContaining({ method: 'POST' })))
  expect(mocked.mock.calls.filter(([path]) => path.includes('/search?')).every(([path]) => !path.includes('as_of='))).toBe(true)
})
it('opens persisted snapshots by keyboard and patches notes and selected examples', async () => {
  render(<PatternResearchRecords />)
  const user = userEvent.setup()
  const summary = screen.getByRole('button', { name: '研究记录' })
  summary.focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('button', { name: /研究形态 ·/ }))
  const record = await screen.findByRole('region', { name: '冻结检索记录' })
  expect(within(record).getByRole('img', { name: '冻结目标走势' })).toBeInTheDocument()
  expect(screen.getByText(/未冻结全部原始行情/)).toBeInTheDocument()
  await user.type(screen.getByLabelText('研究记录备注'), '需进一步核对')
  await user.click(screen.getByRole('button', { name: '保存研究备注' }))
  await waitFor(() => expect(mocked).toHaveBeenCalledWith('/patterns/search-runs/run1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ note: '需进一步核对' }) })))
  await user.click(within(record).getByRole('button', { name: /查看 600001.SH/ }))
  await waitFor(() => expect(mocked).toHaveBeenCalledWith('/patterns/search-runs/run1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ selected_key: '600001.SH@2026-09-01' }) })))
})
it('ignores historical version responses after switching templates', async () => {
  const other = { ...template, id: 'other', name: '另一形态', version: 7 }
  let resolve!: (value: { items: Pattern[] }) => void
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns' && !init ? Promise.resolve({ items: [template, other] }) : path === '/patterns?include_history=true' ? new Promise(done => { resolve = done }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  const first = (await screen.findByRole('heading', { name: '研究形态' })).closest('article')!
  await user.click(within(first).getByRole('button', { name: '载入对照' }))
  await user.click(screen.getByLabelText('模板备注').closest('details')!.querySelector('summary')!)
  await user.click(screen.getByRole('button', { name: '查看历史版本' }))
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  await user.click(within(screen.getByRole('heading', { name: '另一形态' }).closest('article')!).getByRole('button', { name: '载入对照' }))
  await act(async () => resolve({ items: [template] }))
  expect(screen.getByLabelText('模板名称')).toHaveValue('另一形态')
  expect(screen.queryByLabelText('模板版本')).not.toBeInTheDocument()
})
it('locks template edits while a save is pending', async () => {
  render(<PatternPage />)
  const user = await loadTemplate()
  fireEvent.change(screen.getByLabelText('模板备注'), { target: { value: '待保存' } })
  let resolve!: (value: Pattern) => void
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns' && init?.method === 'POST' ? new Promise(done => { resolve = done }) : initial(path, init))
  await user.click(screen.getByRole('button', { name: '保存模板' }))
  expect(screen.getByLabelText('模板备注')).toBeDisabled()
  expect(screen.getByLabelText('模板名称')).toBeDisabled()
  expect(screen.getByLabelText('最低相似度')).toBeDisabled()
  await act(async () => resolve({ ...template, version: 3, note: '待保存' }))
  expect(screen.getByLabelText('模板备注')).toHaveValue('待保存')
})
it('serializes rapid example selections so the saved snapshot keeps the latest choice', async () => {
  const second = { ...candidate, stock_code: '600002.SH' }
  const multiple = { ...result, items: [candidate, second] }
  let selected = '', release!: () => void
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation(async (path, init) => {
    if (path === '/patterns/research-pattern/search?version=2&limit=12') return multiple
    if (path === '/patterns/search-runs/run1' && init?.method === 'PATCH') {
      const key = JSON.parse(String(init.body)).selected_key
      if (key.startsWith('600001')) await new Promise<void>(done => { release = done })
      selected = key
      return { ...run, result: multiple, selected_key: selected }
    }
    if (path === '/patterns/search-runs/run1') return { ...run, result: multiple, selected_key: selected }
    return initial(path, init)
  })
  const view = render(<PatternPage />)
  const user = await loadTemplate()
  await user.click(screen.getByRole('button', { name: '匹配相似形态' }))
  await user.click(await screen.findByRole('button', { name: /查看 600001.SH/ }))
  await user.click(screen.getByRole('button', { name: /查看 600002.SH/ }))
  expect(mocked.mock.calls.filter(([path, init]) => path === '/patterns/search-runs/run1' && init?.method === 'PATCH')).toHaveLength(1)
  await act(async () => release())
  await waitFor(() => expect(selected).toBe('600002.SH@2026-09-01'))
  view.unmount()
  render(<PatternResearchRecords />)
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  await user.click(await screen.findByRole('button', { name: /研究形态 ·/ }))
  expect(await screen.findByRole('button', { name: /查看 600002.SH/ })).toHaveAttribute('aria-pressed', 'true')
})
it('does not attach an old example-save error to a new search', async () => {
  let reject!: (reason: Error) => void
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns/search-runs/run1' && init?.method === 'PATCH' ? new Promise((_resolve, fail) => { reject = fail }) : initial(path, init))
  render(<PatternPage />)
  const user = await loadTemplate()
  await user.click(screen.getByRole('button', { name: '匹配相似形态' }))
  await user.click(await screen.findByRole('button', { name: /查看 600001.SH/ }))
  await waitFor(() => expect(reject).toBeTypeOf('function'))
  await user.click(screen.getByRole('button', { name: '匹配相似形态' }))
  await act(async () => reject(new Error('旧请求失败')))
  expect(screen.queryByText(/旧请求失败/)).not.toBeInTheDocument()
})
it('labels manual OHLC snapshot paths and shows exact candles without fabricated dates', async () => {
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns/search-runs/run1' && !init ? Promise.resolve({ ...run, template: { ...template, representation: 'ohlc_sequence', candlesticks: [{ open: 3, high: 5, low: 2, close: 4 }] } }) : initial(path, init))
  render(<PatternResearchRecords />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  await user.click(await screen.findByRole('button', { name: /研究形态 ·/ }))
  expect(await screen.findByRole('img', { name: '冻结目标收盘路径' })).toBeInTheDocument()
  await user.click(screen.getByText('模板蜡烛明细（按序号）'))
  expect(screen.getByRole('table')).toHaveTextContent('13524')
  expect(screen.getByText(/不附会真实交易日期/)).toBeInTheDocument()
})

it('reviews a historical record without transferring its cutoff to a new search', async () => {
  render(<PatternPage />)
  const user = await loadTemplate()
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  await user.click(await screen.findByRole('button', { name: /研究形态 ·/ }))
  const dialog = screen.getByRole('dialog', { name: '研究记录' })
  await user.click(await within(dialog).findByText('冻结请求与模板口径'))
  expect(within(dialog).getByText(/请求截止：2026-09-10/)).toBeVisible()
  await user.click(within(dialog).getByRole('button', { name: '关闭研究记录' }))
  expect(screen.getByLabelText('模板名称')).toHaveValue('研究形态')
  await user.click(await screen.findByRole('button', { name: '匹配相似形态' }))
  await waitFor(() => expect(mocked).toHaveBeenCalledWith('/patterns/research-pattern/search?version=2&limit=12', expect.objectContaining({ method: 'POST' })))
  expect(mocked.mock.calls.filter(([path]) => path.includes('/search?')).every(([path]) => !path.includes('as_of='))).toBe(true)
})

it('does not restore pre-save history after the current template advances a version', async () => {
  const initial = mocked.getMockImplementation()!
  let finish!: (value: { items: Pattern[] }) => void
  mocked.mockImplementation((path, init) => {
    if (path === '/patterns?include_history=true') return new Promise(done => { finish = done })
    if (path === '/patterns' && init?.method === 'POST') return Promise.resolve({ ...template, version: 3, note: '新备注' })
    return initial(path, init)
  })
  render(<PatternPage />)
  const user = await loadTemplate()
  await user.click(screen.getByRole('button', { name: '查看历史版本' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  fireEvent.change(screen.getByLabelText('模板备注'), { target: { value: '新备注' } })
  await user.click(screen.getByRole('button', { name: '保存模板' }))
  await screen.findByText('已保存 研究形态 v3')
  await act(async () => finish({ items: [template, { ...template, version: 1 }] }))
  expect(screen.queryByLabelText('模板版本')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看历史版本' })).toBeEnabled()
  expect(screen.getByLabelText('模板备注')).toHaveValue('新备注')
})
