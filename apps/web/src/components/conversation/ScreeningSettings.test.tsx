import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import type { ResearchModelCatalog } from '../../modelSelection'

const catalog: ResearchModelCatalog = {
  account_tier: 'free', default_model_id: 'gpt-6-luna', default_reasoning_effort: 'high', discovery_status: 'verified',
  models: [
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', description: '默认模型', available: true, unavailable_reason: null, default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'low', label: '轻量' }, { id: 'high', label: '深入' }] },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', description: '复杂研究', available: false, unavailable_reason: '当前账户不可用', default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'high', label: '深入' }] },
  ],
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function backend(modelFailure = false) {
  const calls: { path: string; method: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    calls.push({ path, method: init?.method || 'GET' })
    if (path.endsWith('/research-models')) return modelFailure ? json({ detail: { message: '目录连接失败' } }, 503) : json(catalog)
    if (path.endsWith('/screening-capabilities')) return json({ capabilities: [{ id: 'market.daily_bars', title: '行情', availability: 'available' }] })
    return json({ items: [] })
  }))
  return calls
}
const props = { initialWorkflowType: 'screening' as const, initialNewDraft: true, data: { available: true, last_date: '2026-09-30' } }

it('keeps settings collapsed and preserves choices and the unsent draft through toggles and keyboard navigation', async () => {
  const calls = backend(), user = userEvent.setup()
  sessionStorage.setItem('research.modelPreference', JSON.stringify({ model_id: 'gpt-6-luna', reasoning_effort: 'low' }))
  render(<ConversationWorkspace {...props} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.type(screen.getByLabelText('选股要求'), '未发送的条件')
  const settings = screen.getByRole('button', { name: '选股设置' })
  expect(settings).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('button', { name: /选择研究模型/ })).not.toBeInTheDocument()
  await user.click(settings)
  await user.selectOptions(screen.getByLabelText('研究深度'), 'deep')
  expect(await screen.findByRole('button', { name: '选择研究模型，GPT-6 Luna，轻量' })).toBeVisible()
  await user.click(settings)
  settings.focus(); await user.keyboard('{Enter}')
  expect(screen.getByLabelText('研究深度')).toHaveValue('deep')
  await user.click(screen.getByRole('button', { name: /选择研究模型/ }))
  await user.keyboard('{End}')
  expect(screen.getByRole('menuitemradio', { name: '深入' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu', { name: '模型与推理设置' })).not.toBeInTheDocument()
  expect(settings).toHaveAttribute('aria-expanded', 'true')
  await user.keyboard('{Escape}')
  expect(settings).toHaveFocus()
  expect(settings).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByLabelText('选股要求')).toHaveValue('未发送的条件')
  expect(JSON.parse(sessionStorage.getItem('research.modelPreference')!)).toEqual({ model_id: 'gpt-6-luna', reasoning_effort: 'low' })
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
  await user.click(await screen.findByRole('button', { name: /选择研究模型/ }))
  view.rerender(<ConversationWorkspace {...props} newResearchKey={3} onNewResearchConsumed={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '选股设置' })).toHaveAttribute('aria-expanded', 'false'))
  expect(screen.queryByRole('menu', { name: '模型与推理设置' })).not.toBeInTheDocument()
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('keeps an unavailable stored model visible outside collapsed settings until the user explicitly changes it', async () => {
  backend()
  sessionStorage.setItem('research.modelPreference', JSON.stringify({ model_id: 'gpt-6-sol', reasoning_effort: 'high' }))
  const user = userEvent.setup()
  render(<ConversationWorkspace {...props} />)
  await screen.findByText('当前模型或推理档位不可用，请切换后发送。')
  await user.type(screen.getByLabelText('选股要求'), '保留条件')
  expect(screen.getByRole('button', { name: '生成筛选方案' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '切换模型' }))
  expect(await screen.findByRole('menuitemradio', { name: /GPT-6 Sol/ })).toBeDisabled()
  await user.click(screen.getByRole('menuitemradio', { name: /GPT-6 Luna/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: '生成筛选方案' })).toBeEnabled())
  expect(screen.getByLabelText('选股要求')).toHaveValue('保留条件')
})

it('reports catalog failures while settings are collapsed without replacing the model preference', async () => {
  backend(true)
  const preference = { model_id: 'gpt-6-luna', reasoning_effort: 'low' }
  sessionStorage.setItem('research.modelPreference', JSON.stringify(preference))
  render(<ConversationWorkspace {...props} />)
  expect(await screen.findByText(/模型目录暂不可用：目录连接失败/)).toBeVisible()
  expect(screen.getByRole('button', { name: '选股设置' })).toHaveAttribute('aria-expanded', 'false')
  expect(JSON.parse(sessionStorage.getItem('research.modelPreference')!)).toEqual(preference)
})
