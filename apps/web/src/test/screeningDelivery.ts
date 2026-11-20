import { screen, waitFor, within } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'

export async function openScreeningDetails(user: ReturnType<typeof userEvent.setup>, tab: 'plan' | 'result' = 'plan') {
  const findPanel = () => screen.queryByRole('region', { name: '筛选方案与结果' }) ?? screen.queryByRole('dialog', { name: '筛选方案与结果' })
  let panel = findPanel()
  if (!panel) {
    await user.click(await screen.findByRole('button', { name: tab === 'plan' ? '查看方案' : /^(查看名单|查看进度)$/ }))
    panel = await waitFor(() => { const current = findPanel(); if (!current) throw new Error('正在打开筛选详情'); return current })
  }
  const trigger = within(panel).getByRole('tab', { name: tab === 'plan' ? '筛选方案' : '筛选结果' })
  if (trigger.getAttribute('aria-selected') !== 'true') await user.click(trigger)
  return panel
}
