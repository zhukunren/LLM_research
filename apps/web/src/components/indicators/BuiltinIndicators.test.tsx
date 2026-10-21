import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../api'
import BuiltinIndicators from './BuiltinIndicators'

vi.mock('../../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const items = [
  { id: 'sma', name: '简单移动平均线', min_window: 2, max_window: 250 },
  { id: 'rsi', name: '相对强弱指标', min_window: 2, max_window: 100 },
  { id: 'bollinger', name: '布林带', min_window: 2, max_window: 250 },
  { id: 'macd_hist', name: 'MACD 柱值' }, { id: 'kdj_k', name: 'KDJ K' },
]
const bars = [
  { trade_date: '2026-09-13', open: 10, high: 12, low: 9, close: 11 },
  { trade_date: '2026-09-14', open: 11, high: 13, low: 10, close: 12 },
]
const props = { data: { available: true, last_date: '2026-09-14' }, stock: '000001.SH', asOf: '2026-09-14', onStockChange: vi.fn(), onDateChange: vi.fn(), onGenerate: vi.fn() }
function preview(indicator = 'sma') {
  const lines = indicator === 'bollinger'
    ? ['上轨', '中轨', '下轨'].map((label, i) => ({ id: 'bollinger-' + i, label, color: '#00337a', values: [11 + i, 12 + i] }))
    : [{ id: indicator, label: indicator.toUpperCase(), color: '#00337a', values: [11, 12] }]
  return { stock_code: props.stock, as_of: props.asOf, current: 12, previous: 11, warning: '复权口径尚未确认', chart: { placement: indicator === 'sma' || indicator === 'bollinger' ? 'overlay' : 'pane', bars, lines, histogram: null, reference_lines: [] } }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocked.mockImplementation(async (path, init) => path === '/indicators' ? { items } : preview(JSON.parse(String(init?.body)).indicator))
})

it('previews fixed formulas with the shared security/date and switches between price and indicator panes', async () => {
  render(<BuiltinIndicators {...props} />)
  await screen.findByRole('img', { name: 'K线主图叠加指标走势' })
  const request = mocked.mock.calls.find(([path]) => path === '/indicators/preview')!
  expect(JSON.parse(String(request[1]?.body))).toEqual({ stock_code: '000001.SH', as_of: props.asOf, indicator: 'sma', window: 20, field: 'close' })
  await userEvent.selectOptions(screen.getByLabelText('常用指标'), 'rsi')
  await screen.findByRole('img', { name: 'K线主图和指标副图走势' })
  expect(screen.getByLabelText('常用指标周期')).toHaveValue(14)
  await userEvent.selectOptions(screen.getByLabelText('常用指标'), 'bollinger')
  await screen.findByRole('img', { name: 'K线主图叠加指标走势' })
  for (const name of ['上轨', '中轨', '下轨']) expect(screen.getByText(name)).toBeInTheDocument()
})

it('hands the selected formula and actual preview evidence to the existing generated-version workflow', async () => {
  render(<BuiltinIndicators {...props} />)
  await screen.findByRole('img')
  fireEvent.change(screen.getByLabelText('常用指标周期'), { target: { value: '17' } })
  const button = screen.getByRole('button', { name: '带入对话生成可保存版本' })
  expect(button).toBeDisabled()
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  expect(props.onGenerate).toHaveBeenCalledOnce()
  expect(props.onGenerate.mock.calls[0][0]).toContain('N=17')
  expect(props.onGenerate.mock.calls[0][0]).toContain('实际行情日 2026-09-14')
  expect(props.onGenerate.mock.calls[0][0]).toContain('算术平均')
  expect(mocked.mock.calls.every(([path]) => ['/indicators', '/indicators/preview'].includes(path))).toBe(true)
})

it('rejects invalid KDJ windows and keeps the fixed MACD periods explicit', async () => {
  render(<BuiltinIndicators {...props} />)
  await screen.findByRole('img')
  await userEvent.selectOptions(screen.getByLabelText('常用指标'), 'kdj_k')
  await screen.findByRole('img', { name: 'K线主图和指标副图走势' })
  const calls = mocked.mock.calls.length
  fireEvent.change(screen.getByLabelText('常用指标周期'), { target: { value: '101' } })
  expect(screen.getByRole('alert')).toHaveTextContent('2–100')
  expect(screen.getByRole('button', { name: '带入对话生成可保存版本' })).toBeDisabled()
  expect(mocked.mock.calls).toHaveLength(calls)
  await userEvent.selectOptions(screen.getByLabelText('常用指标'), 'macd_hist')
  expect(screen.getByLabelText('常用指标周期')).toBeDisabled()
  await waitFor(() => expect(screen.getByRole('button', { name: '带入对话生成可保存版本' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: '带入对话生成可保存版本' }))
  expect(props.onGenerate.mock.calls[0][0]).toContain('固定快线12日、慢线26日、信号线9日')
  expect(props.onGenerate.mock.calls[0][0]).toContain('2*(DIF-DEA)')
})

it('ignores an obsolete response after the cutoff changes and disables handoff until the new preview arrives', async () => {
  let resolve!: (value: unknown) => void
  const old = new Promise(done => { resolve = done })
  mocked.mockImplementation(async (path, init) => {
    if (path === '/indicators') return { items }
    return JSON.parse(String(init?.body)).as_of === props.asOf ? old : { ...preview(), as_of: '2026-09-13', current: 99 }
  })
  const view = render(<BuiltinIndicators {...props} />)
  await waitFor(() => expect(mocked.mock.calls.some(([path]) => path === '/indicators/preview')).toBe(true))
  const request = mocked.mock.calls.find(([path]) => path === '/indicators/preview')!
  view.rerender(<BuiltinIndicators {...props} asOf="2026-09-13" />)
  expect(request[1]?.signal?.aborted).toBe(true)
  expect(screen.getByRole('button', { name: '带入对话生成可保存版本' })).toBeDisabled()
  await screen.findByRole('img')
  await act(async () => resolve(preview()))
  await userEvent.click(screen.getByRole('button', { name: '带入对话生成可保存版本' }))
  expect(props.onGenerate.mock.calls[0][0]).toContain('当日输出 99')
  expect(props.onGenerate.mock.calls[0][0]).toContain('实际行情日 2026-09-13')
})

it('recovers catalog failures and exposes preview errors without enabling save handoff', async () => {
  mocked.mockRejectedValueOnce(new Error('目录暂不可用'))
  render(<BuiltinIndicators {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('目录暂不可用')
  await userEvent.click(screen.getByRole('button', { name: '重试常用指标' }))
  await screen.findByRole('img')
  mocked.mockImplementation(async path => path === '/indicators' ? { items } : Promise.reject(new Error('没有可用行情')))
  await userEvent.selectOptions(screen.getByLabelText('常用指标'), 'rsi')
  expect(await screen.findByRole('alert')).toHaveTextContent('没有可用行情')
  expect(screen.getByRole('button', { name: '带入对话生成可保存版本' })).toBeDisabled()
})
