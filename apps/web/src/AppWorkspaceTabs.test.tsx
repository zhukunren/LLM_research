import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { SecuritiesProvider } from './components/StockSearch'

beforeEach(() => {
  window.history.replaceState(null, '', '#/research/new')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const response = path === '/api/v1/data/status' ? { available: true, last_date: '2026-10-15' } : { items: [] }
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})

it.each(['research', 'screening'] as const)('opens an old indicator bookmark in the %s My Indicators drawer without submitting work', async workspace => {
  window.history.replaceState(null, '', '#/library/technical?workspace=' + workspace)
  let finishCatalog!: (response: Response) => void
  const catalog = new Promise<Response>(resolve => { finishCatalog = resolve })
  const defaultFetch = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) => String(input).includes('/security-catalog') ? catalog : defaultFetch(input, init))
  render(<StrictMode><SecuritiesProvider><App /></SecuritiesProvider></StrictMode>)
  expect(await screen.findByRole('dialog', { name: '我的指标' }, { timeout: 5000 })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '常用指标预览' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '内置指标参考' })).not.toBeInTheDocument()
  const label = workspace === 'research' ? '研究要求' : '选股要求'
  await waitFor(() => expect(screen.getByLabelText(label)).toBeEnabled())
  const composer = screen.getByLabelText(label)
  await act(async () => finishCatalog(new Response(JSON.stringify({ items: [{ stock_code: '600519.SH', name: '贵州茅台', market: 'SH' }, { stock_code: '000001.SH', name: '上证指数', market: '指数' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  expect(screen.getByLabelText(label)).toBe(composer)
  expect(screen.getByRole('dialog', { name: '我的指标' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '关闭我的指标' }))
  expect(screen.queryByRole('dialog', { name: '我的指标' })).not.toBeInTheDocument()
  expect(screen.getByLabelText(label)).toHaveValue('')
  expect(vi.mocked(fetch).mock.calls.every(call => !call[1]?.method)).toBe(true)
})

it('keeps the original draft DOM and scroll position when opening a function in another tab', async () => {
  const user = userEvent.setup()
  render(<App />)
  const draft = await screen.findByLabelText('研究要求')
  await waitFor(() => expect(draft).toBeEnabled())
  await user.type(draft, '保留订单研究草稿')
  const pane = screen.getByRole('tabpanel')
  pane.scrollTop = 120
  await user.click(screen.getByRole('button', { name: '资料库' }))
  expect(await screen.findByRole('heading', { name: '资料库' })).toBeInTheDocument()
  expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1)
  expect(screen.queryByLabelText('研究要求')).not.toBeInTheDocument()
  await user.click(screen.getByRole('tab', { name: '新研究' }))
  expect(screen.getByLabelText('研究要求')).toBe(draft)
  expect(draft).toHaveValue('保留订单研究草稿')
  expect(screen.getByRole('tabpanel')).toBe(pane)
  expect(pane.scrollTop).toBe(120)
  expect(screen.getAllByRole('tab')).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: '资料库' }))
  expect(screen.getAllByRole('tab')).toHaveLength(2)
})

it('isolates two unsent research drafts at the same URL and restores both after reload', async () => {
  const user = userEvent.setup(), view = render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '第一份研究')
  const firstId = screen.getByRole('tab', { selected: true }).id
  await user.click(screen.getByRole('button', { name: '新建研究标签' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getByLabelText('研究要求')).toHaveValue('')
  await user.type(screen.getByLabelText('研究要求'), '第二份研究')
  const secondId = screen.getByRole('tab', { selected: true }).id
  await user.click(document.getElementById(firstId)!)
  expect(screen.getByLabelText('研究要求')).toHaveValue('第一份研究')
  view.unmount()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getByRole('tab', { selected: true })).toHaveAttribute('id', firstId)
  expect(screen.getByLabelText('研究要求')).toHaveValue('第一份研究')
  await user.click(document.getElementById(secondId)!)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getByLabelText('研究要求')).toHaveValue('第二份研究')
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
})

