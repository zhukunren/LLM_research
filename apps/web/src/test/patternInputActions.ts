import { screen, within } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'

export const patternInputActions = ['截取行情区间', '上传截图', '描述目标走势', '绘制新形态'] as const
export type PatternInputAction = typeof patternInputActions[number]

/** Exercise the public action entry points, never the retired source tabs. */
export async function choosePatternInput(user: ReturnType<typeof userEvent.setup>, name: PatternInputAction) {
  const starter = screen.queryByRole('button', { name })
  if (starter) {
    await user.click(starter)
    return
  }
  const trigger = screen.queryByRole('button', { name: '替换目标' }) ?? screen.getByRole('button', { name: '创建目标' })
  if (trigger.getAttribute('aria-expanded') !== 'true') await user.click(trigger)
  await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name }))
}
