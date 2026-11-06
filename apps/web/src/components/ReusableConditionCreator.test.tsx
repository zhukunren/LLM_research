import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type Pattern } from '../api'
import { SecuritiesProvider } from './StockSearch'
import ReusableConditionCreator from './ReusableConditionCreator'

vi.mock('../api', async original => ({ ...await original<typeof import('../api')>(), api: vi.fn() }))
vi.mock('./MarketIndicatorChart', () => ({ ResponsiveMarketIndicatorChart: () => <div>样本图表</div> }))
const template = { id: 'above_sma', version: 1, name: '收盘价高于均线', parameters: { window: { label: '均线周期 N', default: 20, min: 2, max: 250, step: 1 } } }
const pattern = { id: 'shape', version: 2, name: '双底目标', algorithm_version: 'path-window-v2', input_type: 'drawing', representation: 'price_path', candlesticks: [], points: [1, .5, 1], target_bars: 30, params: { min_similarity: 80, match_mode: 'current' }, created_at: '2026-10-01T00:00:00Z' } as Pattern
const state = { previews: [] as Record<string, unknown>[], saves: [] as Record<string, unknown>[], failPreview: false }
beforeEach(() => {
  state.previews = []; state.saves = []; state.failPreview = false
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/security-catalog') return { items: [{ stock_code: '600000.SH', name: '浦发银行', market: 'SH' }] } as never
    if (path.startsWith('/screening-templates?')) return { items: [template] } as never
    const body = options?.body ? JSON.parse(String(options.body)) : {}
    if (path === '/condition-builder/preview') {
      state.previews.push(body)
      if (state.failPreview) throw new Error('原文服务暂不可用')
      return { builder_draft_id: `trial-${state.previews.length}`, definition: body.definition, sample: { stock_code: body.stock_code, as_of: body.as_of }, description: '本次样本规则', verified_at: '2026-10-20T08:00:00Z', result: { state: body.definition.kind === 'news' ? 'unknown' : 'true', reason: body.definition.kind === 'news' ? '没有足够原文' : '样本符合', evidence: body.definition.kind === 'report' ? [{ source_id: 'report', page_number: 2, quote: '订单已实际落地' }] : [] } } as never
    }
    if (path === '/condition-builder/save') {
      state.saves.push(body)
      return { asset_kind: body.definition.kind === 'pattern' ? 'pattern' : 'filter', asset: { id: 'saved', name: body.name, version: 1 }, reference: body.definition.kind === 'pattern' ? { op: 'pattern_ref', pattern_id: 'saved', version: 1, min_similarity: body.definition.minimum_similarity } : { op: 'filter_ref', filter_id: 'saved', version: 1 } } as never
    }
    return { items: [] } as never
  })
})

function mount() {
  const onSaved = vi.fn(), onUse = vi.fn(), onOpenPatterns = vi.fn()
  const view = render(<SecuritiesProvider><ReusableConditionCreator data={{ available: true, last_date: '2026-10-20' }} patterns={[pattern]} customEditor={<textarea aria-label="原有自定义描述" />} onSaved={onSaved} onUse={onUse} onOpenPatterns={onOpenPatterns} /></SecuritiesProvider>)
  return { ...view, onSaved, onUse, onOpenPatterns }
}
async function chooseSample(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('combobox', { name: '可复用条件样本公司' }), '600000')
  await user.click(await screen.findByRole('option', { name: /浦发银行/ }))
  fireEvent.change(screen.getByLabelText('可复用条件样本日期'), { target: { value: '2026-10-20' } })
}

it('requires a matching sample validation, allows naming after validation and saves only once', async () => {
  const { onSaved, onUse } = mount(), user = userEvent.setup()
  await screen.findByLabelText('均线周期 N')
  expect(screen.getByRole('button', { name: '保存为可复用条件' })).toBeDisabled()
  await chooseSample(user)
  await user.click(screen.getByRole('button', { name: '验证样本' }))
  await screen.findByText('样本符合')
  fireEvent.change(screen.getByLabelText('均线周期 N'), { target: { value: '30' } })
  expect(screen.getByRole('button', { name: '保存为可复用条件' })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('尚未完成验证')
  await user.click(screen.getByRole('button', { name: '验证样本' }))
  await waitFor(() => expect(state.previews).toHaveLength(2))
  await user.clear(screen.getByLabelText('可复用条件名称'))
  await user.type(screen.getByLabelText('可复用条件名称'), '30日均线条件')
  await user.dblClick(screen.getByRole('button', { name: '保存为可复用条件' }))
  expect(await screen.findByText('已保存 30日均线条件 · v1')).toBeVisible()
  expect(state.saves).toHaveLength(1)
  expect(state.saves[0]).toMatchObject({ builder_draft_id: 'trial-2', definition: { kind: 'technical', parameters: { window: 30 } } })
  expect(onSaved).toHaveBeenCalledOnce()
  expect(onUse).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '将此版本加入组合' }))
  expect(onUse).toHaveBeenCalledWith({ op: 'filter_ref', filter_id: 'saved', version: 1 })
})

