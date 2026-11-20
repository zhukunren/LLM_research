import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ResearchConversationTools from './ResearchConversationTools'

afterEach(() => document.getElementById('test-research-tools-slot')?.remove())

it('portals the result control into the header and keeps the drawer relationship and focus ref', () => {
  const target = document.createElement('div')
  target.id = 'test-research-tools-slot'
  document.body.appendChild(target)
  const onToggleResults = vi.fn(), resultsToggleRef = createRef<HTMLButtonElement>()
  const props = { resultsToggleRef, onToggleResults, portalTargetId: target.id }
  const view = render(<ResearchConversationTools {...props} resultsOpen={false} />)
  const button = screen.getByRole('button', { name: '成果与文件' })
  expect(target).toContainElement(button)
  expect(resultsToggleRef.current).toBe(button)
  expect(button).toHaveAttribute('aria-controls', 'research-results-drawer')
  expect(button).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(button)
  expect(onToggleResults).toHaveBeenCalledOnce()
  view.rerender(<ResearchConversationTools {...props} resultsOpen />)
  expect(button).toHaveAttribute('aria-expanded', 'true')
})

it('moves to a late header slot and falls back inline if the slot is removed', async () => {
  const target = document.createElement('div')
  target.id = 'test-research-tools-slot'
  const { container } = render(<ResearchConversationTools resultsOpen={false} resultsToggleRef={createRef()}
    onToggleResults={vi.fn()} portalTargetId={target.id} />)
  expect(container).toContainElement(screen.getByRole('button', { name: '成果与文件' }))
  await act(async () => { document.body.appendChild(target) })
  expect(target).toContainElement(screen.getByRole('button', { name: '成果与文件' }))
  await act(async () => { target.remove() })
  expect(container).toContainElement(screen.getByRole('button', { name: '成果与文件' }))
})
