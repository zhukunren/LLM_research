import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchFailure, ResearchProgress } from './ResearchFeedback'

const startedAt = '2026-10-08T08:00:00.000Z'
const props = { label: '正在搜索网页', startedAt, updatedAt: startedAt, stopping: false, onStop: vi.fn() }

afterEach(() => vi.useRealTimers())

describe('compact research progress', () => {
  it('displays the public activity and offers an expandable research history', () => {
    render(<ResearchProgress {...props} activities={[{ id: 'public', label: '研究进展', phase: 'commentary', text: '先核对原始公告。', done: true }]} />)
    expect(screen.getByText('先核对原始公告。', { selector: '.research-progress-commentary' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('查看研究过程'))
    expect(screen.getByRole('list', { name: '研究活动记录' })).toBeInTheDocument()
  })
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


describe('research failure recovery', () => {
  it('offers only real callbacks and does not run research when checking services or editing scope', () => {
    const onRetry = vi.fn(), onOpenDataServices = vi.fn(), onAdjustScope = vi.fn()
    render(<ResearchFailure content="研究处理失败：timeout" onRetry={onRetry} onOpenDataServices={onOpenDataServices} onAdjustScope={onAdjustScope} />)
    expect(screen.getByText('这次研究等待超时')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '检查数据与服务' }))
    expect(onOpenDataServices).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '调整研究范围' }))
    expect(onAdjustScope).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重试这次研究' }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(screen.getByText('研究处理失败：timeout')).toBeInTheDocument()
  })

  it('does not invent a local-file cause for an access-denied error', () => {
    render(<ResearchFailure content="研究处理失败：remote access denied" />)
    expect(screen.getByText(/服务报告访问受限/)).toBeInTheDocument()
    expect(screen.queryByText(/无法访问所需的本地文件/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps the original error and existing results guidance without inventing a diagnosis', () => {
    render(<ResearchFailure content="研究处理失败：unknown new error" />)
    expect(screen.getByText('这次研究未能完成')).toBeInTheDocument()
    expect(screen.getByText(/原问题和已有成果已保留/)).toBeInTheDocument()
    expect(screen.getByText('研究处理失败：unknown new error')).toBeInTheDocument()
  })

  it('disables retry and scope edits during a current operation but retains the read-only service check', () => {
    render(<ResearchFailure content="研究处理失败" disabled onRetry={vi.fn()} onAdjustScope={vi.fn()} onOpenDataServices={vi.fn()} />)
    expect(screen.getByRole('button', { name: '重试这次研究' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '调整研究范围' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '检查数据与服务' })).toBeEnabled()
  })
})
