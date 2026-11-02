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
  expect(screen.getByText('不符合 · 亏损 · 净利润为正')).toBeVisible()
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
  expect(screen.getByText(/包含 2 只处理失败、1 只未处理/)).not.toBeVisible()
  fireEvent.click(screen.getByText('覆盖明细'))
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

it('shows compact evidence previews and opens full judgments in the sidebar', () => {
  render(<ScreeningResultView status="succeeded" decisions={[
    { stock_code: '600000.SH', state: 'true', score: 99, conditions: [
      { name: '营收增长', state: 'true', explanation: '营收同比增长 25%', actual: 25, threshold: 20, citation: '年度报告第 12 页' },
      { name: 'ROE', state: 'true', explanation: 'ROE 为 18%' },
      { name: '估值', state: 'false', explanation: '市盈率为 12 倍' },
    ] },
  ]} />)
  const table = screen.getByRole('table', { name: '筛选结果股票列表' })
  expect(within(table).getByText(/实际值：25/)).toBeVisible()
  expect(within(table).getByText(/估值 · 市盈率为 12 倍/)).toBeVisible()
  expect(screen.queryByRole('button', { name: '详细卡片' })).not.toBeInTheDocument()
  expect(screen.queryByText(/分值/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '查看 600000.SH 条件与依据' }))
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
  render(<ScreeningResultView status="succeeded" decisions={[
    { stock_code: '600000.SH', state: 'true', conditions: [
      { name: '亏损', state: 'false', explanation: '净利润为正' },
    ] },
  ]} />)
  expect(within(screen.getByRole('table', { name: '筛选结果股票列表' })).getByText(/不符合 · 亏损 · 净利润为正/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '查看 600000.SH 条件与依据' }))
  expect(within(screen.getByRole('dialog', { name: '个股条件与依据' })).getByText('亏损 · 不符合')).toBeVisible()
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

it('offers parameter adjustments on a complete zero-match result', () => {
  const apply = vi.fn()
  render(<ScreeningResultView status="succeeded" coverage={{ target_total: 10, true_count: 0, false_count: 10, unknown_count: 0 }} decisions={[]}
    adjustments={[{ id: 'threshold', label: '把涨幅阈值从 3% 放宽到 2%', prompt: '把涨幅阈值从 3% 放宽到 2%，然后重新筛选。' }]}
    onApplyAdjustment={apply} />)
  expect(screen.getByText('本次没有找到符合条件的股票')).toBeVisible()
  expect(screen.getByText('可以试着调整：')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '把涨幅阈值从 3% 放宽到 2%' }))
  expect(apply).toHaveBeenCalledWith('把涨幅阈值从 3% 放宽到 2%，然后重新筛选。')
})

it('prompts saving a successful result that has matches', () => {
  const save = vi.fn()
  render(<ScreeningResultView status="succeeded" coverage={mixed} decisions={[]} onSavePlan={save} />)
  expect(screen.getByText(/已筛出 2 只/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '保存为方案' }))
  expect(save).toHaveBeenCalledOnce()
})

it('offers data and scope actions while coverage is incomplete', () => {
  const open = vi.fn(), adjust = vi.fn()
  render(<ScreeningResultView status="partial" coverage={{ ...mixed, true_count: 0, false_count: 0, unknown_count: 10 }} decisions={[]}
    onOpenData={open} onAdjustRequirements={adjust} />)
  expect(screen.getByText('暂未确认符合项，仍有未完成的判断')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '更新数据' }))
  expect(open).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '缩小范围' }))
  expect(adjust).toHaveBeenCalledOnce()
})

it('keeps all selected row snapshots across pages for copy, export and observation', async () => {
  const user = userEvent.setup(), copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const writes: string[] = [], blobs: Blob[] = []
  vi.stubGlobal('fetch', vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(JSON.parse(String(init.body)).stock_code)
    return new Response(JSON.stringify({ items: [] }), { status: 200 })
  }))
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:test' }), revokeObjectURL: vi.fn() }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const first = [{ stock_code: '600000.SH', state: 'true', conditions: [] }], second = [{ stock_code: '000001.SZ', state: 'false', conditions: [] }]
  const view = render(<ScreeningResultView status="succeeded" decisions={first} />)
  await user.click(screen.getByRole('checkbox', { name: '勾选本页全部筛选结果' }))
  view.rerender(<ScreeningResultView status="succeeded" decisions={first} offset={20} loading />)
  expect(screen.getByText('已选 1 只')).toBeInTheDocument()
  view.rerender(<ScreeningResultView status="succeeded" decisions={second} offset={20} />)
  await user.click(screen.getByRole('checkbox', { name: '勾选本页全部筛选结果' }))
  expect(screen.getByText('已选 2 只')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '复制所选' }))
  expect(copy).toHaveBeenCalledWith('600000.SH\n000001.SZ')
  await user.click(screen.getByRole('button', { name: '导出所选' }))
  const exported = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blobs[0]) })
  expect(exported).toContain('600000.SH'); expect(exported).toContain('000001.SZ')
  await user.click(screen.getByRole('button', { name: '加入观察池' }))
  await waitFor(() => expect(writes).toEqual(['600000.SH', '000001.SZ']))
})

