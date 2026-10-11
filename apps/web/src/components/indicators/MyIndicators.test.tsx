import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api'
import type { DynamicIndicatorDefinition, IndicatorTrial, SavedIndicator } from '../../dynamicIndicators'
import MyIndicators, { splitIndicatorCharts } from './MyIndicators'

vi.mock('../../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const definition: DynamicIndicatorDefinition = {
  name: '成交加权偏离', description: '相对成交量加权均价的标准化偏离', formula: '(close - VWAP(window)) / volatility', original_prompt: '观察量价偏离的完整走势',
  program: { contract_version: 'python-indicator-v1', source_code: 'def compute(context, frames, params):\n    return numeric_series', required_fields: ['close', 'volume'], required_history_bars: 20, parameters: { window: 20 }, parameter_specs: { window: { label: '窗口', type: 'integer', minimum: 2, maximum: 250 } } },
  outputs: [{ name: 'deviation', label: '标准化偏离', unit: '倍', placement: 'pane', kind: 'line' }],
}
const dates = Array.from({ length: 180 }, (_, index) => new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10))
const bars = dates.map((trade_date, index) => ({ trade_date, open: 10 + index / 100, high: 11 + index / 100, low: 9 + index / 100, close: 10.5 + index / 100 }))
const trial: IndicatorTrial = { trial_id: 'trial-one', definition, definition_hash: 'hash-one', code_hash: 'code-one', stock_code: '000001.SH', as_of: '2026-06-29', actual_date: dates.at(-1)!, dates, series: { deviation: dates.map((_, index) => index < 20 ? null : index / 100) }, parameters: { window: 20 }, chart: { placement: 'pane', bars, lines: [{ id: 'deviation', label: '标准化偏离', color: '#00337a', values: dates.map((_, index) => index < 20 ? null : index / 100) }], histogram: null, reference_lines: [] }, source_context: {}, validation: { passed: true, saveable: true, warnings: ['样本校验不代表投资效果'] } }
const saved: SavedIndicator = { id: 'indicator-one', version: 2, name: definition.name, definition, definition_hash: 'hash-one', code_hash: 'code-one', trial_id: 'previous-trial', created_at: '2026-06-29' }
const base = { contextKey: 'research:one', conversationId: 'conversation-one', workflow: 'research' as const, data: { available: true, last_date: '2026-06-29' }, turnActive: false, refreshKey: 0, onPrompt: vi.fn(), onScreening: vi.fn() }
let savedItems: SavedIndicator[], trials: IndicatorTrial[]

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function requestBody(index: number) { return JSON.parse(String(mocked.mock.calls[index][1]?.body)) }
function defaultResponse(path: string, init?: RequestInit): unknown {
  if (path.startsWith('/dynamic-indicators/trials?')) return { items: trials }
  if (path.startsWith('/dynamic-indicators/trials/')) return { ...trial, trial_id: path.split('/').at(-1) }
  if (path === '/dynamic-indicators') return { items: savedItems }
  if (path.endsWith('/versions')) return { items: [saved, { ...saved, version: 1 }] }
  if (path.includes('indicator-one?version=')) return { ...saved, version: Number(path.split('=').at(-1)) }
  if (path === '/dynamic-indicators/preview') {
    const body = JSON.parse(String(init?.body)), parameters = body.parameter_overrides
    return { ...trial, trial_id: 'trial-two', parameters, definition: { ...definition, program: { ...definition.program, parameters } }, definition_hash: parameters.window === 20 ? trial.definition_hash : 'hash-edited', stock_code: body.stock_code, as_of: body.as_of, source_context: { requested_limit: body.limit } }
  }
  if (path === '/dynamic-indicators/save') return { ...saved, version: 3 }
  if (path.endsWith('/condition')) return { condition: { evaluator: 'program' }, provenance: {}, execution_authorized: false, saved: false }
  throw new Error(`Unexpected API ${path}`)
}
beforeEach(() => {
  savedItems = [saved]; trials = []
  mocked.mockReset(); base.onPrompt.mockReset(); base.onScreening.mockReset()
  mocked.mockImplementation(async (path, init) => defaultResponse(path, init))
})
async function open() { await userEvent.click(screen.getByRole('button', { name: '我的指标' })); return screen.findByRole('dialog', { name: '我的指标' }) }
async function selectSaved() { await userEvent.click(await screen.findByRole('button', { name: /成交加权偏离 v2/ })); await screen.findByText('固定版本 v2 · 数值时序指标') }

