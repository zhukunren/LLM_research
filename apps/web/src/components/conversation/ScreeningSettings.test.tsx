import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import { modelCatalog } from '../../test/modelCatalog'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function backend(modelFailure = false) {
  const calls: { path: string; method: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    calls.push({ path, method: init?.method || 'GET' })
    if (path.endsWith('/research-models')) return modelFailure ? json({ detail: { message: '目录连接失败' } }, 503) : json(modelCatalog('deep'))
    if (path.endsWith('/screening-capabilities')) return json({ capabilities: [{ id: 'market.daily_bars', title: '行情', availability: 'available' }] })
    return json({ items: [] })
  }))
  return calls
}
const props = { initialWorkflowType: 'screening' as const, initialNewDraft: true, data: { available: true, last_date: '2026-09-30' } }

it('keeps settings collapsed and preserves choices and the unsent draft through toggles and keyboard navigation', async () => {
  const calls = backend(), user = userEvent.setup()
  sessionStorage.setItem('research.modelPreference', JSON.stringify({ model_id: 'gpt-6.2-astra', reasoning_effort: 'low' }))
  render(<ConversationWorkspace {...props} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.type(screen.getByLabelText('选股要求'), '未发送的条件')
  const settings = screen.getByRole('button', { name: '选股设置' })
  expect(settings).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('button', { name: '即时' })).toBeVisible()
  await user.click(settings)
  await user.selectOptions(screen.getByLabelText('研究深度'), 'deep')
  expect(await screen.findByRole('button', { name: '即时' })).toBeVisible()
  await user.click(settings)
  settings.focus(); await user.keyboard('{Enter}')
  expect(screen.getByLabelText('研究深度')).toHaveValue('deep')
  await user.keyboard('{Escape}')
  expect(settings).toHaveFocus()
  expect(settings).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByLabelText('选股要求')).toHaveValue('未发送的条件')
  expect(JSON.parse(sessionStorage.getItem('research.modelPreference')!)).toEqual({ model_id: 'gpt-6.2-astra', reasoning_effort: 'low' })
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('closes nested settings on outside clicks and when a new screening conversation is requested', async () => {
  const calls = backend(), user = userEvent.setup()
  const view = render(<ConversationWorkspace {...props} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '选股设置' }))
  await user.click(screen.getByLabelText('选股要求'))
  expect(screen.getByRole('button', { name: '选股设置' })).toHaveAttribute('aria-expanded', 'false')
  await user.click(screen.getByRole('button', { name: '选股设置' }))
  view.rerender(<ConversationWorkspace {...props} newResearchKey={3} onNewResearchConsumed={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '选股设置' })).toHaveAttribute('aria-expanded', 'false'))
  expect(screen.getByRole('group', { name: '模型档位' })).toBeVisible()
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('keeps an unavailable stored model visible outside collapsed settings until the user explicitly changes it', async () => {
  backend()
  sessionStorage.setItem('research.modelPreference', JSON.stringify({ model_id: 'gpt-6.2-sol', reasoning_effort: 'max' }))
  const user = userEvent.setup()
  render(<ConversationWorkspace {...props} />)
  await screen.findByText('当前账户不可用')
  await user.type(screen.getByLabelText('选股要求'), '保留条件')
  expect(screen.getByRole('button', { name: '生成并筛选' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '深度' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '即时' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '生成并筛选' })).toBeEnabled())
  expect(screen.getByLabelText('选股要求')).toHaveValue('保留条件')
})

it('reports catalog failures while settings are collapsed without replacing the model preference', async () => {
  backend(true)
  const preference = { model_id: 'gpt-6.2-astra', reasoning_effort: 'low' }
  sessionStorage.setItem('research.modelPreference', JSON.stringify(preference))
  render(<ConversationWorkspace {...props} />)
  expect(await screen.findByRole('button', { name: '重试读取模型状态' })).toBeVisible()
  expect(screen.getByRole('button', { name: '选股设置' })).toHaveAttribute('aria-expanded', 'false')
  expect(JSON.parse(sessionStorage.getItem('research.modelPreference')!)).toEqual(preference)
})