it('retains independent evidence and technical drafts while switching condition types', async () => {
  mount(); const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '资讯条件' }))
  await user.type(screen.getByLabelText('可复用证据判断要求'), '已完成实际回购，排除仅有计划')
  fireEvent.change(screen.getByLabelText('条件资料窗口'), { target: { value: '90' } })
  await user.selectOptions(screen.getByLabelText('条件事件状态'), 'completed')
  await user.click(screen.getByRole('button', { name: '技术条件' }))
  fireEvent.change(await screen.findByLabelText('均线周期 N'), { target: { value: '35' } })
  await user.click(screen.getByRole('button', { name: '资讯条件' }))
  expect(screen.getByLabelText('可复用证据判断要求')).toHaveValue('已完成实际回购，排除仅有计划')
  expect(screen.getByLabelText('条件资料窗口')).toHaveValue(90)
  await chooseSample(user)
  await user.click(screen.getByRole('button', { name: '验证样本' }))
  await screen.findByText('没有足够原文')
  expect(state.previews[0]).toMatchObject({ definition: { kind: 'news', event_requirement: 'completed', fact_requirement: 'actual', lookback_calendar_days: 90, quantifier: 'exists' } })
  expect(screen.getByRole('region', { name: '条件样本验证' })).toHaveTextContent('数据不足')
  await user.click(screen.getByRole('button', { name: '技术条件' }))
  expect(await screen.findByLabelText('均线周期 N')).toHaveValue(35)
})

it('uses a fixed shape version and matching settings to create a separate reusable condition', async () => {
  mount(); const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '形态条件' }))
  await user.selectOptions(screen.getByLabelText('条件形态模板'), 'shape@2')
  fireEvent.change(screen.getByLabelText('条件最低相似度'), { target: { value: '88' } })
  await user.selectOptions(screen.getByLabelText('条件形态匹配窗口'), 'recent')
  fireEvent.change(screen.getByLabelText('条件形态回看日数'), { target: { value: '15' } })
  await chooseSample(user)
  await user.click(screen.getByRole('button', { name: '验证样本' }))
  await screen.findByText('样本符合')
  expect(state.previews[0]).toMatchObject({ definition: { kind: 'pattern', pattern_id: 'shape', pattern_version: 2, minimum_similarity: 88, match_mode: 'recent', recent_bars: 15 } })
  expect(pattern.params.min_similarity).toBe(80)
})

it('shows actual report excerpts and invalidates old validation if a repeat request fails', async () => {
  mount(); const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '研报条件' }))
  await user.type(screen.getByLabelText('可复用证据判断要求'), '核对实际订单')
  await chooseSample(user)
  await user.click(screen.getByRole('button', { name: '验证样本' }))
  expect(await screen.findByRole('link', { name: '打开研报原文' })).toHaveAttribute('href', '/api/v1/documents/report/pdf#page=2')
  expect(screen.getByText('订单已实际落地')).toBeVisible()
  state.failPreview = true
  await user.click(screen.getByRole('button', { name: '验证样本' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('原文服务暂不可用')
  expect(screen.getByRole('button', { name: '保存为可复用条件' })).toBeDisabled()
})

it('keeps a late preview from restoring validation after closing and reopening the creator', async () => {
  const original = vi.mocked(api).getMockImplementation()!
  let resolve!: (value: never) => void
  vi.mocked(api).mockImplementation(async (path, options) => path === '/condition-builder/preview' ? new Promise<never>(done => { resolve = done }) : original(path, options))
  const view = mount(), user = userEvent.setup()
  await screen.findByLabelText('均线周期 N')
  await chooseSample(user)
  await user.click(screen.getByRole('button', { name: '验证样本' }))
  expect(screen.getByRole('button', { name: '正在核对样本…' })).toBeDisabled()
  view.unmount()
  mount()
  expect(screen.getByRole('button', { name: '技术条件' })).toBeEnabled()
  await act(async () => resolve({ builder_draft_id: 'stale', definition: {}, description: '过期结果', sample: { stock_code: '600000.SH', as_of: '2026-10-20' }, result: { state: 'true' } } as never))
  expect(screen.queryByText('过期结果')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '保存为可复用条件' })).toBeDisabled()
})
