import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type Pattern } from '../api'
import { choosePatternInput, patternInputActions } from '../test/patternInputActions'
import PatternPage from './PatternPage'
import { emptyImage, emptyTarget, type Target, type Workspace } from './patternWorkspace'

vi.mock('../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const bars = Array.from({ length: 10 }, (_, index) => ({ trade_date: `2026-09-${String(index + 1).padStart(2, '0')}`, open: 10 + index, high: 12 + index, low: 9 + index, close: 11 + index }))
const saved: Pattern = { id: 'layout-target', name: '原有目标', note: '保留原备注', version: 3, input_type: 'drawing', representation: 'price_path', target_bars: 10, points: bars.map((_, index) => index / 9), candlesticks: [], params: {}, created_at: '2026-09-10' }
const draft = { id: 'layout-draft', prompt: '近20个交易日的双底形态', status: 'ready', name: '文字候选', points: [0.9, 0.1, 0.8, 0.1, 0.9], target_bars: 20, min_similarity: 80, assumptions: ['只比较形状'], issues: [], description: '归一化路径' }
const sample = { stock_code: '600000.SH', similarity: 92, start_date: '2026-09-01', end_date: '2026-09-10', bars }
const result = { ...sample, items: [sample], scope: '本地真实行情' }
const readyTarget = (): Target => ({ ...emptyTarget(), activeId: saved.id, version: saved.version, name: saved.name, note: saved.note!, targetBars: 10, rawPoints: saved.points.map((y, index) => ({ x: index / 9, y })) })

beforeEach(() => {
  vi.clearAllMocks()
  mocked.mockImplementation(async path => {
    if (path === '/patterns') return { items: [saved] }
    if (path === '/patterns/draft') return draft
    return { bars: [], items: [], reason: '暂无相似样本' }
  })
})

function target() { return screen.getByRole('region', { name: '目标形态' }) }
function comparison() { return screen.getByRole('region', { name: '形态对照工作台' }) }
function targetPath() { return within(target()).getByRole('img', { name: '走势曲线编辑区' }).querySelector('polyline')?.getAttribute('points') }
function restore(targetValue = readyTarget(), extra: Partial<Workspace> = {}) {
  sessionStorage.setItem('pattern.editor', JSON.stringify({ schemaVersion: 2, target: targetValue, activeTool: null, market: { code: '', start: '', end: '' }, image: emptyImage(), prompt: '', candidate: null, undo: null, panel: 'create', ...extra }))
}
function expectNoResults() {
  expect(comparison()).toHaveAttribute('data-has-results', 'false')
  expect(screen.queryByRole('region', { name: '候选K线对照' })).not.toBeInTheDocument()
  expect(screen.queryByRole('complementary', { name: '相似K线样本' })).not.toBeInTheDocument()
  expect(screen.queryByRole('group', { name: '对照显示方式' })).not.toBeInTheDocument()
}
function expectNoTargetControls(allowDrawingMenu = false) {
  if (!allowDrawingMenu) expect(screen.queryByRole('button', { name: '创建目标' })).not.toBeInTheDocument()
  for (const name of [ '替换目标', '手工编辑', '转为手工编辑', '复制为自定义形态', '保存模板', '匹配相似形态']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  }
  expect(screen.queryByLabelText('模板名称')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('模板备注')).not.toBeInTheDocument()
}
function expectNoChart() {
  expect(within(target()).queryByRole('img', { name: '走势曲线编辑区' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '走势曲线' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '蜡烛图' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '专注绘图' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('目标交易日数')).not.toBeInTheDocument()
}
async function escapeTool(user: ReturnType<typeof userEvent.setup>) {
  const picker = screen.queryByRole('combobox', { name: '来源股票' })
  if (picker?.getAttribute('aria-expanded') === 'true') {
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '输入工具' })).toBeInTheDocument()
    expect(picker).toHaveFocus()
  }
  await user.keyboard('{Escape}')
}
async function generate(user: ReturnType<typeof userEvent.setup>) {
  await choosePatternInput(user, '描述目标走势')
  fireEvent.change(screen.getByLabelText('形态需求描述'), { target: { value: draft.prompt } })
  await user.click(screen.getByRole('button', { name: '生成形态草稿' }))
  return screen.findByRole('region', { name: '建议候选形态' })
}

