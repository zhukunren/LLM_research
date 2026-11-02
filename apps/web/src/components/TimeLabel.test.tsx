import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import TimeLabel, { fullTimeDescription } from './TimeLabel'
import WorkspaceTooltips from './WorkspaceTooltips'
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
it('preserves a short time while exposing year, seconds and the actual timezone on focus and hover', () => {
  vi.useFakeTimers()
  const rect = new DOMRect(10, 10, 150, 30)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList)
  render(<WorkspaceTooltips><TimeLabel value="2025-12-31T20:30:15Z" timeZone="Asia/Shanghai" /></WorkspaceTooltips>)
  const time = screen.getByText('01/01 04:30')
  expect(time).toHaveAttribute('datetime', '2025-12-31T20:30:15.000Z')
  act(() => time.focus())
  expect(screen.getByRole('tooltip')).toHaveTextContent('2026')
  expect(screen.getByRole('tooltip')).toHaveTextContent('04:30:15')
  expect(screen.getByRole('tooltip')).toHaveTextContent('Asia/Shanghai')
  expect(screen.getByRole('tooltip')).toHaveTextContent('GMT+08:00')
  act(() => time.blur())
  fireEvent.pointerOver(time, { pointerType: 'mouse' }); act(() => vi.advanceTimersByTime(350))
  expect(screen.getByRole('tooltip')).toHaveTextContent('2026')
})
it('uses the offset at the represented instant, including daylight saving', () => {
  expect(fullTimeDescription('2026-01-01T12:00:00Z', 'America/New_York')).toContain('GMT-05:00')
  expect(fullTimeDescription('2026-07-01T12:00:00Z', 'America/New_York')).toContain('GMT-04:00')
})
it.each(['', 'not-a-date', '2026-99-99', '2026-02-30T00:00:00Z'])('renders invalid timestamps safely: %s', value => {
  render(<TimeLabel value={value} />)
  expect(screen.getByText('—')).not.toHaveAttribute('datetime')
  expect(screen.getByText('—')).toHaveAttribute('aria-label', '时间不可用')
})
it('can avoid an extra tab stop inside an already focusable row', () => {
  render(<button data-tooltip={fullTimeDescription('2026-01-01T00:00:00Z')}><TimeLabel value="2026-01-01T00:00:00Z" focusable={false} /></button>)
  expect(screen.getByRole('button').querySelector('time')).not.toHaveAttribute('tabindex')
})
