import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import WorkspaceTooltips from './WorkspaceTooltips'

beforeEach(() => {
  const rect = new DOMRect(40, 80, 160, 32)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

it('describes a keyboard-focused control and restores its previous description after Escape', () => {
  render(<WorkspaceTooltips><p id="existing-help">原有说明</p><button data-tooltip="查看完整说明" aria-describedby="existing-help">查看</button></WorkspaceTooltips>)
  const button = screen.getByRole('button', { name: '查看' })
  act(() => button.focus())
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip).toHaveTextContent('查看完整说明')
  expect(button.getAttribute('aria-describedby')?.split(' ')).toContain(tooltip.id)
  expect(button).toHaveFocus()
  fireEvent.keyDown(button, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  expect(button).toHaveAttribute('aria-describedby', 'existing-help')
  expect(button).toHaveFocus()
})

it('delays pointer hints and removes them when the pointer leaves', () => {
  vi.useFakeTimers()
  render(<WorkspaceTooltips><button data-tooltip="辅助说明">查看</button></WorkspaceTooltips>)
  const button = screen.getByRole('button')
  fireEvent.pointerOver(button, { pointerType: 'mouse' })
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  act(() => vi.advanceTimersByTime(350))
  expect(screen.getByRole('tooltip')).toHaveTextContent('辅助说明')
  fireEvent.pointerOut(button, { relatedTarget: document.body })
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})

it('does not open a hover hint for a touch interaction', () => {
  vi.useFakeTimers()
  render(<WorkspaceTooltips><button data-tooltip="辅助说明">查看</button></WorkspaceTooltips>)
  const button = screen.getByRole('button'), over = createEvent.pointerOver(button)
  Object.defineProperty(over, 'pointerType', { value: 'touch' })
  fireEvent(button, over)
  act(() => vi.advanceTimersByTime(500))
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})

it('removes a hint when its control disappears during an update', async () => {
  const { rerender } = render(<WorkspaceTooltips><button data-tooltip="辅助说明">查看</button></WorkspaceTooltips>)
  act(() => screen.getByRole('button').focus())
  expect(screen.getByRole('tooltip')).toBeInTheDocument()
  rerender(<WorkspaceTooltips><p>已切换页面</p></WorkspaceTooltips>)
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
})