it('starts with exactly four creation actions and no premature editor, save form or results', () => {
  render(<PatternPage />)
  expect(target()).toHaveAttribute('data-state', 'empty')
  expect(within(target()).getAllByRole('button')).toHaveLength(4)
  for (const name of patternInputActions) expect(within(target()).getByRole('button', { name })).toBeVisible()
  expect(screen.queryByRole('region', { name: '输入工具' })).not.toBeInTheDocument()
  expectNoTargetControls()
  expectNoChart()
  expectNoResults()
})

it.each(patternInputActions)('shows only the selected blank input tool, then restores %s on Close and Escape', async name => {
  render(<PatternPage />)
  const user = userEvent.setup()
  for (const dismiss of ['close', 'escape']) {
    await user.click(screen.getByRole('button', { name }))
    expect(target()).toHaveAttribute('data-state', 'input')
    expect(screen.queryByRole('group', { name: '创建目标方式' })).not.toBeInTheDocument()
    const tool = screen.getByRole('region', { name: '输入工具' })
    expect(tool.querySelector('header')).toHaveTextContent(name)
    expectNoTargetControls(name === '绘制新形态')
    expectNoResults()
    if (name === '绘制新形态') {
      expect(within(target()).getByRole('img', { name: '走势曲线编辑区' })).toHaveFocus()
      expect(screen.getByRole('button', { name: '走势曲线' })).toBeVisible()
      expect(screen.getByRole('button', { name: '蜡烛图' })).toBeEnabled()
      expect(screen.getAllByRole('button', { name: '创建目标' })).toHaveLength(1)
    } else {
      expectNoChart()
      expect(tool).toContainElement(document.activeElement as HTMLElement)
    }
    if (dismiss === 'close') await user.click(within(tool).getByRole('button', { name: '关闭输入工具' }))
    else await escapeTool(user)
    expect(target()).toHaveAttribute('data-state', 'empty')
    expect(screen.queryByRole('region', { name: '输入工具' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name })).toHaveFocus()
    expect(within(screen.getByRole('group', { name: '创建目标方式' })).getAllByRole('button')).toHaveLength(4)
  }
})

it.each(patternInputActions)('restores Replace focus without changing a ready target after closing %s', async name => {
  restore()
  render(<PatternPage />)
  const user = userEvent.setup(), path = targetPath()
  await choosePatternInput(user, name)
  expect(target()).toHaveAttribute('data-state', 'target')
  expect(screen.queryByRole('group', { name: '创建目标方式' })).not.toBeInTheDocument()
  await escapeTool(user)
  expect(screen.getByRole('button', { name: '替换目标' })).toHaveFocus()
  expect(targetPath()).toBe(path)
  expect(screen.getByLabelText('模板名称')).toHaveValue(saved.name)
  expect(screen.getByLabelText('目标来源')).toHaveTextContent('手绘')
})

