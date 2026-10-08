import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchProgress } from './ResearchFeedback'

const startedAt = '2026-10-08T08:00:00.000Z'
const props = { label: '正在搜索网页', startedAt, updatedAt: startedAt, stopping: false, onStop: vi.fn() }

afterEach(() => vi.useRealTimers())

describe('compact research progress', () => {
  it('announces only the current activity while time changes separately', () => {
    vi.useFakeTimers()
    vi.setSystemTime(startedAt)
    render(<ResearchProgress {...props} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在搜索网页')
    expect(screen.getByText('0 秒')).toHaveAttribute('aria-live', 'off')
    act(() => vi.advanceTimersByTime(12000))
    expect(screen.getByText('12 秒')).toBeInTheDocument()
    expect(screen.getByRole('status')).not.toHaveTextContent('秒')
    expect(screen.queryByText(/最近更新/)).not.toBeInTheDocument()
    expect(screen.queryByText(/仍在处理/)).not.toBeInTheDocument()
  })

  it('shows a brief wait hint only after a long pause and clears it on fresh progress', () => {
    vi.useFakeTimers()
    vi.setSystemTime(startedAt)
    const view = render(<ResearchProgress {...props} />)
    act(() => vi.advanceTimersByTime(90000))
    expect(screen.getByText('仍在处理，可继续等待或停止。')).toBeInTheDocument()
    view.rerender(<ResearchProgress {...props} label="正在阅读网页" updatedAt={new Date().toISOString()} />)
    expect(screen.queryByText(/仍在处理/)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在阅读网页')
  })

  it('keeps stopping accessible and prevents repeated stop requests', () => {
    const onStop = vi.fn()
    const view = render(<ResearchProgress {...props} onStop={onStop} />)
    fireEvent.click(screen.getByRole('button', { name: '停止当前研究' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    view.rerender(<ResearchProgress {...props} stopping onStop={onStop} />)
    expect(screen.getByRole('button', { name: '停止当前研究' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('正在停止…')
    expect(screen.queryByText(/仍在处理/)).not.toBeInTheDocument()
  })
})