describe('contextual dynamic indicators', () => {
  it('hands arbitrary descriptions to the real Codex conversation without a client generator or automatic save', async () => {
    render(<MyIndicators {...base} />)
    await open()
    await userEvent.type(screen.getByLabelText('指标描述'), '自定义成交量加权的非线性偏离，使用过去17日')
    await userEvent.click(screen.getByRole('button', { name: '写入生成请求' }))
    expect(base.onPrompt).toHaveBeenCalledTimes(1)
    const prompt = base.onPrompt.mock.calls[0][0]
    expect(prompt).toContain('自定义成交量加权的非线性偏离')
    expect(prompt).toContain('preview_dynamic_indicator')
    expect(prompt).toContain('python-indicator-v1')
    expect(prompt).toContain('不要自动保存或执行选股')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mocked.mock.calls.every(([, init]) => !init?.method)).toBe(true)
  })

  it('displays the entire returned time series and gaps, then saves only after explicit confirmation', async () => {
    trials = [trial]
    render(<MyIndicators {...base} />)
    const dialog = await open()
    const chart = await within(dialog).findByRole('img', { name: 'K线主图和指标副图走势' })
    expect(chart.querySelectorAll('.candle-body')).toHaveLength(180)
    expect(screen.getByText(/完整试算序列：180/)).toHaveTextContent(`${dates[0]} 至 ${dates.at(-1)}`)
    expect(mocked.mock.calls.some(([path]) => path.endsWith('/save'))).toBe(false)
    await userEvent.click(screen.getByText('查看逐日数值'))
    expect(screen.getAllByRole('row')).toHaveLength(181)
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('—')
    await userEvent.click(screen.getByRole('button', { name: '确认保存此版本' }))
    expect(await screen.findByText(/已保存“成交加权偏离” v3/)).toBeInTheDocument()
    const index = mocked.mock.calls.findIndex(([path]) => path === '/dynamic-indicators/save')
    expect(requestBody(index)).toMatchObject({ trial_id: 'trial-one', confirmed: true, name: '成交加权偏离' })
    expect(requestBody(index).request_id).toEqual(expect.any(String))
  })

  it('prevents duplicate saves and retries the exact failed request with its original idempotency key', async () => {
    trials = [trial]
    const pending = deferred<SavedIndicator>()
    let saveCalls = 0
    mocked.mockImplementation(async (path, init) => {
      if (path.endsWith('/save')) { saveCalls++; if (saveCalls === 1) return pending.promise; return { ...saved, version: 3 } }
      return defaultResponse(path, init)
    })
    render(<MyIndicators {...base} />); await open(); await screen.findByRole('img')
    const button = screen.getByRole('button', { name: '确认保存此版本' })
    fireEvent.click(button); fireEvent.click(button)
    expect(saveCalls).toBe(1)
    await act(async () => pending.reject(new Error('连接中断')))
    expect(await screen.findByRole('alert')).toHaveTextContent('连接中断')
    await userEvent.click(screen.getByRole('button', { name: '确认保存此版本' }))
    await screen.findByText(/已保存“成交加权偏离”/)
    const writes = mocked.mock.calls.filter(([path]) => path.endsWith('/save')).map(([, init]) => JSON.parse(String(init?.body)))
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0])
  })

  it('does not cancel or strand an in-flight detail request when the selected item is clicked again', async () => {
    const pending = deferred<SavedIndicator>()
    mocked.mockImplementation(async (path, init) => path.includes('indicator-one?version=') ? pending.promise : defaultResponse(path, init))
    render(<MyIndicators {...base} />); await open()
    const entry = await screen.findByRole('button', { name: /成交加权偏离 v2/ })
    fireEvent.click(entry); fireEvent.click(entry)
    await act(async () => pending.resolve(saved))
    expect(await screen.findByText('固定版本 v2 · 数值时序指标')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '试算完整走势' })).toBeEnabled()
    expect(mocked.mock.calls.filter(([path]) => path.includes('indicator-one?version='))).toHaveLength(1)
  })

  it('cancels a preview and ignores its late response even if the transport ignores AbortSignal', async () => {
    const pending = deferred<IndicatorTrial>()
    mocked.mockImplementation(async (path, init) => path.endsWith('/preview') ? pending.promise : defaultResponse(path, init))
    render(<MyIndicators {...base} />); await open(); await selectSaved()
    await userEvent.click(screen.getByRole('button', { name: '试算完整走势' }))
    await userEvent.click(screen.getByRole('button', { name: '取消试算' }))
    const request = mocked.mock.calls.find(([path]) => path.endsWith('/preview'))!
    expect(request[1]?.signal?.aborted).toBe(true)
    await act(async () => pending.resolve(trial))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText('已停止等待试算结果；若计算已完成，记录可能仍会出现在列表中。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '试算完整走势' })).toBeEnabled()
  })

  it('blocks screening of edited parameters even before the first trial and enforces numeric parameter bounds', async () => {
    render(<MyIndicators {...base} />); await open(); await selectSaved()
    const input = screen.getByLabelText('指标参数 窗口')
    fireEvent.change(input, { target: { value: '21' } })
    expect(screen.getByRole('button', { name: '用于选股草稿' })).toBeDisabled()
    expect(screen.getByText('试算参数、历史长度或行情口径与已保存版本不同。请先保存新版本，再将它用于选股。')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '1' } })
    expect(screen.getByRole('alert')).toHaveTextContent('窗口 不能小于 2')
    expect(screen.getByRole('button', { name: '试算完整走势' })).toBeDisabled()
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByRole('alert')).toHaveTextContent('窗口 应为有效数值')
  })

  it('retrials edited parameters, freezes them into a new version, and never mutates the old version', async () => {
    mocked.mockImplementation(async (path, init) => path.endsWith('/save') ? { ...saved, version: 3, definition_hash: 'hash-edited', definition: { ...definition, program: { ...definition.program, parameters: { window: 21 } } } } : defaultResponse(path, init))
    render(<MyIndicators {...base} />); await open(); await selectSaved()
    fireEvent.change(screen.getByLabelText('指标参数 窗口'), { target: { value: '21' } })
    await userEvent.click(screen.getByRole('button', { name: '试算完整走势' }))
    await screen.findByRole('img')
    expect(screen.getByRole('button', { name: '用于选股草稿' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '确认保存此版本' }))
    await screen.findByText(/已保存“成交加权偏离” v3/)
    const previewIndex = mocked.mock.calls.findIndex(([path]) => path.endsWith('/preview'))
    expect(requestBody(previewIndex)).toMatchObject({ indicator_id: 'indicator-one', version: 2, parameter_overrides: { window: 21 }, limit: 500 })
    const saveIndex = mocked.mock.calls.findIndex(([path]) => path.endsWith('/save'))
    expect(requestBody(saveIndex)).toMatchObject({ indicator_id: 'indicator-one', base_version: 2, trial_id: 'trial-two' })
    expect(screen.getByRole('button', { name: '用于选股草稿' })).toBeEnabled()
    expect(saved.definition.program.parameters.window).toBe(20)
  })

  it('pins an explicit historical version and boolean threshold in an unsent screening handoff', async () => {
    render(<MyIndicators {...base} />); await open(); await selectSaved()
    await userEvent.selectOptions(screen.getByLabelText('指标历史版本'), '1')
    await screen.findByText('固定版本 v1 · 数值时序指标')
    await userEvent.selectOptions(screen.getByLabelText('指标比较方式'), 'cross_above')
    fireEvent.change(screen.getByLabelText('指标选股阈值'), { target: { value: '' } })
    expect(screen.getByRole('button', { name: '用于选股草稿' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('指标选股阈值'), { target: { value: '0' } })
    await userEvent.click(screen.getByRole('button', { name: '用于选股草稿' }))
    expect(base.onScreening).toHaveBeenCalledTimes(1)
    expect(base.onScreening.mock.calls[0][0]).toContain('version=1')
    expect(base.onScreening.mock.calls[0][0]).toContain('operator=cross_above')
    expect(base.onScreening.mock.calls[0][0]).toContain('threshold=0')
    expect(base.onScreening.mock.calls[0][0]).toContain('等待我确认后再执行选股')
    const index = mocked.mock.calls.findIndex(([path]) => path.endsWith('/condition'))
    expect(requestBody(index)).toEqual({ version: 1, output: 'deviation', operator: 'cross_above', threshold: 0 })
    expect(mocked.mock.calls.some(([path]) => /runs|execute|messages/.test(path))).toBe(false)
  })

  it('closes on navigation and prevents a late conversion from writing into a newer conversation', async () => {
    const pending = deferred<unknown>()
    mocked.mockImplementation(async (path, init) => path.endsWith('/condition') ? pending.promise : defaultResponse(path, init))
    const view = render(<MyIndicators {...base} />); await open(); await selectSaved()
    await userEvent.click(screen.getByRole('button', { name: '用于选股草稿' }))
    view.rerender(<MyIndicators {...base} contextKey="research:two" conversationId="conversation-two" />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => pending.resolve({ condition: {} }))
    expect(base.onScreening).not.toHaveBeenCalled()
  })

  it('restores focus on Escape and ignores a late save after the drawer closes', async () => {
    trials = [trial]
    const pending = deferred<SavedIndicator>()
    mocked.mockImplementation(async (path, init) => path.endsWith('/save') ? pending.promise : defaultResponse(path, init))
    render(<MyIndicators {...base} />); await open(); await screen.findByRole('img')
    await userEvent.click(screen.getByRole('button', { name: '确认保存此版本' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: '我的指标' })).toHaveFocus()
    await act(async () => pending.resolve(saved))
    expect(screen.queryByText(/已保存“/)).not.toBeInTheDocument()
  })

  it('keeps failed validation visible and does not permit saving an unusable trial', async () => {
    trials = [{ ...trial, validation: { passed: true, saveable: false, warnings: ['需要更多历史数据'] } }]
    mocked.mockImplementation(async (path, init) => path.includes('/trials/trial-one') ? trials[0] : defaultResponse(path, init))
    render(<MyIndicators {...base} />); await open(); await screen.findByRole('img')
    expect(screen.getByRole('button', { name: '确认保存此版本' })).toBeDisabled()
    expect(screen.getByText('需要更多历史数据')).toBeInTheDocument()
  })

  it('can reopen the description editor while inspecting a saved indicator', async () => {
    render(<MyIndicators {...base} />); await open(); await selectSaved()
    await userEvent.click(screen.getByRole('button', { name: '描述新指标' }))
    await waitFor(() => expect(screen.getByLabelText('指标描述')).toHaveFocus())
    await userEvent.type(screen.getByLabelText('指标描述'), '增加一个动量输出')
    await userEvent.click(screen.getByRole('button', { name: '基于当前指标修改' }))
    expect(base.onPrompt.mock.calls[0][0]).toContain('read_dynamic_indicator')
    expect(base.onPrompt.mock.calls[0][0]).toContain('version=2')
  })
})

