import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../api'
import ScreeningMethodSetup from './ScreeningMethodSetup'
import type { ScreeningFormMethod } from '../../screeningMethods'

vi.mock('../../api', async original => ({ ...await original<typeof import('../../api')>(), api: vi.fn() }))
vi.mock('../conversation/ScreeningReadiness', () => ({ default: () => <span>资料状态</span> }))
vi.mock('../StockSearch', () => ({ default: ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => <input aria-label={label} value={value} onChange={event => onChange(event.target.value)} /> }))
vi.mock('../MarketIndicatorChart', () => ({ ResponsiveMarketIndicatorChart: () => <div aria-label="真实试算图" /> }))

const template = { id: 'above_sma', version: 1, name: '收盘价在均线上方', formula: '收盘价 > SMA(N)', parameters: { window: { label: '均线周期 N', default: 20, min: 2, max: 250, step: 1 } } }
beforeEach(() => { vi.mocked(api).mockImplementation(async path => path.startsWith('/screening-templates?') ? { items: [template] } as never : { items: [] } as never) })

function mount(method: ScreeningFormMethod, options: { unavailable?: boolean } = {}) {
  const submit = vi.fn(), apply = vi.fn()
  function Host() {
    const [requirement, setRequirement] = useState(''), [asOf, setAsOf] = useState('2026-10-20'), [pool, setPool] = useState('all')
    return <ScreeningMethodSetup method={method} requirement={requirement} onRequirement={setRequirement} asOf={asOf} onDate={setAsOf} pool={pool} onPool={setPool} watchlists={[{ id: 'watch-1', name: '重点公司' }]} data={{ available: true, last_date: '2026-10-20' }} disabled={false} modelUnavailable={options.unavailable} settings={<span>模型设置</span>} onSubmit={submit} onTemplate={apply} />
  }
  render(<Host />)
  return { submit, apply }
}

it('runs an edited fixed rule only on an explicit click and remains usable without a model', async () => {
  const { submit, apply } = mount('technical', { unavailable: true }), user = userEvent.setup()
  const period = await screen.findByRole('spinbutton', { name: '均线周期 N' })
  fireEvent.change(period, { target: { value: '30' } })
  expect(apply).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '开始筛选' }))
  expect(apply).toHaveBeenCalledWith(template, { window: 30 })
  expect(submit).not.toHaveBeenCalled()
})

it('keeps selected technical parameters when a supplementary evidence condition needs model interpretation', async () => {
  const { submit, apply } = mount('technical'), user = userEvent.setup()
  fireEvent.change(await screen.findByRole('spinbutton', { name: '均线周期 N' }), { target: { value: '30' } })
  await user.type(screen.getByLabelText('专用选股要求'), '近30日有实际回购的资讯')
  await user.click(screen.getByRole('button', { name: '生成并筛选' }))
  expect(apply).not.toHaveBeenCalled()
  expect(submit).toHaveBeenCalledWith(expect.stringContaining('30 日简单均线'), false)
  expect(submit.mock.calls[0][0]).toContain('实际回购')
})

it.each(['news', 'report'] as const)('carries %s evidence windows and the date into a review-only request', async method => {
  const { submit } = mount(method), user = userEvent.setup()
  fireEvent.change(screen.getByLabelText(method === 'news' ? '资讯发布窗口天数' : '研报发布窗口天数'), { target: { value: '90' } })
  fireEvent.change(screen.getByLabelText('选股截止日期'), { target: { value: '2026-10-15' } })
  if (method === 'report') await user.selectOptions(screen.getByLabelText('研报证据口径'), 'forecast')
  await user.type(screen.getByLabelText('专用选股要求'), '新增订单增长')
  await user.click(screen.getByRole('button', { name: '只生成方案' }))
  expect(submit).toHaveBeenCalledWith(expect.stringContaining('2026-10-15的近 90 个自然日'), true)
  expect(submit.mock.calls[0][0]).toContain('数据不足')
  if (method === 'report') expect(submit.mock.calls[0][0]).toContain('分析师预测与未来判断')
})

it('blocks invalid rule values and future cutoffs before starting a run', async () => {
  const { apply } = mount('technical')
  fireEvent.change(await screen.findByLabelText('均线周期 N'), { target: { value: '' } })
  expect(screen.getByRole('button', { name: '开始筛选' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('均线周期 N'), { target: { value: '20' } })
  fireEvent.change(screen.getByLabelText('选股截止日期'), { target: { value: '2026-10-21' } })
  expect(screen.getByRole('button', { name: '开始筛选' })).toBeDisabled()
  expect(apply).not.toHaveBeenCalled()
})

it('hides a trial result when its parameters change and sends the new snapshot when retried', async () => {
  vi.mocked(api).mockImplementation(async path => path.includes('/preview') ? { stock_code: '600000.SH', requested_as_of: '2026-10-20', actual_date: '2026-10-20', state: 'true', details: [], chart: { bars: [] } } as never : { items: [template] } as never)
  mount('technical'); const user = userEvent.setup()
  await screen.findByLabelText('均线周期 N')
  await user.click(screen.getByRole('button', { name: '试算规则' }))
  await screen.findByText('符合', { exact: true })
  fireEvent.change(screen.getByLabelText('均线周期 N'), { target: { value: '35' } })
  expect(screen.queryByText('符合', { exact: true })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '试算规则' }))
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([path]) => path.includes('/preview'))).toHaveLength(2))
  const call = vi.mocked(api).mock.calls.filter(([path]) => path.includes('/preview')).at(-1)!
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ parameters: { window: 35 }, as_of: '2026-10-20' })
})