it('retains independent blank input drafts when switching tools and restoring the workspace', async () => {
  const view = render(<PatternPage />)
  const user = userEvent.setup()
  await choosePatternInput(user, '描述目标走势')
  fireEvent.change(screen.getByLabelText('形态需求描述'), { target: { value: '尚未生成的描述' } })
  await choosePatternInput(user, '截取行情区间')
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-01' } })
  fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-10' } })
  await choosePatternInput(user, '上传截图')
  await user.upload(document.querySelector('input[type=file]') as HTMLInputElement, new File(['image'], '未完成截图.png', { type: 'image/png' }))
  await screen.findByText('未完成截图.png')
  await choosePatternInput(user, '描述目标走势')
  view.unmount()
  render(<PatternPage />)
  expect(target()).toHaveAttribute('data-state', 'input')
  expect(screen.queryByRole('group', { name: '创建目标方式' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('形态需求描述')).toHaveValue('尚未生成的描述')
  expectNoChart()
  expectNoTargetControls()
  await choosePatternInput(user, '截取行情区间')
  expect(screen.getByLabelText('开始日期')).toHaveValue('2026-09-01')
  expect(screen.getByLabelText('结束日期')).toHaveValue('2026-09-10')
  await choosePatternInput(user, '上传截图')
  expect(screen.getByText('未完成截图.png')).toBeVisible()
  expect(screen.getByRole('button', { name: '提取走势候选' })).toBeEnabled()
  expect(mocked.mock.calls.some(([path]) => ['/patterns/draft', '/patterns/extract', '/patterns/market-window'].includes(path))).toBe(false)
})

it.each(['natural_language', 'screenshot', 'market_window'] as const)('preserves an empty legacy %s draft and allows drawing only after an explicit starter choice', async source => {
  const legacy = { ...emptyTarget(), source, name: '旧草稿名称', note: '旧草稿备注', sourceDraftId: '旧来源引用', panel: 'create', marketSelection: { code: '', start: '2026-08-01', end: '2026-08-20' }, imageName: '旧截图.png' }
  sessionStorage.setItem('pattern.editor', JSON.stringify(legacy))
  const view = render(<PatternPage />)
  const user = userEvent.setup()
  expect(target()).toHaveAttribute('data-state', 'input')
  expectNoTargetControls()
  expectNoChart()
  expectNoResults()
  await user.click(screen.getByRole('button', { name: '关闭输入工具' }))
  expect(target()).toHaveAttribute('data-state', 'empty')
  expectNoTargetControls()
  view.unmount()
  const stored = JSON.parse(sessionStorage.getItem('pattern.editor')!)
  expect(stored.target).toMatchObject({ source, name: legacy.name, note: legacy.note, sourceDraftId: legacy.sourceDraftId, rawPoints: [], candles: [], image: { name: legacy.imageName } })
  expect(stored.market).toEqual(legacy.marketSelection)
  render(<PatternPage />)
  await choosePatternInput(user, '绘制新形态')
  const canvas = within(target()).getByRole('img', { name: '走势曲线编辑区' })
  expect(canvas).toHaveFocus()
  expect(canvas.parentElement).toHaveClass('draw-enabled')
  expect(screen.queryByText('先将当前目标转为手工编辑。')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '蜡烛图' }))
  await user.click(screen.getByRole('button', { name: '添加蜡烛' }))
  expect(target()).toHaveAttribute('data-state', 'target')
  expect(screen.getByLabelText('模板名称')).toHaveValue(legacy.name)
  expect(screen.getByLabelText('模板备注')).toHaveValue(legacy.note)
  expect(screen.getByLabelText('CLOSE')).toBeEnabled()
  expect(screen.getByLabelText('目标来源')).toHaveTextContent('手绘')
})

it('keeps ready-target actions beside its canvas and stores the note in a collapsed disclosure', async () => {
  restore()
  render(<PatternPage />)
  const user = userEvent.setup()
  expect(target()).toHaveAttribute('data-state', 'target')
  const controls = screen.getByLabelText('模板名称').closest('.pattern-target-controls') as HTMLElement
  const actionBar = controls.closest('.pattern-comparison-match-actions')!
  expect(target().nextElementSibling).toBe(actionBar)
  expect(actionBar.parentElement).toHaveClass('pattern-comparison-charts')
  expect(within(controls).getByLabelText('模板名称')).toHaveValue(saved.name)
  expect(within(controls).getByRole('button', { name: '保存模板' })).toBeDisabled()
  expect(within(controls).getByRole('button', { name: '匹配相似形态' })).toBeEnabled()
  const note = screen.getByLabelText('模板备注'), details = note.closest('details')!
  expect(details).not.toBeNull()
  expect(details).not.toHaveAttribute('open')
  expect(note).not.toBeVisible()
  await user.click(details.querySelector('summary')!)
  expect(note).toBeVisible()
  expect(note).toHaveValue(saved.note)
  expectNoResults()
})