it('preserves all backend charts and renders a legacy overlay histogram in a visible pane', () => {
  const histogram = { id: 'hist', label: '柱状输出', color: '#00337a', values: dates.map(() => 1) }
  const charts = splitIndicatorCharts({ ...trial, charts: [{ ...trial.chart, placement: 'overlay', histogram }, trial.chart] })
  expect(charts).toHaveLength(3)
  expect(charts[0]).toMatchObject({ placement: 'overlay', histogram: null })
  expect(charts[1]).toMatchObject({ placement: 'pane', histogram })
  expect(charts[2]).toBe(trial.chart)
})

it('preserves custom history length in a real retrial and disables a stale trial after the length changes', async () => {
  trials = [{ ...trial, source_context: { requested_limit: 180 } }]
  mocked.mockImplementation(async (path, init) => path.includes('/trials/trial-one') ? trials[0] : defaultResponse(path, init))
  render(<MyIndicators {...base} />); await open(); await screen.findByRole('img')
  expect(screen.getByLabelText('指标历史长度')).toHaveValue(180)
  fireEvent.change(screen.getByLabelText('指标历史长度'), { target: { value: '90' } })
  expect(screen.getByRole('button', { name: '确认保存此版本' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: '按当前参数重新试算' }))
  const index = mocked.mock.calls.findIndex(([path]) => path.endsWith('/preview'))
  expect(requestBody(index).limit).toBe(90)
})