it('supports arrow-key tab selection and deletion without discarding adjacent drafts', async () => {
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '仍在编辑')
  await user.click(screen.getByRole('button', { name: '新建研究标签' }))
  const active = screen.getByRole('tab', { selected: true })
  active.focus()
  await user.keyboard('{ArrowLeft}')
  expect(screen.getByLabelText('研究要求')).toHaveValue('仍在编辑')
  await user.keyboard('{ArrowRight}{Delete}')
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(screen.getByLabelText('研究要求')).toHaveValue('仍在编辑')
})

it('keeps the right-clicked draft when closing others and returns to a blank draft after closing all', async () => {
  const user = userEvent.setup(), view = render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '需要保留的研究')
  const keepId = screen.getByRole('tab', { selected: true }).id
  await user.click(screen.getByRole('button', { name: '新建研究标签' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '另一个研究草稿')
  await user.pointer({ target: document.getElementById(keepId)!, keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: '关闭其他标签' }))
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(screen.getByRole('tab', { selected: true })).toHaveAttribute('id', keepId)
  expect(screen.getByLabelText('研究要求')).toHaveValue('需要保留的研究')
  await user.pointer({ target: screen.getByRole('tab'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: '关闭当前标签' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getByLabelText('研究要求')).toHaveValue('')
  await user.type(screen.getByLabelText('研究要求'), '关闭全部前的草稿')
  await user.click(screen.getByRole('button', { name: '新建研究标签' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.pointer({ target: screen.getByRole('tab', { selected: true }), keys: '[MouseRight]' })
  await user.click(await screen.findByRole('menuitem', { name: '关闭全部标签' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(screen.getByLabelText('研究要求')).toHaveValue('')
  expect(window.location.hash).toBe('#/research/new')
  view.unmount()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(screen.getByLabelText('研究要求')).toHaveValue('')
})

it('keeps the active editor and both drafts while reordering, and restores the new order on reload', async () => {
  const user = userEvent.setup(), view = render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '第一份草稿')
  const first = screen.getByRole('tab', { selected: true })
  await user.click(screen.getByRole('button', { name: '新建研究标签' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '第二份草稿')
  const second = screen.getByRole('tab', { selected: true }), editor = screen.getByLabelText('研究要求')
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  for (const [type, target] of [['dragstart', first], ['dragover', second], ['drop', second]] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, { clientX: 20, dataTransfer })
    fireEvent(target, event)
  }
  expect(screen.getAllByRole('tab').map(tab => tab.id)).toEqual([second.id, first.id])
  expect(screen.getByRole('tab', { selected: true })).toBe(second)
  expect(screen.getByLabelText('研究要求')).toBe(editor)
  expect(editor).toHaveValue('第二份草稿')
  view.unmount()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getAllByRole('tab').map(tab => tab.id)).toEqual([second.id, first.id])
  expect(screen.getByRole('tab', { selected: true })).toHaveAttribute('id', second.id)
  expect(screen.getByLabelText('研究要求')).toHaveValue('第二份草稿')
  await user.click(document.getElementById(first.id)!)
  expect(screen.getByLabelText('研究要求')).toHaveValue('第一份草稿')
})

it('closes left and right tabs after reordering while preserving the target draft and reload state', async () => {
  const user = userEvent.setup(), view = render(<App />), ids: string[] = []
  for (let index = 0; index < 3; index++) {
    if (index) await user.click(screen.getByRole('button', { name: '新建研究标签' }))
    await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
    await user.type(screen.getByLabelText('研究要求'), `研究草稿${index + 1}`)
    ids.push(screen.getByRole('tab', { selected: true }).id)
  }
  document.getElementById(ids[2])!.focus()
  await user.keyboard('{Control>}{Shift>}{ArrowLeft}{ArrowLeft}{/Shift}{/Control}')
  expect(screen.getAllByRole('tab').map(tab => tab.id)).toEqual([ids[2], ids[0], ids[1]])
  await user.pointer({ target: document.getElementById(ids[0])!, keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: '关闭左侧标签' }))
  expect(screen.getAllByRole('tab').map(tab => tab.id)).toEqual([ids[0], ids[1]])
  expect(screen.getByRole('tab', { selected: true })).toHaveAttribute('id', ids[0])
  expect(screen.getByLabelText('研究要求')).toHaveValue('研究草稿1')
  const editor = screen.getByLabelText('研究要求')
  await user.pointer({ target: document.getElementById(ids[0])!, keys: '[MouseRight]' })
  expect(screen.getByRole('menuitem', { name: '关闭左侧标签' })).toBeDisabled()
  await user.click(screen.getByRole('menuitem', { name: '关闭右侧标签' }))
  expect(screen.getByLabelText('研究要求')).toBe(editor)
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  view.unmount()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getAllByRole('tab')).toHaveLength(1)
  expect(screen.getByRole('tab')).toHaveAttribute('id', ids[0])
  expect(screen.getByLabelText('研究要求')).toHaveValue('研究草稿1')
})

it('reopens recently closed independent drafts after reload without clearing them', async () => {
  const user = userEvent.setup(), view = render(<App />), ids: string[] = []
  for (let index = 0; index < 3; index++) {
    if (index) await user.click(screen.getByRole('button', { name: '新建研究标签' }))
    await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
    await user.type(screen.getByLabelText('研究要求'), `待恢复研究${index + 1}`)
    ids.push(screen.getByRole('tab', { selected: true }).id)
  }
  for (let index = 0; index < 2; index++) {
    await user.pointer({ target: screen.getByRole('tab', { selected: true }), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: '关闭当前标签' }))
  }
  view.unmount()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  for (const index of [1, 2]) {
    await user.pointer({ target: screen.getByRole('tab', { selected: true }), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: '重新打开关闭的标签' }))
    await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
    expect(screen.getByRole('tab', { selected: true })).toHaveAttribute('id', ids[index])
    expect(screen.getByLabelText('研究要求')).toHaveValue(`待恢复研究${index + 1}`)
  }
  expect(screen.getAllByRole('tab').map(tab => tab.id)).toEqual(ids)
  await user.pointer({ target: screen.getByRole('tab', { selected: true }), keys: '[MouseRight]' })
  expect(screen.getByRole('menuitem', { name: '重新打开关闭的标签' })).toBeDisabled()
})

it('restores an edited seeded QMT draft without replaying the original prompt', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: '切换到选股' }))
  await user.click(screen.getByRole('button', { name: '策略工具' }))
  await user.click(screen.getByRole('button', { name: 'QMT 脚本生成' }))
  await user.click(await screen.findByRole('button', { name: '均线交叉' }))
  await user.click(screen.getByRole('button', { name: '带入生成对话' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).not.toHaveValue(''))
  await user.clear(screen.getByLabelText('研究要求'))
  await user.type(screen.getByLabelText('研究要求'), '修改后的策略要求，恢复时保留这份草稿')
  const draftId = screen.getByRole('tab', { selected: true }).id
  await user.pointer({ target: screen.getByRole('tab', { selected: true }), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: '关闭当前标签' }))
  await user.pointer({ target: screen.getByRole('tab', { selected: true }), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: '重新打开关闭的标签' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getByRole('tab', { selected: true })).toHaveAttribute('id', draftId)
  expect(screen.getByLabelText('研究要求')).toHaveValue('修改后的策略要求，恢复时保留这份草稿')
})


it('creates a screening tab from the screening mode without changing the original draft', async () => {
  window.history.replaceState(null, '', '#/screening/new')
  const user = userEvent.setup()
  render(<App />)
  const draft = await screen.findByLabelText('选股要求')
  await waitFor(() => expect(draft).toBeEnabled())
  await user.type(draft, '原选股草稿')
  const firstTab = screen.getByRole('tab', { selected: true })
  await user.click(screen.getByRole('button', { name: '新建选股标签' }))
  expect(await screen.findByLabelText('选股要求')).toHaveValue('')
  expect(screen.queryByLabelText('研究要求')).not.toBeInTheDocument()
  await user.click(firstTab)
  expect(screen.getByLabelText('选股要求')).toBe(draft)
  expect(draft).toHaveValue('原选股草稿')
})