it('cancels a candidate without changing the target, then closes its tool and focuses Replace on application', async () => {
  restore()
  render(<PatternPage />)
  const user = userEvent.setup(), path = targetPath()
  let candidate = await generate(user)
  expect(targetPath()).toBe(path)
  await user.click(within(candidate).getByRole('button', { name: '取消候选' }))
  expect(screen.queryByRole('region', { name: '建议候选形态' })).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: '输入工具' })).toBeVisible()
  expect(targetPath()).toBe(path)
  expectNoResults()
  candidate = await generate(user)
  await user.click(within(candidate).getByRole('button', { name: '应用候选' }))
  expect(screen.queryByRole('region', { name: '输入工具' })).not.toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '建议候选形态' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '替换目标' })).toHaveFocus()
  expect(targetPath()).not.toBe(path)
  expect(screen.getByLabelText('目标来源')).toHaveTextContent('文字')
  expect(screen.getByLabelText('模板备注')).toHaveValue(saved.note)
  await user.click(screen.getByRole('button', { name: '撤销应用' }))
  expect(targetPath()).toBe(path)
  expect(screen.getByLabelText('模板名称')).toHaveValue(saved.name)
  expect(screen.getByLabelText('目标来源')).toHaveTextContent('手绘')
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
  await choosePatternInput(user, '描述目标走势')
  expect(screen.getByLabelText('形态需求描述')).toHaveValue(draft.prompt)
})

it('exits focused drawing and returns to clean starters after undoing a first applied candidate', async () => {
  render(<PatternPage />)
  const user = userEvent.setup(), candidate = await generate(user)
  expectNoChart()
  expectNoTargetControls()
  await user.click(within(candidate).getByRole('button', { name: '应用候选' }))
  expect(target()).toHaveAttribute('data-state', 'target')
  expect(screen.getByRole('button', { name: '替换目标' })).toHaveFocus()
  expect(screen.queryByRole('region', { name: '输入工具' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '专注绘图' }))
  const dialog = screen.getByRole('dialog', { name: '专注绘图' })
  await user.click(within(dialog).getByRole('button', { name: '撤销应用' }))
  expect(screen.queryByRole('dialog', { name: '专注绘图' })).not.toBeInTheDocument()
  expect(target()).toHaveAttribute('data-state', 'empty')
  expect(screen.getByRole('button', { name: '描述目标走势' })).toHaveFocus()
  expectNoChart()
  expectNoTargetControls()
  for (const name of patternInputActions) expect(screen.getByRole('button', { name })).toBeVisible()
})

