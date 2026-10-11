import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ScreeningResultView, { type CoverageCounts } from './ScreeningResultView'

const mixed: CoverageCounts = { target_total: 10, true_count: 2, false_count: 3, unknown_count: 5, failed_count: 2, not_evaluated_count: 1 }

it('opens full evidence from the compact list, including a false condition on a matching stock', async () => {
  const user = userEvent.setup()
  render(<ScreeningResultView status="succeeded" asOf="2026-09-28" decisions={[{ stock_code: '600000.SH', state: 'true', conditions: [
    { name: '营收增长', state: 'true', explanation: '收入同比增长25%', actual: 25, citation: '半年报第12页' },
    { name: '亏损', state: 'false', explanation: '净利润为正' },
  ] }]} />)
  expect(screen.getByRole('table', { name: '筛选结果股票列表' })).toBeInTheDocument()
  expect(screen.getByText('不符合 · 净利润为正')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '查看 600000.SH 条件与依据' }))
  const dialog = screen.getByRole('dialog', { name: '个股条件与依据' })
  expect(within(dialog).getByText('半年报第12页')).toBeVisible()
  expect(within(dialog).getByText('亏损 · 不符合')).toBeVisible()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看 600000.SH 条件与依据' })).toHaveFocus()
})

it('adds only selected stocks and retains failed selections with a stable retry request', async () => {
  const user = userEvent.setup(), writes: { stock_code: string; request_id: string }[] = []
  let failed = false
  vi.stubGlobal('fetch', vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes.push(body)
      if (body.stock_code === '000001.SZ' && !failed) { failed = true; return new Response(JSON.stringify({ detail: '暂时失败' }), { status: 503 }) }
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 })
  }))
  render(<ScreeningResultView status="succeeded" decisions={['600000.SH', '000001.SZ', '000002.SZ'].map(stock_code => ({ stock_code, state: 'true', conditions: [] }))} />)
  await user.click(screen.getByRole('checkbox', { name: '勾选筛选结果 600000.SH' }))
  await user.click(screen.getByRole('checkbox', { name: '勾选筛选结果 000001.SZ' }))
  await user.click(screen.getByRole('button', { name: /^加入观察池$/ }))
  await screen.findByText(/1 只未完成/)
  expect(screen.getByRole('checkbox', { name: '勾选筛选结果 600000.SH' })).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: '勾选筛选结果 000001.SZ' })).toBeChecked()
  await user.click(screen.getByRole('button', { name: /^加入观察池$/ }))
  await waitFor(() => expect(writes).toHaveLength(3))
  expect(writes.map(item => item.stock_code)).toEqual(['600000.SH', '000001.SZ', '000001.SZ'])
  expect(writes[1].request_id).toBe(writes[2].request_id)
})

it('defaults to matches while retaining date and accurate mixed-status coverage', () => {
  render(<ScreeningResultView title="我的筛选" asOf="2026-09-30" status="partial" coverage={mixed} decisions={[]} onStateFilterChange={vi.fn()} />)
  expect(screen.getByLabelText('判断状态')).toHaveValue('true')
  expect(screen.getByText('数据截止日：2026-09-30')).toBeVisible()
  expect(screen.getByText(/已有明确判断 5 \/ 10 只/)).toBeVisible()
  expect(screen.getByText(/包含 2 只处理失败、1 只未处理/)).toBeVisible()
  expect(screen.getByText(/未能判断的股票不等于不符合/)).toBeVisible()
  expect(screen.queryByText('本次没有找到符合条件的股票')).not.toBeInTheDocument()
})

it('does not call all-unprocessed coverage zero matches and offers inspection', () => {
  const state = vi.fn(), query = vi.fn(), page = vi.fn()
  render(<ScreeningResultView status="partial" coverage={{ ...mixed, true_count: 0, false_count: 0, unknown_count: 10, not_evaluated_count: 10, failed_count: 0 }} decisions={[]}
    onStateFilterChange={state} onQueryChange={query} onPageChange={page} />)
  expect(screen.getByText('暂未确认符合项，仍有未完成的判断')).toBeVisible()
  expect(screen.getByText(/已有明确判断 0 \/ 10 只/)).toBeVisible()
  expect(screen.queryByText('本次没有找到符合条件的股票')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '查看全部判断与原因' }))
  expect(state).toHaveBeenCalledWith('')
  expect(query).toHaveBeenCalledWith('')
  expect(page).toHaveBeenCalledWith(0)
})

