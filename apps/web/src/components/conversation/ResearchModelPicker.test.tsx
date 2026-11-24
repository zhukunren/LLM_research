import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../api'
import { modelModes } from '../../modelSelection'
import { modelCatalog } from '../../test/modelCatalog'
import ResearchModelPicker from './ResearchModelPicker'

vi.mock('../../api', () => ({ api: vi.fn() }))
beforeEach(() => { vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue(modelCatalog()) })

it('offers only the two presets and maps both switches to their fixed model and effort', async () => {
  const user = userEvent.setup(), onChange = vi.fn(), onAvailabilityChange = vi.fn()
  const view = render(<ResearchModelPicker disabled={false} onChange={onChange} onAvailabilityChange={onAvailabilityChange} />)
  const group = within(screen.getByRole('group', { name: '模型档位' }))
  expect(group.getAllByRole('button')).toHaveLength(2)
  expect(group.getByRole('button', { name: '即时' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(group.getByRole('button', { name: '深度' }))
  expect(onChange).toHaveBeenLastCalledWith({ model_id: 'gpt-6.2-sol', reasoning_effort: 'max' })
  view.rerender(<ResearchModelPicker disabled={false} value={modelModes.deep.selection} onChange={onChange} onAvailabilityChange={onAvailabilityChange} />)
  await user.click(group.getByRole('button', { name: '即时' }))
  expect(onChange).toHaveBeenLastCalledWith({ model_id: 'gpt-6.2-astra', reasoning_effort: 'low' })
})

it('keeps an unavailable selection visible until the user switches', async () => {
  vi.mocked(api).mockResolvedValue(modelCatalog('deep'))
  const user = userEvent.setup(), onChange = vi.fn(), onAvailabilityChange = vi.fn()
  render(<ResearchModelPicker disabled={false} value={modelModes.deep.selection} onChange={onChange} onAvailabilityChange={onAvailabilityChange} />)
  expect(await screen.findByText('当前账户不可用')).toBeVisible()
  await waitFor(() => expect(onAvailabilityChange).toHaveBeenLastCalledWith(false))
  const deep = screen.getByRole('button', { name: '深度' })
  expect(deep).toBeDisabled()
  expect(deep).toHaveAttribute('aria-pressed', 'true')
  expect(onChange).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '即时' }))
  expect(onChange).toHaveBeenCalledWith(modelModes.instant.selection)
})

it('retries loading availability after a service error', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('目录连接失败'))
  const user = userEvent.setup()
  render(<ResearchModelPicker disabled={false} onChange={vi.fn()} onAvailabilityChange={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '重试读取模型状态' }))
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('button', { name: '即时' })).toHaveAttribute('aria-pressed', 'true')
})