it('uses an explicit screening security and cutoff without inheriting a research scope', async () => {
  render(<MyIndicators {...base} workflow="screening" defaultStock="600000.SH" defaultAsOf="2025-12-31" />)
  await open()
  expect(screen.getByLabelText('指标试算证券')).toHaveValue('600000.SH')
  expect(screen.getByLabelText('指标试算日期')).toHaveValue('2025-12-31')
})

it('reads the original saved trial without rerunning it and labels the historic evidence', async () => {
  render(<MyIndicators {...base} />); await open(); await selectSaved()
  await userEvent.click(screen.getByRole('button', { name: '查看保存时的原始试算' }))
  expect(await screen.findByRole('img')).toBeInTheDocument()
  expect(screen.getByText('正在查看保存此版本时的原始试算，未重新运行。')).toBeInTheDocument()
  expect(mocked.mock.calls.some(([path]) => path.endsWith('/preview'))).toBe(false)
})

it('recognizes a saved trial on reopen instead of silently creating a duplicate indicator', async () => {
  trials = [trial]
  savedItems = [{ ...saved, trial_id: trial.trial_id }]
  render(<MyIndicators {...base} />); await open(); await screen.findByRole('img')
  await waitFor(() => expect(screen.getByRole('button', { name: '确认保存此版本' })).toBeDisabled())
  expect(screen.getByText('固定版本 v2 · 数值时序指标')).toBeInTheDocument()
})

