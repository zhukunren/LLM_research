import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import StockSearch, { SecuritiesProvider } from './StockSearch'
import ScreeningResultView from './ScreeningResultView'
import ReportEvaluations from '../pages/ReportEvaluations'

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })

it('resolves names and pinyin and distinguishes a stock from an index with the same six digits', async () => {
  const selected = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [
    { stock_code: '600000.SH', name: '浦发银行', pinyin: 'pufayinhang', initials: 'pfyh', market: 'SH' },
    { stock_code: '000001.SZ', name: '平安银行', pinyin: 'pinganyinhang', initials: 'payh', market: 'SZ' },
    { stock_code: '000001.SH', name: '上证指数', pinyin: 'shangzhengzhishu', initials: 'szzs', market: '指数' },
  ] })))
  function Harness() {
    const [code, setCode] = useState('')
    return <StockSearch value={code} includeIndices onChange={value => { setCode(value); selected(value) }} />
  }
  const user = userEvent.setup()
  render(<SecuritiesProvider><Harness /></SecuritiesProvider>)
  await user.click(screen.getByRole('combobox'))
  await user.type(screen.getByRole('combobox'), 'pfyh')
  await user.click(await screen.findByRole('option', { name: /浦发银行/ }))
  expect(selected).toHaveBeenLastCalledWith('600000.SH')
  expect(screen.getByRole('combobox')).toHaveValue('浦发银行')
  await user.click(screen.getByRole('combobox'))
  await user.type(screen.getByRole('combobox'), '000001')
  expect(await screen.findByRole('option', { name: /上证指数/ })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /平安银行/ })).toBeInTheDocument()
  await user.click(screen.getByRole('option', { name: /平安银行/ }))
  expect(selected).toHaveBeenLastCalledWith('000001.SZ')
})

it('copies the explicitly labelled current page without silently filtering or claiming success when clipboard fails', async () => {
  const user = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const all = vi.fn()
  render(<ScreeningResultView status="succeeded" total={45} onCopyAll={all} decisions={[
    { stock_code: '600000.SH', state: 'true', conditions: [] },
    { stock_code: '000001.SZ', state: 'false', conditions: [] },
  ]} />)
  await user.click(screen.getByRole('button', { name: '复制与导出' }))
  await user.click(screen.getByRole('menuitem', { name: '复制本页代码' }))
  expect(copy).toHaveBeenCalledWith('600000.SH\n000001.SZ')
  expect(screen.getByText(/包含本页显示的全部判断状态/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '复制与导出' }))
  await user.click(screen.getByRole('menuitem', { name: '复制全部符合项' }))
  expect(all).toHaveBeenCalledTimes(1)
  copy.mockRejectedValueOnce(new Error('denied'))
  await user.click(screen.getByRole('button', { name: '复制与导出' }))
  await user.click(screen.getByRole('menuitem', { name: '已复制' }))
  expect(await screen.findByText(/复制未成功/)).toBeInTheDocument()
})

it('keeps old report results labelled as history until the newly selected date is evaluated', async () => {
  const requests: string[] = []
  const evaluation = { id: 'assessment', status: 'succeeded', as_of: '2026-09-14', model: 'test', coverage: {}, result: { assessments: [] } }
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const path = String(input)
    if (init?.method === 'POST') { requests.push(String(init.body)); return json({ ...evaluation, as_of: JSON.parse(String(init.body)).as_of }) }
    if (path.includes('/filters')) return json({ items: [{ id: 'filter', version: 1, library: 'report', name: '订单增长', expression: { evaluation_mode: 'rubric' } }] })
    if (path.includes('/report-evaluations?')) return json({ items: [{ id: 'assessment' }] })
    return json(evaluation)
  }))
  render(<ReportEvaluations />)
  await screen.findByText(/历史结果，尚未按当前日期/)
  fireEvent.change(screen.getByLabelText('报告截止日'), { target: { value: '2026-09-28' } })
  expect(requests).toEqual([])
  expect(screen.getByText(/历史结果，尚未按当前日期/)).toHaveTextContent('2026-09-14')
  fireEvent.click(screen.getByRole('button', { name: '按当前日期重新评估' }))
  await waitFor(() => expect(screen.queryByText(/历史结果，尚未按当前日期/)).not.toBeInTheDocument())
  expect(JSON.parse(requests[0]).as_of).toBe('2026-09-28')
})
