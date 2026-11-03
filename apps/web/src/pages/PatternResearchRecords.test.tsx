import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type Pattern } from '../api'
import PatternResearchRecords, { type SearchRun } from './PatternResearchRecords'

vi.mock('../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const bars = Array.from({ length: 10 }, (_, index) => ({ trade_date: `2026-09-${String(index + 1).padStart(2, '0')}`, open: 10 + index, high: 12 + index, low: 9 + index, close: 11 + index }))
const template: Pattern = { id: 'template-1', name: '冻结目标', version: 2, note: '原模板备注', input_type: 'drawing', representation: 'price_path', target_bars: 10, points: bars.map(bar => bar.close), candlesticks: [], params: { min_similarity: 80 }, created_at: '2026-09-10' }
const candidates = ['600001.SH', '600002.SH'].map(stock_code => ({ stock_code, bars, similarity: 88, start_date: '2026-09-01', end_date: '2026-09-10' }))
const first: SearchRun = { id: 'run1', name: '第一条研究', created_at: '2026-09-12T12:00:00Z', requested_as_of: '2026-09-12', as_of: '2026-09-10', selected_key: '600001.SH@2026-09-01', note: '原研究备注', template, request: { as_of: '2026-09-12' }, result: { ...candidates[0], items: candidates, requested_as_of: '2026-09-12', as_of: '2026-09-10' } }
const second: SearchRun = { ...first, id: 'run2', name: '第二条研究', note: '另一条备注', requested_as_of: null, template: { ...template, name: '第二个冻结目标' }, result: { ...first.result, requested_as_of: undefined } }
let records: Record<string, SearchRun>
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
beforeEach(() => {
  records = { run1: structuredClone(first), run2: structuredClone(second) }
  mocked.mockImplementation(async (path, init) => {
    if (path === '/patterns/search-runs') return { items: Object.values(records) }
    const id = path.split('/').at(-1)!
    if (init?.method === 'PATCH') records[id] = { ...records[id], ...JSON.parse(String(init.body)) }
    if (records[id]) return structuredClone(records[id])
    throw new Error(`Unexpected request ${path}`)
  })
})
async function openRecord(id = 'run1') {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  await user.click(await screen.findByRole('button', { name: new RegExp(records[id].name + ' ·') }))
  await screen.findByRole('region', { name: '冻结检索记录' })
  return user
}
const patchCalls = () => mocked.mock.calls.filter(([, init]) => init?.method === 'PATCH')

it('keeps only a toolbar entry in the page and opens an isolated accessible drawer', async () => {
  const user = userEvent.setup()
  const { container } = render(<><button>页面按钮</button><PatternResearchRecords /></>)
  const trigger = screen.getByRole('button', { name: '研究记录' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(mocked).not.toHaveBeenCalled()
  trigger.focus()
  await user.keyboard('{Enter}')
  const dialog = screen.getByRole('dialog', { name: '研究记录' })
  expect(dialog).toHaveAttribute('aria-modal', 'true')
  expect(container).not.toContainElement(dialog)
  expect(container).toHaveAttribute('inert')
  expect(document.body.style.overflow).toBe('hidden')
  expect(screen.getByRole('button', { name: '关闭研究记录' })).toHaveFocus()
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(trigger.getAttribute('aria-controls')).toBe(dialog.id)
  await user.click(screen.getByRole('button', { name: '关闭研究记录' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(container).not.toHaveAttribute('inert')
  expect(document.body.style.overflow).toBe('')
  expect(trigger).toHaveFocus()
})

it('traps Tab in both directions and closes on Escape without consuming IME Escape', async () => {
  render(<PatternResearchRecords />)
  const user = await openRecord()
  const close = screen.getByRole('button', { name: '关闭研究记录' })
  const note = screen.getByLabelText('研究记录备注')
  note.focus()
  await user.tab()
  expect(close).toHaveFocus()
  await user.tab({ shift: true })
  expect(note).toHaveFocus()
  fireEvent.keyDown(note, { key: 'Escape', isComposing: true })
  expect(screen.getByRole('dialog', { name: '研究记录' })).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '研究记录' })).toHaveFocus()
})

it('only backdrop-target presses dismiss and restores a pre-existing inert attribute', async () => {
  const prior = document.createElement('div')
  prior.setAttribute('inert', 'existing')
  document.body.append(prior)
  const { unmount } = render(<PatternResearchRecords />)
  const user = await openRecord()
  const dialog = screen.getByRole('dialog', { name: '研究记录' })
  await user.click(within(dialog).getByRole('heading', { name: '研究记录' }))
  expect(dialog).toBeInTheDocument()
  fireEvent.mouseDown(dialog.parentElement!)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(prior.getAttribute('inert')).toBe('existing')
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  unmount()
  expect(document.body.style.overflow).toBe('')
  expect(prior.getAttribute('inert')).toBe('existing')
  prior.remove()
})

it('ignores a record response arriving after close and a newer reopen request', async () => {
  const older = deferred<SearchRun>(), newer = deferred<SearchRun>()
  const initial = mocked.getMockImplementation()!
  let reads = 0
  mocked.mockImplementation((path, init) => path === '/patterns/search-runs/run1' && !init ? ++reads === 1 ? older.promise : newer.promise : initial(path, init))
  render(<PatternResearchRecords />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  await user.click(await screen.findByRole('button', { name: /第一条研究 ·/ }))
  await waitFor(() => expect(reads).toBe(1))
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  await waitFor(() => expect(reads).toBe(2))
  await act(async () => older.resolve({ ...first, note: '过时响应' }))
  expect(screen.queryByLabelText('研究记录备注')).not.toBeInTheDocument()
  await act(async () => newer.resolve({ ...first, note: '最新已存备注' }))
  expect(await screen.findByLabelText('研究记录备注')).toHaveValue('最新已存备注')
})

it('ignores late list responses and errors from a closed drawer', async () => {
  const older = deferred<{ items: SearchRun[] }>(), newer = deferred<{ items: SearchRun[] }>()
  const initial = mocked.getMockImplementation()!
  let lists = 0
  mocked.mockImplementation((path, init) => path === '/patterns/search-runs' ? ++lists === 1 ? older.promise : newer.promise : initial(path, init))
  render(<PatternResearchRecords />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  await waitFor(() => expect(lists).toBe(1))
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  await waitFor(() => expect(lists).toBe(2))
  await act(async () => newer.resolve({ items: [second] }))
  await act(async () => older.reject(new Error('旧列表失败')))
  expect(await screen.findByRole('button', { name: /第二条研究 ·/ })).toBeInTheDocument()
  expect(screen.queryByText('旧列表失败')).not.toBeInTheDocument()
})

it('keeps rapid record navigation on the latest record', async () => {
  const older = deferred<SearchRun>()
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns/search-runs/run1' && !init ? older.promise : initial(path, init))
  render(<PatternResearchRecords />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  await user.click(await screen.findByRole('button', { name: /第一条研究 ·/ }))
  await user.click(screen.getByRole('button', { name: /第二条研究 ·/ }))
  expect(await screen.findByLabelText('研究记录备注')).toHaveValue('另一条备注')
  await act(async () => older.resolve(first))
  expect(screen.getByLabelText('研究记录备注')).toHaveValue('另一条备注')
  expect(screen.getByRole('heading', { name: '第二个冻结目标' })).toBeInTheDocument()
})

it('reviews old cutoff and frozen content only inside the record without changing the editor', async () => {
  render(<><input aria-label="当前编辑内容" defaultValue="正在编辑的新目标" /><PatternResearchRecords /></>)
  const user = await openRecord()
  const details = screen.getByText('冻结请求与模板口径').closest('details')!
  expect(details).not.toHaveAttribute('open')
  await user.click(screen.getByText('冻结请求与模板口径'))
  expect(details).toHaveTextContent('请求截止：2026-09-12；实际行情截止：2026-09-10')
  expect(details).toHaveTextContent('未冻结全部原始行情')
  expect(screen.getByRole('img', { name: '冻结目标走势' })).toBeInTheDocument()
  expect(screen.queryByLabelText('检索截止日')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /查看 600002.SH/ }))
  await waitFor(() => expect(patchCalls()).toHaveLength(1))
  expect(JSON.parse(String(patchCalls()[0][1]?.body))).toEqual({ selected_key: '600002.SH@2026-09-01' })
  await user.keyboard('{Escape}')
  expect(screen.getByLabelText('当前编辑内容')).toHaveValue('正在编辑的新目标')
  expect(mocked.mock.calls.every(([path]) => path.startsWith('/patterns/search-runs'))).toBe(true)
})

it('serializes rapid selections and preserves the final choice across close and reopen', async () => {
  const gate = deferred<void>()
  const initial = mocked.getMockImplementation()!
  let selections = 0
  mocked.mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH' && JSON.parse(String(init.body)).selected_key && ++selections === 1) await gate.promise
    return initial(path, init)
  })
  render(<PatternResearchRecords />)
  const user = await openRecord()
  await user.click(screen.getByRole('button', { name: /查看 600002.SH/ }))
  await user.click(screen.getByRole('button', { name: /查看 600001.SH/ }))
  expect(patchCalls()).toHaveLength(1)
  expect(screen.getByRole('button', { name: /查看 600001.SH/ })).toHaveAttribute('aria-pressed', 'true')
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  expect(screen.queryByLabelText('研究记录备注')).not.toBeInTheDocument()
  await act(async () => gate.resolve())
  await waitFor(() => expect(patchCalls()).toHaveLength(2))
  expect(await screen.findByRole('button', { name: /查看 600001.SH/ })).toHaveAttribute('aria-pressed', 'true')
  expect(records.run1.selected_key).toBe('600001.SH@2026-09-01')
})

it('preserves newer typing during a note save and keeps drafts while changing records', async () => {
  const gate = deferred<void>()
  const initial = mocked.getMockImplementation()!
  let saves = 0
  mocked.mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH' && 'note' in JSON.parse(String(init.body)) && ++saves === 1) await gate.promise
    return initial(path, init)
  })
  render(<PatternResearchRecords />)
  const user = await openRecord()
  fireEvent.change(screen.getByLabelText('研究记录备注'), { target: { value: '先提交的备注' } })
  await user.click(screen.getByRole('button', { name: '保存研究备注' }))
  expect(screen.getByRole('button', { name: '保存研究备注' })).toBeDisabled()
  expect(screen.getByLabelText('研究记录备注')).toBeEnabled()
  fireEvent.change(screen.getByLabelText('研究记录备注'), { target: { value: '保存期间继续输入' } })
  await act(async () => gate.resolve())
  await waitFor(() => expect(screen.getByRole('button', { name: '保存研究备注' })).toBeEnabled())
  expect(screen.getByLabelText('研究记录备注')).toHaveValue('保存期间继续输入')
  expect(records.run1.note).toBe('先提交的备注')
  await user.click(screen.getByRole('button', { name: /第二条研究 ·/ }))
  expect(await screen.findByLabelText('研究记录备注')).toHaveValue('另一条备注')
  await user.click(screen.getByRole('button', { name: /第一条研究 ·/ }))
  expect(await screen.findByLabelText('研究记录备注')).toHaveValue('保存期间继续输入')
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  expect(await screen.findByLabelText('研究记录备注')).toHaveValue('保存期间继续输入')
  await user.click(screen.getByRole('button', { name: '保存研究备注' }))
  await waitFor(() => expect(records.run1.note).toBe('保存期间继续输入'))
})

