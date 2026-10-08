import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../api'
import ResearchConversationTools from './ResearchConversationTools'

vi.mock('../../api', () => ({ api: vi.fn() }))
const base = {
  conversationId: 'research-one', projectId: null, disabled: false, hasResults: false, resultsOpen: false,
  onToggleResults: vi.fn(), onProjectChange: vi.fn(), onError: vi.fn(),
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue({ items: [{ id: 'project-one', name: '产业研究', status: 'active' }] })
})
afterEach(() => document.getElementById('test-research-tools-slot')?.remove())

it('portals the result controls into the header and keeps the drawer relationship and focus ref', async () => {
  const target = document.createElement('div')
  target.id = 'test-research-tools-slot'; document.body.appendChild(target)
  const onToggleResults = vi.fn(), resultsToggleRef = createRef<HTMLButtonElement>()
  const view = render(<ResearchConversationTools {...base} hasResults resultsToggleRef={resultsToggleRef}
    onToggleResults={onToggleResults} portalTargetId={target.id} />)
  const button = screen.getByRole('button', { name: '成果与文件' })
  expect(target).toContainElement(button)
  expect(target).toContainElement(screen.getByRole('button', { name: '研究对话选项' }))
  expect(resultsToggleRef.current).toBe(button)
  expect(button).toHaveAttribute('aria-controls', 'research-results-drawer')
  expect(button).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(button)
  expect(onToggleResults).toHaveBeenCalledTimes(1)
  view.rerender(<ResearchConversationTools {...base} hasResults resultsOpen resultsToggleRef={resultsToggleRef}
    onToggleResults={onToggleResults} portalTargetId={target.id} />)
  expect(button).toHaveAttribute('aria-expanded', 'true')
  expect(api).not.toHaveBeenCalled()
})

it('works inline without a slot and opens project membership only on demand', async () => {
  const user = userEvent.setup()
  const { container } = render(<ResearchConversationTools {...base} resultsToggleRef={createRef()} portalTargetId="missing-slot" />)
  const trigger = screen.getByRole('button', { name: '研究对话选项' })
  expect(container).toContainElement(trigger)
  expect(screen.queryByRole('button', { name: '成果与文件' })).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox', { name: '所属研究项目' })).not.toBeInTheDocument()
  expect(api).not.toHaveBeenCalled()
  await user.click(trigger)
  const dialog = screen.getByRole('dialog', { name: '项目归属' })
  expect(trigger).toHaveAttribute('aria-controls', dialog.id)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(await within(dialog).findByRole('option', { name: '产业研究' })).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: '所属研究项目' })).toHaveFocus()
})

it('closes on Escape and outside interaction, restores focus, and closes before showing results', async () => {
  const user = userEvent.setup(), onToggleResults = vi.fn()
  render(<ResearchConversationTools {...base} hasResults resultsToggleRef={createRef()} onToggleResults={onToggleResults} />)
  const trigger = screen.getByRole('button', { name: '研究对话选项' })
  trigger.focus()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('dialog', { name: '项目归属' })).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
  await user.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
  await user.click(trigger)
  await user.click(screen.getByRole('button', { name: '成果与文件' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(onToggleResults).toHaveBeenCalledTimes(1)
})

it('retains confirmed membership on a failed save and reports a successful change only after acceptance', async () => {
  let reject = true
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/research-projects') return { items: [{ id: 'project-one', name: '产业研究', status: 'active' }] } as never
    expect(path).toBe('/conversations/research-one/project')
    expect(JSON.parse(String(init?.body))).toEqual({ project_id: 'project-one' })
    if (reject) throw new Error('项目暂时无法修改')
    return {} as never
  })
  const user = userEvent.setup(), onError = vi.fn(), onProjectChange = vi.fn()
  render(<ResearchConversationTools {...base} resultsToggleRef={createRef()} onError={onError} onProjectChange={onProjectChange} />)
  await user.click(screen.getByRole('button', { name: '研究对话选项' }))
  await screen.findByRole('option', { name: '产业研究' })
  const select = screen.getByRole('combobox', { name: '所属研究项目' })
  await user.selectOptions(select, 'project-one')
  await waitFor(() => expect(onError).toHaveBeenCalledWith('项目暂时无法修改'))
  expect(onProjectChange).not.toHaveBeenCalled()
  expect(select).toHaveValue('')
  reject = false
  await user.selectOptions(select, 'project-one')
  await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith('project-one'))
})

it('locks project changes when disabled but allows viewing the current project', async () => {
  const user = userEvent.setup(), onProjectChange = vi.fn(), onOpenProject = vi.fn()
  render(<ResearchConversationTools {...base} projectId="project-one" disabled resultsToggleRef={createRef()}
    onProjectChange={onProjectChange} onOpenProject={onOpenProject} />)
  await user.click(screen.getByRole('button', { name: '研究对话选项' }))
  expect(screen.getByRole('combobox', { name: '所属研究项目' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '查看项目' }))
  expect(onOpenProject).toHaveBeenCalledWith('project-one')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(onProjectChange).not.toHaveBeenCalled()
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true)
})

it('moves to a late header slot and falls back inline if the slot is removed', async () => {
  const { container } = render(<ResearchConversationTools {...base} resultsToggleRef={createRef()} portalTargetId="test-research-tools-slot" />)
  const target = document.createElement('div')
  target.id = 'test-research-tools-slot'
  await act(async () => { document.body.appendChild(target) })
  expect(target).toContainElement(screen.getByRole('button', { name: '研究对话选项' }))
  await act(async () => { target.remove() })
  expect(container).toContainElement(screen.getByRole('button', { name: '研究对话选项' }))
})

it('closes an open options panel when the conversation changes', async () => {
  const user = userEvent.setup(), resultsToggleRef = createRef<HTMLButtonElement>()
  const view = render(<ResearchConversationTools {...base} resultsToggleRef={resultsToggleRef} />)
  await user.click(screen.getByRole('button', { name: '研究对话选项' }))
  expect(screen.getByRole('dialog', { name: '项目归属' })).toBeInTheDocument()
  view.rerender(<ResearchConversationTools {...base} conversationId="research-two" resultsToggleRef={resultsToggleRef} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '研究对话选项' })).toHaveAttribute('aria-expanded', 'false')
})
