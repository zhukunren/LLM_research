import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ResearchStarters from './ResearchStarters'

const items = [{ label: '公司比较', description: '经营 · 估值 · 差异', prompt: '核对两家公司的实际经营和风险。' }]
it('keeps the full question in the action and supports repeated keyboard selection', async () => {
  const onSelect = vi.fn(), user = userEvent.setup()
  render(<ResearchStarters items={items} disabled={false} onSelect={onSelect} />)
  const button = screen.getByRole('button', { name: '公司比较' })
  expect(button).toHaveAttribute('title', `填入问题：${items[0].prompt}`)
  expect(screen.queryByText(items[0].prompt)).not.toBeInTheDocument()
  button.focus()
  await user.keyboard('{Enter}{Enter}')
  expect(onSelect).toHaveBeenCalledTimes(2)
  expect(onSelect).toHaveBeenLastCalledWith(items[0].prompt)
})
it('keeps starter actions disabled while the conversation is unavailable', async () => {
  const onSelect = vi.fn()
  render(<ResearchStarters items={items} disabled onSelect={onSelect} />)
  await userEvent.click(screen.getByRole('button', { name: '公司比较' }))
  expect(onSelect).not.toHaveBeenCalled()
})
