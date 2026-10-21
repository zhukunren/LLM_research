import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import QmtScriptsPage from './QmtScriptsPage'

it('opens a QMT built-in Python draft with the selected use and encoding', async () => {
  const user = userEvent.setup(), onOpenDraft = vi.fn()
  render(<QmtScriptsPage onOpenDraft={onOpenDraft} />)
  expect(screen.getByRole('button', { name: '带入生成对话' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '均线交叉' }))
  expect(onOpenDraft).not.toHaveBeenCalled()
  await user.selectOptions(screen.getByLabelText('脚本用途'), 'backtest')
  await user.selectOptions(screen.getByLabelText('文件编码'), 'utf-8')
  await user.click(screen.getByRole('button', { name: '带入生成对话' }))
  const prompt = onOpenDraft.mock.calls[0][0]
  expect(prompt).toContain('QMT 客户端内置 Python')
  expect(prompt).toContain('回测策略，实盘默认关闭')
  expect(prompt).toContain('UTF-8')
  expect(prompt).toContain('5 日均线上穿 20 日均线')
  expect(prompt).toContain('export_qmt_script')
  expect(prompt).toContain('请先查阅项目已接入的 QMT 策略编写手册')
})

it('keeps the requirement and settings when returning to the tool', async () => {
  const user = userEvent.setup(), onOpenDraft = vi.fn()
  const view = render(<QmtScriptsPage onOpenDraft={onOpenDraft} />)
  await user.type(screen.getByLabelText('策略需求'), '输出突破信号，不下单')
  await user.selectOptions(screen.getByLabelText('脚本用途'), 'trading')
  view.unmount()
  render(<QmtScriptsPage onOpenDraft={onOpenDraft} />)
  expect(screen.getByLabelText('策略需求')).toHaveValue('输出突破信号，不下单')
  expect(screen.getByLabelText('脚本用途')).toHaveValue('trading')
  await user.click(screen.getByRole('button', { name: '带入生成对话' }))
  expect(onOpenDraft.mock.calls[0][0]).toContain('实盘开关默认关闭，账号留空')
})