it('keeps unsaved notes when selection saves complete and recovers a failed selection', async () => {
  const initial = mocked.getMockImplementation()!
  let fail = true
  mocked.mockImplementation((path, init) => {
    if (init?.method === 'PATCH' && fail) { fail = false; return Promise.reject(new Error('记录更新失败')) }
    return initial(path, init)
  })
  render(<PatternResearchRecords />)
  const user = await openRecord()
  fireEvent.change(screen.getByLabelText('研究记录备注'), { target: { value: '仍未保存的笔记' } })
  await user.click(screen.getByRole('button', { name: /查看 600002.SH/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('记录更新失败')
  expect(screen.getByRole('button', { name: /查看 600001.SH/ })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: /查看 600002.SH/ }))
  await waitFor(() => expect(records.run1.selected_key).toBe('600002.SH@2026-09-01'))
  expect(screen.getByLabelText('研究记录备注')).toHaveValue('仍未保存的笔记')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('does not display an old save failure after closing and reopening', async () => {
  const oldSave = deferred<SearchRun>()
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => init?.method === 'PATCH' ? oldSave.promise : initial(path, init))
  render(<PatternResearchRecords />)
  const user = await openRecord()
  fireEvent.change(screen.getByLabelText('研究记录备注'), { target: { value: '保留未保存备注' } })
  await user.click(screen.getByRole('button', { name: '保存研究备注' }))
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '研究记录' }))
  await act(async () => oldSave.reject(new Error('旧保存失败')))
  expect(await screen.findByLabelText('研究记录备注')).toHaveValue('保留未保存备注')
  expect(screen.queryByText('旧保存失败')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '保存研究备注' })).toBeEnabled()
})