it('unchecks only the current page and clears selections on a new batch or filter', async () => {
  const user = userEvent.setup()
  const first = [{ stock_code: '600000.SH', state: 'true', conditions: [] }], second = [{ stock_code: '000001.SZ', state: 'true', conditions: [] }]
  const view = render(<ScreeningResultView resultKey="run-a" status="succeeded" decisions={first} />)
  await user.click(screen.getByRole('checkbox', { name: '勾选本页全部筛选结果' }))
  view.rerender(<ScreeningResultView resultKey="run-a" status="succeeded" decisions={second} offset={20} />)
  await user.click(screen.getByRole('checkbox', { name: '勾选本页全部筛选结果' }))
  await user.click(screen.getByRole('checkbox', { name: '勾选本页全部筛选结果' }))
  expect(screen.getByText('已选 1 只')).toBeInTheDocument()
  view.rerender(<ScreeningResultView resultKey="run-b" status="succeeded" decisions={second} />)
  expect(screen.queryByRole('group', { name: '所选结果操作' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('checkbox', { name: '勾选本页全部筛选结果' }))
  view.rerender(<ScreeningResultView resultKey="run-b" status="succeeded" decisions={second} query="银行" />)
  expect(screen.queryByRole('group', { name: '所选结果操作' })).not.toBeInTheDocument()
})

it('prioritizes unresolved and false conditions and labels actual values and thresholds', () => {
  render(<ScreeningResultView status="partial" decisions={[{ stock_code: '600000.SH', state: 'true', conditions: [
    { name: '股价', state: 'true', actual: 10, explanation: '' },
    { name: '营业收入同比增长率', state: 'unknown', threshold: 15, explanation: '缺少报告' },
    { name: 'ROE', state: 'false', actual: 8, threshold: 12, explanation: '' },
  ] }]} />)
  const table = screen.getByRole('table')
  expect(within(table).getByText(/营业收入同比增长率.*缺少报告.*门槛：15/)).toBeVisible()
  expect(within(table).getByText(/ROE.*实际值：8.*门槛：12/)).toBeVisible()
  expect(within(table).queryByText(/股价.*实际值/)).not.toBeInTheDocument()
})

it('navigates page evidence, retains opening focus and ignores composing Escape', async () => {
  const user = userEvent.setup()
  render(<ScreeningResultView status="succeeded" decisions={['600000.SH', '000001.SZ'].map(stock_code => ({ stock_code, state: 'true', conditions: [] }))} />)
  const opener = screen.getByRole('button', { name: '查看 600000.SH 条件与依据' })
  await user.click(opener)
  expect(screen.getByRole('button', { name: '上一只' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '下一只' }))
  expect(screen.getByText('本页 2 / 2')).toBeVisible()
  expect(screen.getByRole('button', { name: '下一只' })).toBeDisabled()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', isComposing: true })
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(opener).toHaveFocus()
})

it('stops remaining batch writes after a scope change and ignores a late failed response', async () => {
  const user = userEvent.setup(), writes: string[] = []
  let finish!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)).stock_code)
      return new Promise<Response>(resolve => { finish = resolve })
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 })
  }))
  const rows = ['600000.SH', '000001.SZ'].map(stock_code => ({ stock_code, state: 'true', conditions: [] }))
  const view = render(<ScreeningResultView resultKey="old" status="succeeded" decisions={rows} />)
  await user.click(screen.getByRole('checkbox', { name: '勾选本页全部筛选结果' }))
  const add = screen.getByRole('button', { name: '加入观察池' })
  fireEvent.click(add); fireEvent.click(add)
  expect(writes).toEqual(['600000.SH'])
  view.rerender(<ScreeningResultView resultKey="new" status="succeeded" decisions={rows} />)
  await user.click(screen.getByRole('checkbox', { name: '勾选筛选结果 000001.SZ' }))
  await act(async () => finish(new Response(JSON.stringify({ detail: '旧请求失败' }), { status: 503 })))
  expect(writes).toEqual(['600000.SH'])
  expect(screen.getByText('已选 1 只')).toBeVisible()
  expect(screen.getByRole('checkbox', { name: '勾选筛选结果 000001.SZ' })).toBeChecked()
  expect(screen.queryByText(/旧请求失败/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '加入观察池' })).toBeEnabled()
})

it('guards repeated selected clipboard requests and suppresses old-scope feedback', async () => {
  const user = userEvent.setup()
  let finish!: () => void
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  const rows = [{ stock_code: '600000.SH', state: 'true', conditions: [] }]
  const view = render(<ScreeningResultView status="succeeded" decisions={rows} />)
  await user.click(screen.getByRole('checkbox', { name: '勾选本页全部筛选结果' }))
  fireEvent.click(screen.getByRole('button', { name: '复制所选' })); fireEvent.click(screen.getByRole('button', { name: '复制所选' }))
  expect(copy).toHaveBeenCalledOnce()
  view.rerender(<ScreeningResultView status="succeeded" stateFilter="false" decisions={rows} />)
  await act(async () => finish())
  expect(screen.queryByText(/已复制所选/)).not.toBeInTheDocument()
})

it('closes the evidence drawer when a different page begins loading', async () => {
  const user = userEvent.setup(), rows = [{ stock_code: '600000.SH', state: 'true', conditions: [] }]
  const view = render(<ScreeningResultView status="succeeded" decisions={rows} />)
  await user.click(screen.getByRole('button', { name: '查看 600000.SH 条件与依据' }))
  view.rerender(<ScreeningResultView status="succeeded" decisions={rows} offset={20} loading />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(document.body.style.overflow).not.toBe('hidden')
})
