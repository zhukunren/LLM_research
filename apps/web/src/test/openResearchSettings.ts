import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

export async function openResearchSettings(user = userEvent.setup()) {
  const button = await screen.findByRole('button', { name: '研究设置' })
  if (button.getAttribute('aria-expanded') !== 'true') await user.click(button)
}
