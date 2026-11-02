import { screen, within } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'

export async function openScreeningDetails(user: ReturnType<typeof userEvent.setup>, tab: 'plan' | 'result' = 'plan') {
  let panel = screen.queryByRole('dialog', { name: '筛选方案与结果' })
  if (!panel) {
    await user.click(await screen.findByRole('button', { name: tab === 'plan' ? '查看方案' : /^(查看名单|查看进度)$/ }))
    panel = await screen.findByRole('dialog', { name: '筛选方案与结果' })
  }
  const trigger = within(panel).getByRole('tab', { name: tab === 'plan' ? '筛选方案' : '筛选结果' })
  if (trigger.getAttribute('aria-selected') !== 'true') await user.click(trigger)
  return panel
}