it('keeps constant positive histogram bars inside the shared chart viewport', () => {
  const histogram = { id: 'constant', label: '常数柱', color: '#00337a', values: dates.map(() => 2) }
  const chart = { ...trial.chart, histogram, lines: [] }
  expect(splitIndicatorCharts({ ...trial, charts: [chart] })[0].reference_lines).toContain(0)
})


it('requires a new saved version for a changed history horizon even when formula and parameters are identical', async () => {
  const historic = { ...saved, source_context: { requested_limit: 180 } }
  savedItems = [historic]
  mocked.mockImplementation(async (path, init) => {
    if (path.includes('indicator-one?version=')) return historic
    if (path.endsWith('/save')) return { ...historic, version: 3, trial_id: 'trial-two', source_context: { requested_limit: 90 } }
    return defaultResponse(path, init)
  })
  render(<MyIndicators {...base} />); await open(); await selectSaved()
  expect(screen.getByLabelText('指标历史长度')).toHaveValue(180)
  fireEvent.change(screen.getByLabelText('指标历史长度'), { target: { value: '90' } })
  expect(screen.getByRole('button', { name: '用于选股草稿' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: '试算完整走势' }))
  await screen.findByRole('img')
  expect(screen.getByRole('button', { name: '用于选股草稿' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '确认保存此版本' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: '确认保存此版本' }))
  await screen.findByText(/已保存“成交加权偏离” v3/)
  expect(screen.getByRole('button', { name: '用于选股草稿' })).toBeEnabled()
})


it('requires a new version when the actual input bar count changes under the same requested history limit', async () => {
  const historic = { ...saved, source_context: { requested_limit: 500, input_bars: 160 } }
  savedItems = [historic]
  mocked.mockImplementation(async (path, init) => path.includes('indicator-one?version=') ? historic : defaultResponse(path, init))
  render(<MyIndicators {...base} />); await open(); await selectSaved()
  expect(screen.getByText(/固定输入 160 个交易日/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '试算完整走势' }))
  await screen.findByRole('img')
  expect(screen.getByLabelText('指标历史长度')).toHaveValue(500)
  expect(screen.getByRole('button', { name: '用于选股草稿' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '确认保存此版本' })).toBeEnabled()
})
