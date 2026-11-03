import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type Pattern, type PatternMarketSource } from '../api'
import PatternPage from './PatternPage'

vi.mock('../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const bars = Array.from({ length: 10 }, (_, i) => ({ trade_date: `2026-09-${String(i + 1).padStart(2, '0')}`, open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i }))
const manual: Pattern = { id: 'existing', name: '已有目标', version: 3, input_type: 'drawing', representation: 'price_path', target_bars: 10, points: bars.map((_, i) => i / 9), candlesticks: [], params: {}, created_at: '2026-09-10' }
const windowSource: PatternMarketSource = { snapshot_id: 'frozen-window', stock_code: '600000.SH', requested_start_date: '2026-09-01', requested_end_date: '2026-09-10', start_date: '2026-09-01', end_date: '2026-09-10', price_basis: 'unadjusted', bars, created_at: '2026-09-10' }
const market: Pattern = { ...manual, id: 'market-existing', name: '真实行情', input_type: 'market_window', representation: 'ohlc_sequence', points: bars.map(row => row.close), candlesticks: bars.map(({ open, high, low, close }) => ({ open, high, low, close })), market_source: windowSource }
const textDraft = { id: 'draft-id', prompt: '近20个交易日的双底形态', status: 'ready', name: '文字候选', points: [0.9, 0.1, 0.8, 0.1, 0.9], target_bars: 20, min_similarity: 80, assumptions: ['仅比较形状'], issues: [], description: '归一化路径' }
const extraction = { points: [0.9, 0.7, 0.2, 0.7, 0.9], target_bars: 60, quality: { confidence: 0.8, horizontal_coverage: 0.9, requires_manual_review: true, limitations: ['不还原真实 OHLC'] } }
beforeEach(() => {
  mocked.mockImplementation(async (path, init) => {
    if (path === '/patterns') return init?.method === 'POST' ? { ...manual, ...JSON.parse(String(init.body)), id: JSON.parse(String(init.body)).id || 'new-copy', version: 4 } : { items: [manual] }
    if (path === '/patterns/draft') return textDraft
    if (path === '/patterns/extract') return extraction
    if (path === '/patterns/market-window') return windowSource
    if (path === '/patterns/search-runs') return { items: [] }
    return { bars: [], items: [], reason: '暂无样本' }
  })
})
async function load(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  await user.click(await screen.findByRole('button', { name: '载入对照' }))
}
function targetPath() { return within(screen.getByRole('region', { name: '目标形态' })).getByRole('img').querySelector('polyline')?.getAttribute('points') }
async function generate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '文字' }))
  fireEvent.change(screen.getByLabelText('形态需求描述'), { target: { value: textDraft.prompt } })
  await user.click(screen.getByRole('button', { name: '生成形态草稿' }))
  return screen.findByRole('region', { name: '建议候选形态' })
}
function savedBody() { return JSON.parse(String(mocked.mock.calls.filter(([path, init]) => path === '/patterns' && init?.method === 'POST').at(-1)?.[1]?.body)) }