it('calls only fully judged successful coverage zero matches and leaves rule changes to the user', () => {
  const adjust = vi.fn()
  render(<ScreeningResultView status="succeeded" coverage={{ target_total: 10, true_count: 0, false_count: 10, unknown_count: 0 }} decisions={[]} onAdjustRequirements={adjust} />)
  expect(screen.getByText('本次没有找到符合条件的股票')).toBeVisible()
  expect(adjust).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '调整筛选要求' }))
  expect(adjust).toHaveBeenCalledOnce()
})

it('distinguishes an empty universe from no matches', () => {
  render(<ScreeningResultView status="succeeded" coverage={{ target_total: 0, true_count: 0, false_count: 0, unknown_count: 0 }} decisions={[]} />)
  expect(screen.getByText('本次没有可筛选的股票')).toBeVisible()
  expect(screen.queryByText('本次没有找到符合条件的股票')).not.toBeInTheDocument()
})

it('keeps failure information separate from matching and wires an available retry', () => {
  const retry = vi.fn()
  render(<ScreeningResultView status="failed" asOf="2026-09-30" coverage={{ ...mixed, true_count: 0, false_count: 0, unknown_count: 10 }} decisions={[]} progress={{ message: '行情数据读取失败', percent: 0.2 }} onRetry={retry} />)
  expect(screen.getByText('这次筛选未能完成')).toBeVisible()
  expect(screen.getByText('行情数据读取失败')).toBeVisible()
  expect(screen.getByText(/这不是零匹配结论/)).toBeVisible()
  expect(screen.queryByText('本次没有找到符合条件的股票')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(retry).toHaveBeenCalledOnce()
})

it('shows supplied evidence in the summary and keeps full judgments without an unexplained score', () => {
  const { container } = render(<ScreeningResultView status="succeeded" decisions={[
    { stock_code: '600000.SH', state: 'true', score: 99, conditions: [
      { name: '营收增长', state: 'true', explanation: '营收同比增长 25%', actual: 25, threshold: 20, citation: '年度报告第 12 页' },
      { name: 'ROE', state: 'true', explanation: 'ROE 为 18%' },
      { name: '估值', state: 'false', explanation: '市盈率为 12 倍' },
    ] },
  ]} />)
  fireEvent.click(screen.getByRole('button', { name: '详细卡片' }))
  const summary = container.querySelector('summary')!
  expect(within(summary).getByText('营收增长（符合）：营收同比增长 25%')).toBeVisible()
  expect(within(summary).getByText('ROE（符合）：ROE 为 18%')).toBeVisible()
  expect(screen.queryByText(/分值/)).not.toBeInTheDocument()
  fireEvent.click(summary)
  expect(screen.getByText('市盈率为 12 倍')).toBeInTheDocument()
  expect(screen.getByText('年度报告第 12 页')).toBeInTheDocument()
  expect(screen.getByText('实际值：25')).toBeInTheDocument()
  expect(screen.getByText('条件阈值：20')).toBeInTheDocument()
})

it('labels copy and export scopes and copies exactly displayed rows', async () => {
  const user = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const copyAll = vi.fn()
  const { rerender } = render(<ScreeningResultView status="partial" stateFilter="" query="银行" total={40} decisions={[
    { stock_code: '600000.SH', state: 'true', conditions: [] },
    { stock_code: '000001.SZ', state: 'false', conditions: [] },
  ]} onCopyAll={copyAll} onExportUrl="/export?state=&query=银行" />)
  await user.click(screen.getByRole('button', { name: '复制与导出' }))
  await user.click(screen.getByRole('menuitem', { name: '复制本页代码' }))
  expect(copy).toHaveBeenCalledWith('600000.SH\n000001.SZ')
  expect(screen.getByText(/包含本页显示的全部判断状态/)).toBeVisible()
  await user.click(screen.getByRole('button', { name: '复制与导出' }))
  await user.click(screen.getByRole('menuitem', { name: '复制搜索范围全部符合项' }))
  expect(copyAll).toHaveBeenCalledOnce()
  await user.click(screen.getByRole('button', { name: '复制与导出' }))
  expect(screen.getByRole('menuitem', { name: '导出当前筛选全部页' })).toHaveAttribute('href', '/export?state=&query=银行')
  rerender(<ScreeningResultView status="succeeded" decisions={[{ stock_code: '600000.SH', state: 'true', conditions: [] }]} />)
  await user.click(screen.getByRole('button', { name: '复制与导出' }))
  await user.click(screen.getByRole('menuitem', { name: '已复制' }))
  expect(copy).toHaveBeenLastCalledWith('600000.SH')
})

it('blocks stale page copy while results are loading or failed to load', () => {
  const decisions = [{ stock_code: '600000.SH', state: 'true', conditions: [] }]
  const { rerender } = render(<ScreeningResultView status="succeeded" loading decisions={decisions} />)
  fireEvent.click(screen.getByRole('button', { name: '复制与导出' }))
  expect(screen.getByRole('menuitem', { name: '复制本页代码' })).toBeDisabled()
  expect(screen.getByRole('menu', { name: '复制与导出' })).toHaveFocus()
  rerender(<ScreeningResultView status="succeeded" error="加载失败" decisions={decisions} />)
  fireEvent.click(screen.getByRole('button', { name: '复制与导出' }))
  expect(screen.getByRole('menuitem', { name: '复制本页代码' })).toBeDisabled()
  fireEvent.keyDown(screen.getByRole('menu', { name: '复制与导出' }), { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})


it('shows actual false-condition evidence for a true result without assuming AND logic', () => {
  const { container } = render(<ScreeningResultView status="succeeded" decisions={[
    { stock_code: '600000.SH', state: 'true', conditions: [
      { name: '亏损', state: 'false', explanation: '净利润为正' },
    ] },
  ]} />)
  fireEvent.click(screen.getByRole('button', { name: '详细卡片' }))
  expect(within(container.querySelector('summary')!).getByText('亏损（不符合）：净利润为正')).toBeVisible()
})

it('does not equate data insufficiency with no matches even when the run reports success', () => {
  render(<ScreeningResultView status="succeeded" coverage={{ target_total: 10, true_count: 0, false_count: 0, unknown_count: 10 }} decisions={[]} />)
  expect(screen.getByText('暂未确认符合项，仍有未完成的判断')).toBeVisible()
  expect(screen.queryByText('本次没有找到符合条件的股票')).not.toBeInTheDocument()
})

it('supports menu keyboard navigation, Escape, Tab, outside clicks, repeated toggles and context changes', async () => {
  const user = userEvent.setup()
  const props = { status: 'succeeded', decisions: [{ stock_code: '600000.SH', state: 'true', conditions: [] }], onCopyAll: vi.fn(), onExportUrl: '/export' }
  const view = render(<ScreeningResultView {...props} />)
  const trigger = screen.getByRole('button', { name: '复制与导出' })
  await user.click(trigger); await user.click(trigger)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  trigger.focus(); await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('menuitem', { name: '复制本页代码' })).toHaveFocus()
  await user.keyboard('{End}')
  expect(screen.getByRole('menuitem', { name: '导出当前筛选全部页' })).toHaveFocus()
  await user.keyboard('{Home}{ArrowDown}')
  expect(screen.getByRole('menuitem', { name: '复制全部符合项' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(trigger).toHaveFocus()
  await user.click(trigger); await user.keyboard('{Tab}')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  await user.click(trigger); await user.click(screen.getByText('数据截止日：未提供'))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  await user.click(trigger)
  view.rerender(<ScreeningResultView {...props} query="新的搜索" />)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('does not issue duplicate clipboard writes while the first copy is pending', async () => {
  const user = userEvent.setup()
  let finish!: () => void
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  render(<ScreeningResultView status="succeeded" decisions={[{ stock_code: '600000.SH', state: 'true', conditions: [] }]} />)
  for (let index = 0; index < 2; index++) {
    await user.click(screen.getByRole('button', { name: '复制与导出' }))
    await user.click(screen.getByRole('menuitem', { name: '复制本页代码' }))
  }
  expect(copy).toHaveBeenCalledOnce()
  await act(async () => finish())
})

it.each(['failed', 'cancelled'])('shows one empty-result explanation for %s', status => {
  render(<ScreeningResultView status={status} decisions={[]} />)
  expect(screen.getByText(status === 'failed' ? '这次筛选未能完成' : '这次筛选已取消')).toBeVisible()
  expect(screen.queryByText('本次运行暂无逐股记录。')).not.toBeInTheDocument()
})

it('does not present stale zero-match coverage as a conclusion during result loading or load failures', () => {
  const props = { status: 'succeeded', coverage: { target_total: 1, true_count: 0, false_count: 1, unknown_count: 0 }, decisions: [] }
  const view = render(<ScreeningResultView {...props} loading />)
  expect(screen.queryByText('本次没有找到符合条件的股票')).not.toBeInTheDocument()
  view.rerender(<ScreeningResultView {...props} error="网络连接失败" />)
  expect(screen.getByText('筛选结果加载失败')).toBeVisible()
  expect(screen.queryByText('本次没有找到符合条件的股票')).not.toBeInTheDocument()
})