it('shows compact pending feedback and expands comparison only after actual samples arrive', async () => {
  restore()
  let finish!: (value: typeof result) => void
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path.includes('/search?') ? new Promise(done => { finish = done }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup(), path = targetPath()
  await user.click(screen.getByRole('button', { name: '匹配相似形态' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(screen.getByRole('button', { name: '匹配中…' })).toBeDisabled()
  expect(screen.getByText('正在寻找相似的真实 K 线…')).toBeVisible()
  expectNoResults()
  expect(targetPath()).toBe(path)
  await act(async () => finish(result))
  expect(comparison()).toHaveAttribute('data-has-results', 'true')
  expect(screen.getByRole('region', { name: '候选K线对照' })).toBeVisible()
  expect(within(screen.getByRole('complementary', { name: '相似K线样本' })).getByRole('button', { name: /查看 600000.SH/ })).toBeVisible()
  expect(targetPath()).toBe(path)
})

it('keeps errors and zero results compact while allowing a successful retry', async () => {
  restore()
  let attempts = 0
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation(async (path, init) => {
    if (!path.includes('/search?')) return initial(path, init)
    attempts++
    if (attempts === 1) throw new Error('行情暂不可用')
    if (attempts === 2) return { bars: [], items: [], reason: '本次没有可用样本' }
    return result
  })
  render(<PatternPage />)
  const user = userEvent.setup(), path = targetPath()
  await user.click(screen.getByRole('button', { name: '匹配相似形态' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('行情暂不可用')
  expectNoResults()
  await user.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('本次没有可用样本')).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expectNoResults()
  await user.click(screen.getByRole('button', { name: '匹配相似形态' }))
  await screen.findByRole('button', { name: /查看 600000.SH/ })
  expect(comparison()).toHaveAttribute('data-has-results', 'true')
  expect(targetPath()).toBe(path)
})

it('does not reopen results when an obsolete match response arrives after starting a new blank target', async () => {
  restore()
  let finish!: (value: typeof result) => void
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path.includes('/search?') ? new Promise(done => { finish = done }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '匹配相似形态' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  await user.click(screen.getByRole('button', { name: '新建形态' }))
  await act(async () => finish(result))
  expect(target()).toHaveAttribute('data-state', 'empty')
  expectNoResults()
  expectNoTargetControls()
  expectNoChart()
  expect(screen.queryByText('正在寻找相似的真实 K 线…')).not.toBeInTheDocument()
})

it('does not restore a cancelled input response over a newly chosen blank tool', async () => {
  let finish!: (value: typeof draft) => void
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path === '/patterns/draft' ? new Promise(done => { finish = done }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await choosePatternInput(user, '描述目标走势')
  fireEvent.change(screen.getByLabelText('形态需求描述'), { target: { value: draft.prompt } })
  await user.click(screen.getByRole('button', { name: '生成形态草稿' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  await choosePatternInput(user, '上传截图')
  await act(async () => finish(draft))
  expect(target()).toHaveAttribute('data-state', 'input')
  expect(screen.getByRole('region', { name: '输入工具' }).querySelector('header')).toHaveTextContent('上传截图')
  expect(screen.queryByRole('region', { name: '建议候选形态' })).not.toBeInTheDocument()
  expectNoResults()
  expectNoTargetControls()
  expectNoChart()
})

it('keeps a ready blank candidate reviewable on tool close and returns to its starter after cancellation', async () => {
  render(<PatternPage />)
  const user = userEvent.setup(), candidate = await generate(user)
  const preview = within(candidate).getByRole('img', { name: '候选走势预览' }).querySelector('polyline')?.getAttribute('points')
  await user.click(screen.getByRole('button', { name: '关闭输入工具' }))
  expect(screen.queryByRole('region', { name: '输入工具' })).not.toBeInTheDocument()
  expect(target()).toHaveAttribute('data-state', 'input')
  expect(screen.queryByRole('group', { name: '创建目标方式' })).not.toBeInTheDocument()
  expect(within(candidate).getByRole('button', { name: '应用候选' })).toHaveFocus()
  expect(within(candidate).getByRole('img', { name: '候选走势预览' }).querySelector('polyline')?.getAttribute('points')).toBe(preview)
  expectNoTargetControls()
  expectNoChart()
  expectNoResults()
  await user.click(within(candidate).getByRole('button', { name: '取消候选' }))
  expect(screen.queryByRole('region', { name: '建议候选形态' })).not.toBeInTheDocument()
  expect(target()).toHaveAttribute('data-state', 'empty')
  expect(screen.getByRole('button', { name: '描述目标走势' })).toHaveFocus()
  await choosePatternInput(user, '描述目标走势')
  expect(screen.getByLabelText('形态需求描述')).toHaveValue(draft.prompt)
  expect(mocked.mock.calls.filter(([path]) => path === '/patterns/draft')).toHaveLength(1)
})

it('removes matched columns before drawing starts without changing the loaded target', async () => {
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path.includes('/best-match?') ? Promise.resolve(result) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  await user.click(await screen.findByRole('button', { name: '载入对照' }))
  await screen.findByRole('button', { name: /查看 600000.SH/ })
  expect(comparison()).toHaveAttribute('data-has-results', 'true')
  const canvas = within(target()).getByRole('img', { name: '走势曲线编辑区' }), path = targetPath()
  fireEvent(window, new Event('pagehide'))
  const committedTarget = JSON.parse(sessionStorage.getItem('pattern.editor')!).target
  await user.click(screen.getByRole('button', { name: '手工编辑' }))
  // No pointer event has occurred: editing must get its full canvas width up front.
  expectNoResults()
  expect(within(target()).getByRole('img', { name: '走势曲线编辑区' })).toBe(canvas)
  expect(canvas.parentElement).toHaveClass('draw-enabled')
  expect(canvas).toHaveFocus()
  expect(targetPath()).toBe(path)
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
  fireEvent(window, new Event('pagehide'))
  expect(JSON.parse(sessionStorage.getItem('pattern.editor')!).target).toEqual(committedTarget)
})

it('leaves drawing for matching and clears results before the next explicit edit', async () => {
  restore()
  let finish!: (value: typeof result) => void
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path.includes('/search?') ? new Promise(done => { finish = done }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup(), path = targetPath()
  await user.click(screen.getByRole('button', { name: '手工编辑' }))
  const canvas = within(target()).getByRole('img', { name: '走势曲线编辑区' })
  expect(canvas.parentElement).toHaveClass('draw-enabled')
  await user.click(screen.getByRole('button', { name: '匹配相似形态' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(screen.queryByRole('region', { name: '输入工具' })).not.toBeInTheDocument()
  expect(canvas.parentElement).not.toHaveClass('draw-enabled')
  expect(canvas).not.toHaveAttribute('tabindex')
  expectNoResults()
  await act(async () => finish(result))
  expect(comparison()).toHaveAttribute('data-has-results', 'true')
  expect(screen.getByRole('complementary', { name: '相似K线样本' })).toBeVisible()
  expect(canvas.parentElement).not.toHaveClass('draw-enabled')
  expect(targetPath()).toBe(path)
  await user.click(screen.getByRole('button', { name: '手工编辑' }))
  expectNoResults()
  expect(canvas.parentElement).toHaveClass('draw-enabled')
  expect(canvas).toHaveFocus()
  expect(targetPath()).toBe(path)
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
})

it('ignores a pending saved-match response after entering drawing so columns cannot return mid-stroke', async () => {
  let finish!: (value: typeof result) => void
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path.includes('/best-match?') && path.includes('&limit=12') ? new Promise(done => { finish = done }) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  await user.click(await screen.findByRole('button', { name: '载入对照' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(screen.getByText('正在寻找相似的真实 K 线…')).toBeVisible()
  const path = targetPath()
  await user.click(screen.getByRole('button', { name: '手工编辑' }))
  expectNoResults()
  expect(screen.queryByText('正在寻找相似的真实 K 线…')).not.toBeInTheDocument()
  await act(async () => finish(result))
  expectNoResults()
  expect(within(target()).getByRole('img', { name: '走势曲线编辑区' }).parentElement).toHaveClass('draw-enabled')
  expect(targetPath()).toBe(path)
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
})

it('restores a clean saved drawing session without auto-matching into the editable canvas', async () => {
  restore(readyTarget(), { activeTool: 'drawing' })
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path.includes('/best-match?') ? Promise.resolve(result) : initial(path, init))
  render(<PatternPage />)
  await waitFor(() => expect(mocked).toHaveBeenCalledWith('/patterns'))
  expect(screen.getByRole('region', { name: '输入工具' })).toBeVisible()
  expect(within(target()).getByRole('img', { name: '走势曲线编辑区' }).parentElement).toHaveClass('draw-enabled')
  expect(screen.getByLabelText('模板名称')).toHaveValue(saved.name)
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
  expectNoResults()
  expect(screen.queryByText('正在寻找相似的真实 K 线…')).not.toBeInTheDocument()
  expect(mocked.mock.calls.some(([path]) => path.includes('/best-match?'))).toBe(false)
})

it('loads a saved gallery target as a readonly preview after leaving an active drawing session', async () => {
  restore(readyTarget(), { activeTool: 'drawing', prompt: '保留独立文字输入' })
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation((path, init) => path.includes('/best-match?') ? Promise.resolve(result) : initial(path, init))
  render(<PatternPage />)
  const user = userEvent.setup(), path = targetPath()
  expect(within(target()).getByRole('img', { name: '走势曲线编辑区' }).parentElement).toHaveClass('draw-enabled')
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  await user.click(await screen.findByRole('button', { name: '载入对照' }))
  await screen.findByRole('button', { name: /查看 600000.SH/ })
  expect(screen.queryByRole('region', { name: '输入工具' })).not.toBeInTheDocument()
  expect(comparison()).toHaveAttribute('data-has-results', 'true')
  const canvas = within(target()).getByRole('img', { name: '走势曲线编辑区' })
  expect(canvas.parentElement).not.toHaveClass('draw-enabled')
  expect(canvas).not.toHaveAttribute('tabindex')
  expect(targetPath()).toBe(path)
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
  fireEvent(window, new Event('pagehide'))
  expect(JSON.parse(sessionStorage.getItem('pattern.editor')!)).toMatchObject({ activeTool: null, prompt: '保留独立文字输入' })
  expect(mocked.mock.calls.some(([request]) => request === '/patterns/layout-target/best-match?version=3&limit=12')).toBe(true)
})
