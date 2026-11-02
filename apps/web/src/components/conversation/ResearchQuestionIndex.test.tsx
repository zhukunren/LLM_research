import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ResearchQuestionIndex from './ResearchQuestionIndex'
const messages = Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, role: 'user', content: `问题 ${i}` }))
it('keeps short conversations uncluttered and indexes long conversations by stable message ids', async () => {
  const jump = vi.fn(), user = userEvent.setup()
  const view = render(<ResearchQuestionIndex messages={messages.slice(0, 1)} onJump={jump} />)
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  view.rerender(<ResearchQuestionIndex messages={messages} onJump={jump} />)
  await user.click(screen.getByText('问题索引 · 4'))
  await user.click(screen.getByRole('button', { name: '2. 问题 1' }))
  expect(jump).toHaveBeenLastCalledWith('q1')
  await user.selectOptions(screen.getByLabelText('定位研究问题'), 'q3')
  expect(jump).toHaveBeenLastCalledWith('q3')
})
it('uses display content and never lists answer versions as questions', () => {
  render(<ResearchQuestionIndex messages={[...messages, { id: 'answer', role: 'assistant', content: 'answer' }, { id: 'special', role: 'user', content: 'internal', display_content: '<b>可见问题</b>' }]} onJump={vi.fn()} />)
  expect(screen.getByRole('option', { name: '5. <b>可见问题</b>' })).toHaveValue('special')
  expect(screen.queryByText('internal')).not.toBeInTheDocument()
})