it('keeps derived market provenance in details without substituting original market geometry', async () => {
  records.run1.template = { ...template, input_type: 'drawing', points: [3, 2, 4], market_source: null, derivation: {
    origin_type: 'market_window', source_window_id: 'window-original', source_pattern_id: 'original-template', source_pattern_version: 3,
    market_source: { snapshot_id: 'window-original', stock_code: '600099.SH', requested_start_date: '2026-09-01', requested_end_date: '2026-09-12', start_date: '2026-09-01', end_date: '2026-09-10', price_basis: 'unadjusted', bars, created_at: '2026-09-12' },
  } }
  render(<PatternResearchRecords />)
  const user = await openRecord()
  const details = screen.getByText('冻结请求与模板口径').closest('details')!
  expect(details).not.toHaveAttribute('open')
  expect(within(details).getByText('来源：手绘 · 派生自行情区间')).not.toBeVisible()
  const target = screen.getByRole('region', { name: '记录目标形态' })
  expect(within(target).getByRole('img', { name: '冻结目标走势' }).querySelector('polyline')).toHaveAttribute('points', '10,80 300,150 590,10')
  expect(target.querySelector('.pattern-comparison-plot')).toBeNull()
  await user.click(within(details).getByText('冻结请求与模板口径'))
  expect(details).toHaveTextContent('来源模板：original-template · v3')
  expect(details).toHaveTextContent('派生行情来源：600099.SH · 2026-09-01 — 2026-09-10 · 未复权 · 快照 window-original')
  expect(within(details).queryByRole('link')).not.toBeInTheDocument()
})

