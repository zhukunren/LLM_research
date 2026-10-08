import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api'
import type { ResearchModelCatalog } from '../../modelSelection'
import ResearchModelPicker from './ResearchModelPicker'

vi.mock('../../api', () => ({ api: vi.fn() }))
const catalog: ResearchModelCatalog = {
  account_tier: 'free', default_model_id: 'gpt-6-luna', default_reasoning_effort: 'high', discovery_status: 'verified',
  models: [
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', description: '日常研究', available: true, unavailable_reason: null, default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'low', label: '轻量' }, { id: 'high', label: '深入' }, { id: 'max', label: '最大' }] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: '轻量研究', available: true, unavailable_reason: null, default_reasoning_effort: 'low', reasoning_efforts: [{ id: 'low', label: '轻量' }, { id: 'high', label: '深入' }] },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: '复杂研究', available: false, unavailable_reason: '当前 Free 账户不可用', default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'high', label: '深入' }] },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', description: '综合研究', available: false, unavailable_reason: '当前 Free 账户不可用', default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'high', label: '深入' }] },
  ],
}
beforeEach(() => { vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue(catalog) })
afterEach(() => { document.getElementById('test-model-slot')?.remove() })

describe('research model picker', () => {
  it('shows the server default without changing user selection and disables paid models', async () => {
    const onChange = vi.fn(), onAvailabilityChange = vi.fn()
    render(<ResearchModelPicker disabled={false} onChange={onChange} onAvailabilityChange={onAvailabilityChange} />)
    const trigger = await screen.findByRole('button', { name: '选择研究模型，GPT-6 Luna，深入' })
    expect(onChange).not.toHaveBeenCalled()
    await waitFor(() => expect(onAvailabilityChange).toHaveBeenCalledWith(true))
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitemradio', { name: /GPT-6 Astra/ })).toBeDisabled()
    expect(screen.getByRole('menuitemradio', { name: /GPT-6 Sol/ })).toBeDisabled()
    expect(screen.getAllByText('当前 Free 账户不可用')).toHaveLength(2)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /GPT-6 Astra/ }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /GPT-5.6 Luna/ }))
    expect(onChange).toHaveBeenCalledWith({ model_id: 'gpt-5.6-luna', reasoning_effort: 'high' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('offers only supported effort levels and uses the new model default when necessary', async () => {
    const onChange = vi.fn()
    const view = render(<ResearchModelPicker value={{ model_id: 'gpt-6-luna', reasoning_effort: 'max' }} disabled={false} onChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: '选择研究模型，GPT-6 Luna，最大' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /GPT-5.6 Luna/ }))
    expect(onChange).toHaveBeenLastCalledWith({ model_id: 'gpt-5.6-luna', reasoning_effort: 'low' })
    view.rerender(<ResearchModelPicker value={{ model_id: 'gpt-5.6-luna', reasoning_effort: 'low' }} disabled={false} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '选择研究模型，GPT-5.6 Luna，轻量' }))
    const efforts = screen.getByRole('group', { name: '推理强度' })
    expect(within(efforts).queryByRole('menuitemradio', { name: '最大' })).not.toBeInTheDocument()
    fireEvent.click(within(efforts).getByRole('menuitemradio', { name: '深入' }))
    expect(onChange).toHaveBeenLastCalledWith({ model_id: 'gpt-5.6-luna', reasoning_effort: 'high' })
  })

  it('retains a saved unavailable model and reports unavailable without silently replacing it', async () => {
    const onChange = vi.fn(), onAvailabilityChange = vi.fn()
    render(<ResearchModelPicker value={{ model_id: 'gpt-6-astra', reasoning_effort: 'high' }} disabled={false} onChange={onChange} onAvailabilityChange={onAvailabilityChange} />)
    await screen.findByRole('button', { name: '选择研究模型，GPT-6 Astra，深入' })
    await waitFor(() => expect(onAvailabilityChange).toHaveBeenCalledWith(false))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not invent available models during loading or failure and permits retry', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('模型目录暂不可用'))
    const onAvailabilityChange = vi.fn(), onChange = vi.fn()
    render(<ResearchModelPicker disabled={false} onChange={onChange} onAvailabilityChange={onAvailabilityChange} />)
    fireEvent.click(screen.getByRole('button', { name: '选择研究模型' }))
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
    await screen.findByRole('alert')
    expect(onAvailabilityChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await screen.findByRole('menuitemradio', { name: /GPT-6 Luna/ })
    await waitFor(() => expect(onAvailabilityChange).toHaveBeenCalledWith(true))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects malformed catalogs without changing availability or model selection', async () => {
    vi.mocked(api).mockResolvedValue({ models: [{ id: 'gpt-6-astra', available: 'true' }] })
    const onAvailabilityChange = vi.fn(), onChange = vi.fn()
    render(<ResearchModelPicker disabled={false} onChange={onChange} onAvailabilityChange={onAvailabilityChange} />)
    fireEvent.click(screen.getByRole('button', { name: '选择研究模型' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('模型目录格式异常')
    expect(onAvailabilityChange).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
  })

  it('anchors the trigger in the header, supports keyboard navigation and restores focus on Escape or outside dismissal', async () => {
    const target = document.createElement('div')
    target.id = 'test-model-slot'; document.body.appendChild(target)
    const user = userEvent.setup()
    render(<ResearchModelPicker portalTargetId="test-model-slot" disabled={false} onChange={vi.fn()} />)
    const trigger = await screen.findByRole('button', { name: '选择研究模型，GPT-6 Luna，深入' })
    expect(target).toContainElement(trigger)
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: /GPT-6 Luna/ })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: /GPT-5.6 Luna/ })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('prevents changing settings while a turn is running and closes an already open menu', async () => {
    const onChange = vi.fn()
    const view = render(<ResearchModelPicker disabled={false} onChange={onChange} />)
    const trigger = await screen.findByRole('button', { name: '选择研究模型，GPT-6 Luna，深入' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    view.rerender(<ResearchModelPicker disabled onChange={onChange} />)
    expect(trigger).toBeDisabled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