it('keeps one target while tools and their inputs are switched or closed', async () => {
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  const target = screen.getByRole('region', { name: '目标形态' }), path = targetPath()
  await user.click(screen.getByRole('button', { name: '文字' }))
  fireEvent.change(screen.getByLabelText('形态需求描述'), { target: { value: '未完成的描述' } })
  await user.click(screen.getByRole('button', { name: '行情区间' }))
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-08-01' } })
  await user.click(screen.getByRole('button', { name: '截图' }))
  expect(screen.queryByLabelText('开始日期')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '文字' }))
  expect(screen.getByLabelText('形态需求描述')).toHaveValue('未完成的描述')
  await user.click(screen.getByRole('button', { name: '行情区间' }))
  expect(screen.getByLabelText('开始日期')).toHaveValue('2026-08-01')
  await user.click(screen.getByRole('button', { name: '关闭输入工具' }))
  expect(screen.getByRole('region', { name: '目标形态' })).toBe(target)
  expect(targetPath()).toBe(path)
  expect(screen.getByLabelText('模板名称')).toHaveValue('已有目标')
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
})
it('reviews a text candidate before applying, and undo restores geometry identity and source', async () => {
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  const path = targetPath()
  const candidate = await generate(user)
  expect(targetPath()).toBe(path)
  expect(screen.getByLabelText('模板名称')).toHaveValue('已有目标')
  await user.click(within(candidate).getByRole('button', { name: '应用候选' }))
  expect(targetPath()).not.toBe(path)
  await user.click(screen.getByRole('button', { name: '撤销应用' }))
  expect(targetPath()).toBe(path)
  expect(screen.getByLabelText('模板名称')).toHaveValue('已有目标')
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
})
it('applies generated text as an explicit new version of the loaded template', async () => {
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  const candidate = await generate(user)
  await user.click(within(candidate).getByRole('button', { name: '应用候选' }))
  await user.click(screen.getByRole('button', { name: '保存模板' }))
  await waitFor(() => expect(savedBody()).toMatchObject({ id: 'existing', input_type: 'natural_language', source_draft_id: 'draft-id', target_bars: 20 }))
})
it('ignores a cancelled generation and a late response after changing tools', async () => {
  const initial = mocked.getMockImplementation()!
  let finish!: (value: typeof textDraft) => void
  mocked.mockImplementation((path, init) => path === '/patterns/draft' ? new Promise(done => { finish = done }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  const path = targetPath()
  await user.click(screen.getByRole('button', { name: '文字' }))
  fireEvent.change(screen.getByLabelText('形态需求描述'), { target: { value: textDraft.prompt } })
  await user.click(screen.getByRole('button', { name: '生成形态草稿' }))
  await user.click(screen.getByRole('button', { name: '截图' }))
  await act(async () => finish(textDraft))
  expect(screen.queryByRole('region', { name: '建议候选形态' })).not.toBeInTheDocument()
  expect(targetPath()).toBe(path)
  await user.click(screen.getByRole('button', { name: '文字' }))
  await user.click(screen.getByRole('button', { name: '生成形态草稿' }))
  await user.click(screen.getByRole('button', { name: '关闭输入工具' }))
  await act(async () => finish(textDraft))
  expect(screen.queryByRole('region', { name: '建议候选形态' })).not.toBeInTheDocument()
  expect(targetPath()).toBe(path)
})
it('keeps original market bars readonly and makes an explicit derived copy before editing', async () => {
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns' && !init ? Promise.resolve({ items: [market] }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  expect(screen.queryByLabelText('OPEN')).not.toBeInTheDocument()
  expect(screen.getByLabelText('目标交易日数')).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '复制为自定义形态' }))
  await user.click(screen.getByText('编辑蜡烛 · 10 根'))
  fireEvent.change(screen.getByLabelText('CLOSE'), { target: { value: '13' } })
  await user.click(screen.getByRole('button', { name: '保存模板' }))
  await waitFor(() => expect(savedBody()).toMatchObject({ input_type: 'drawing', derivation: { origin_type: 'market_window' } }))
  expect(savedBody().id).toBeUndefined()
  expect(savedBody().source_window_id).toBeUndefined()
  expect(savedBody().derivation.source_window_id || savedBody().derivation.source_pattern_id).toBeTruthy()
})
it('requires screenshot application and preserves its origin after conversion to manual', async () => {
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  const path = targetPath()
  await user.click(screen.getByRole('button', { name: '截图' }))
  const upload = document.querySelector('input[type=file]') as HTMLInputElement
  await user.upload(upload, new File(['image'], 'chart.png', { type: 'image/png' }))
  await user.click(screen.getByRole('button', { name: '提取走势候选' }))
  const candidate = await screen.findByRole('region', { name: '建议候选形态' })
  expect(targetPath()).toBe(path)
  await user.click(within(candidate).getByRole('button', { name: '应用候选' }))
  await user.click(screen.getByRole('button', { name: '转为手工编辑' }))
  await user.click(screen.getByRole('button', { name: '保存模板' }))
  await waitFor(() => expect(savedBody()).toMatchObject({ input_type: 'drawing', derivation: { origin_type: 'screenshot' }, source_image_filename: 'chart.png' }))
  expect(savedBody().source_image_base64).toBeTruthy()
})
it('preserves text origin after manual conversion without claiming original market data', async () => {
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  await generate(user)
  await user.click(screen.getByRole('button', { name: '应用候选' }))
  await user.click(screen.getByRole('button', { name: '转为手工编辑' }))
  await user.click(screen.getByRole('button', { name: '保存模板' }))
  await waitFor(() => expect(savedBody()).toMatchObject({ input_type: 'drawing', derivation: { origin_type: 'natural_language', source_draft_id: 'draft-id' } }))
  expect(savedBody().source_window_id).toBeUndefined()
})
it('restores the committed target and independent tool text across remount', async () => {
  const view = render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  const path = targetPath()
  await user.click(screen.getByRole('button', { name: '文字' }))
  fireEvent.change(screen.getByLabelText('形态需求描述'), { target: { value: '保留这段未生成的文字' } })
  view.unmount()
  render(<PatternPage />)
  expect(targetPath()).toBe(path)
  if (!screen.queryByLabelText('形态需求描述')) await user.click(screen.getByRole('button', { name: '文字' }))
  expect(screen.getByLabelText('形态需求描述')).toHaveValue('保留这段未生成的文字')
  expect(screen.getByLabelText('模板名称')).toHaveValue('已有目标')
})
it('does not generate text or apply a candidate from an IME confirmation key', async () => {
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  await user.click(screen.getByRole('button', { name: '文字' }))
  const input = screen.getByLabelText('形态需求描述')
  fireEvent.compositionStart(input)
  fireEvent.change(input, { target: { value: '双底' } })
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 })
  fireEvent.compositionEnd(input)
  expect(mocked.mock.calls.some(([path]) => path === '/patterns/draft')).toBe(false)
  expect(screen.getByLabelText('模板名称')).toHaveValue('已有目标')
})
it('blocks undo and editing during save instead of losing a newer draft', async () => {
  const initial = mocked.getMockImplementation()!
  let finish!: (value: Pattern) => void
  mocked.mockImplementation((path, init) => path === '/patterns' && init?.method === 'POST' ? new Promise(done => { finish = done }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  await generate(user)
  await user.click(screen.getByRole('button', { name: '应用候选' }))
  await user.click(screen.getByRole('button', { name: '保存模板' }))
  expect(screen.getByRole('button', { name: '撤销应用' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '截图' })).toBeDisabled()
  expect(screen.getByLabelText('模板名称')).toBeDisabled()
  await act(async () => finish({ ...manual, name: '文字候选', input_type: 'natural_language', version: 4 }))
  expect(screen.getByLabelText('模板名称')).toHaveValue('文字候选')
})

it('retains a saved screenshot original in an edited unsaved search snapshot', async () => {
  const original: Pattern = { ...manual, input_type: 'screenshot', source_image: { filename: 'original.png', mime_type: 'image/png', sha256: 'verified-image' } }
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns' && !init ? Promise.resolve({ items: [original] }) : initial(path, init))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) })))
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  fireEvent.change(screen.getByLabelText('模板备注'), { target: { value: '只改备注' } })
  await user.click(await screen.findByRole('button', { name: '匹配相似形态' }))
  await waitFor(() => expect(mocked.mock.calls.some(([path]) => path === '/patterns/match?limit=12')).toBe(true))
  const body = JSON.parse(String(mocked.mock.calls.find(([path]) => path === '/patterns/match?limit=12')![1]!.body))
  expect(body).toMatchObject({ input_type: 'screenshot', source_image_filename: 'original.png' })
  expect(body.source_image_base64).toBeTruthy()
})
it('restores the real manual candle count after temporarily resampling its close path', async () => {
  const original: Pattern = { ...market, input_type: 'drawing', market_source: null }
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns' && !init ? Promise.resolve({ items: [original] }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  await user.click(screen.getByRole('button', { name: '走势曲线' }))
  fireEvent.change(screen.getByLabelText('目标交易日数'), { target: { value: '20' } })
  await user.click(screen.getByRole('button', { name: '蜡烛图' }))
  expect(screen.getByLabelText('目标交易日数')).toHaveValue(10)
  expect(screen.getByRole('button', { name: '保存模板' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: '保存模板' }))
  await waitFor(() => expect(savedBody()).toMatchObject({ representation: 'ohlc_sequence', target_bars: 10 }))
  expect(savedBody().candlesticks).toHaveLength(10)
})
it('ignores screenshot extraction finishing after its input tool was cancelled', async () => {
  const initial = mocked.getMockImplementation()!
  let finish!: (value: typeof extraction) => void
  mocked.mockImplementation((path, init) => path === '/patterns/extract' ? new Promise(done => { finish = done }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  const path = targetPath()
  await user.click(screen.getByRole('button', { name: '截图' }))
  await user.upload(document.querySelector('input[type=file]') as HTMLInputElement, new File(['image'], 'chart.png', { type: 'image/png' }))
  await user.click(screen.getByRole('button', { name: '提取走势候选' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  await user.click(screen.getByRole('button', { name: '关闭输入工具' }))
  await act(async () => finish(extraction))
  expect(screen.queryByRole('region', { name: '建议候选形态' })).not.toBeInTheDocument()
  expect(targetPath()).toBe(path)
})

it('applies an explicit text similarity while retaining the shared matching window settings', async () => {
  const original: Pattern = { ...manual, params: { min_similarity: 72, match_mode: 'recent', recent_bars: 40 } }
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns' && !init ? Promise.resolve({ items: [original] }) : path === '/patterns/draft' ? Promise.resolve({ ...textDraft, min_similarity: 90 }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await load(user)
  await user.click(screen.getByRole('button', { name: '文字' }))
  fireEvent.change(screen.getByLabelText('形态需求描述'), { target: { value: '近20个交易日的双底形态，相似度至少90%' } })
  await user.click(screen.getByRole('button', { name: '生成形态草稿' }))
  await user.click(await screen.findByRole('button', { name: '应用候选' }))
  await user.click(screen.getByRole('button', { name: '保存模板' }))
  await waitFor(() => expect(savedBody().params).toMatchObject({ min_similarity: 90, match_mode: 'recent', recent_bars: 40 }))
})

it.each([
  { title: 'text prompt', item: { ...manual, input_type: 'natural_language', provenance: { draft_id: 'original-draft', prompt: '原始双底描述', source: 'local_template', model: null, compiler_version: 'shape-plan-v1', assumptions: [] } } as Pattern },
  { title: 'screenshot', item: { ...manual, input_type: 'screenshot', source_image: { filename: 'original.png', mime_type: 'image/png', sha256: 'verified-image' } } as Pattern },
  { title: 'derived market', item: { ...manual, derivation: { origin_type: 'market_window', source_window_id: 'frozen-window', market_source: windowSource } } as Pattern },
])('keeps canonical $title review separate from unfinished tool inputs', async ({ item }) => {
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns' && !init ? Promise.resolve({ items: [item] }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '文字' }))
  fireEvent.change(screen.getByLabelText('形态需求描述'), { target: { value: '尚未生成的新输入' } })
  await load(user)
  expect(screen.getByLabelText('形态需求描述')).toHaveValue('尚未生成的新输入')
  await user.click(screen.getByText('来源与口径'))
  if (item.input_type === 'natural_language') expect(screen.getByText('原始描述：原始双底描述')).toBeVisible()
  if (item.input_type === 'screenshot') expect(screen.getByRole('img', { name: '形态原始截图' })).toHaveAttribute('src', '/api/v1/patterns/existing/source-image?version=3')
  if (item.derivation) {
    expect(screen.getByText(/由行情区间转为自定义形态/)).toBeVisible()
    expect(screen.getByText(/来源 600000.SH · 2026-09-01 至 2026-09-10/)).toBeVisible()
    expect(screen.queryByText(/真实行情 · 只读/)).not.toBeInTheDocument()
  }
})