it('preserves original prompt and screenshot metadata in derived snapshot details without raw image links', async () => {
  const sourceImage = { filename: '原始研究截图.png', mime_type: 'image/png' as const, sha256: 'original-image-digest' }
  records.run1.template = { ...template, input_type: 'drawing', source_image: sourceImage, params: { screenshot_quality: { confidence: .92 } }, derivation: { origin_type: 'screenshot', source_image: sourceImage } }
  records.run2.template = { ...template, input_type: 'drawing', derivation: { origin_type: 'natural_language', source_draft_id: 'draft-original', provenance: { draft_id: 'draft-original', prompt: '先横盘再缓慢上行', source: 'model', model: null, compiler_version: '1', assumptions: [] } } }
  render(<PatternResearchRecords />)
  const user = await openRecord()
  await user.click(screen.getByText('冻结请求与模板口径'))
  let details = screen.getByText('冻结请求与模板口径').closest('details')!
  expect(details).toHaveTextContent('来源：手绘 · 派生自截图')
  expect(details).toHaveTextContent('原始截图：原始研究截图.png')
  expect(details).toHaveTextContent('此记录保存目标与来源元数据，原图不包含在结果快照内')
  expect(details).toHaveTextContent('"confidence":0.92')
  expect(details).not.toHaveTextContent('不保存未入库原图')
  expect(within(details).queryByRole('link')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /第二条研究 ·/ }))
  await screen.findByLabelText('研究记录备注')
  await user.click(screen.getByText('冻结请求与模板口径'))
  details = screen.getByText('冻结请求与模板口径').closest('details')!
  expect(details).toHaveTextContent('来源：手绘 · 派生自文字')
  expect(details).toHaveTextContent('原始文字：先横盘再缓慢上行')
  expect(details).toHaveTextContent('来源文字草稿：draft-original')
})


it('rereads a zero-result frozen record without creating a new search', async () => {
  records.run1.result = { bars: [], items: [], reason: '该次冻结检索没有可用样本', as_of: '2026-09-10' }
  render(<PatternResearchRecords />)
  const user = await openRecord()
  const record = screen.getByRole('region', { name: '冻结检索记录' })
  const frozenPath = within(record).getByRole('img', { name: '冻结目标走势' }).querySelector('polyline')?.getAttribute('points')
  expect(within(record).getByRole('status')).toHaveTextContent('该次冻结检索没有可用样本')
  expect(within(record).queryByRole('region', { name: '候选K线对照' })).not.toBeInTheDocument()
  expect(within(record).queryByRole('complementary', { name: '相似K线样本' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '重新匹配' })).not.toBeInTheDocument()
  await user.click(within(record).getByRole('button', { name: '重新读取记录' }))
  await waitFor(() => expect(mocked.mock.calls.filter(([path]) => path === '/patterns/search-runs/run1')).toHaveLength(2))
  const restored = await screen.findByRole('region', { name: '冻结检索记录' })
  expect(within(restored).getByRole('img', { name: '冻结目标走势' }).querySelector('polyline')?.getAttribute('points')).toBe(frozenPath)
  expect(within(restored).getByRole('status')).toHaveTextContent('该次冻结检索没有可用样本')
  expect(mocked.mock.calls.every(([path, init]) => path.startsWith('/patterns/search-runs') && !init?.method)).toBe(true)
})
