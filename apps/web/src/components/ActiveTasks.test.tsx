import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import type { UserTask } from '../features/tasks/taskTypes'
import ActiveTasks from './ActiveTasks'

vi.mock('../api', () => ({ api: vi.fn() }))
const task = (kind: string, destination: UserTask['destination'], state = 'running'): UserTask => ({
  id: kind, kind, title: kind === 'data_sync' ? '资料更新' : '研报整理', kind_label: '资料处理', state,
  state_label: state === 'failed' ? '需重试' : '处理中', stage: state === 'failed' ? '打开详情查看恢复方式。' : '正在处理，可先继续其他工作。',
  created_at: '2026-10-06T01:00:00Z', updated_at: '2026-10-06T01:00:00Z', action_label: '打开原工作', destination,
})

it('opens update and report work with a visible stage and no mutation', async () => {
  vi.mocked(api).mockResolvedValue({ active_count: 2, items: [task('data_sync', { kind: 'settings' }), task('report_metadata', { kind: 'page', page: 'reports' })] })
  const user = userEvent.setup(), onSettings = vi.fn(), onNavigate = vi.fn()
  render(<ActiveTasks onConversation={vi.fn()} onSettings={onSettings} onNavigate={onNavigate} />)
  await user.click(screen.getByRole('button', { name: '运行任务' }))
  await user.click(await screen.findByRole('button', { name: /资料更新/ }))
  expect(onSettings).toHaveBeenCalledOnce()
  await user.click(screen.getByRole('button', { name: '运行任务' }))
  await user.click(await screen.findByRole('button', { name: /研报整理/ }))
  expect(onNavigate).toHaveBeenCalledWith('reports')
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true)
})

it('makes recently failed work discoverable and keeps the active count separate', async () => {
  vi.mocked(api).mockImplementation(async path => ({ active_count: 0, items: path.includes('active_only=false') ? [task('report_metadata', { kind: 'page', page: 'reports' }, 'failed')] : [] }) as never)
  const user = userEvent.setup()
  render(<ActiveTasks onConversation={vi.fn()} onNavigate={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: '运行任务' }))
  await screen.findByText(/当前没有正在运行的任务/)
  await user.click(screen.getByRole('button', { name: '最近任务' }))
  expect(await screen.findByRole('button', { name: /需重试/ })).toHaveTextContent('恢复方式')
  expect(screen.getByRole('button', { name: '最近任务' })).toHaveAttribute('aria-pressed', 'true')
})
