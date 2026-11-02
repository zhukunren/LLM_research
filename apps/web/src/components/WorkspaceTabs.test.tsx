import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import WorkspaceTabs from './WorkspaceTabs'
import type { WorkspaceTab } from '../workspaceTabs'

const tabs: WorkspaceTab[] = [
  { id: 'research', route: { page: 'screening', newDraft: true }, title: '新研究' },
  { id: 'reports', route: { page: 'reports' }, title: '研报库' },
  { id: 'qmt', route: { page: 'qmt' }, title: 'QMT 脚本生成' },
]
function setup(items = tabs) {
  const actions = { onActivate: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseSide: vi.fn(), onCloseAll: vi.fn(), canReopen: false, onReopen: vi.fn(), onMove: vi.fn(), onNew: vi.fn() }
  const view = render(<WorkspaceTabs tabs={items} activeId="research" {...actions} />)
  return { ...actions, ...view }
}

function dragEvent(target: HTMLElement, type: string, clientX = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX, clientY: 20, dataTransfer: { setData: vi.fn(), effectAllowed: '', dropEffect: '' } })
  fireEvent(target, event)
}

it('opens a menu on an inactive tab and closes that tab without selecting it', async () => {
  const actions = setup(), user = userEvent.setup()
  await user.pointer({ target: screen.getByRole('tab', { name: '研报库' }), keys: '[MouseRight]' })
  expect(screen.getByRole('menu', { name: '标签页操作' })).toBeInTheDocument()
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['关闭当前标签', '关闭其他标签', '关闭左侧标签', '关闭右侧标签', '关闭全部标签', '重新打开关闭的标签'])
  expect(screen.getByRole('tab', { name: '新研究' })).toHaveAttribute('aria-selected', 'true')
  expect(actions.onActivate).not.toHaveBeenCalled()
  await user.click(screen.getByRole('menuitem', { name: '关闭当前标签' }))
  expect(actions.onClose).toHaveBeenCalledExactlyOnceWith('reports')
  expect(actions.onCloseOthers).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('closes other tabs relative to the right-clicked tab and exposes close all', async () => {
  const actions = setup(), user = userEvent.setup()
  fireEvent.contextMenu(screen.getByRole('tab', { name: '研报库' }), { clientX: 250, clientY: 60 })
  await user.click(screen.getByRole('menuitem', { name: '关闭其他标签' }))
  expect(actions.onCloseOthers).toHaveBeenCalledExactlyOnceWith('reports')
  fireEvent.contextMenu(screen.getByRole('tab', { name: '新研究' }))
  await user.click(screen.getByRole('menuitem', { name: '关闭全部标签' }))
  expect(actions.onCloseAll).toHaveBeenCalledExactlyOnceWith()
  expect(actions.onActivate).not.toHaveBeenCalled()
})

it('disables close others for a single tab while keeping close current and close all usable', async () => {
  const actions = setup(tabs.slice(0, 1)), user = userEvent.setup()
  fireEvent.contextMenu(screen.getByRole('tab'))
  expect(screen.getByRole('menuitem', { name: '关闭其他标签' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '关闭左侧标签' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '关闭右侧标签' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '重新打开关闭的标签' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '关闭当前标签' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '关闭全部标签' })).toBeEnabled()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('menuitem', { name: '关闭全部标签' })).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(actions.onCloseAll).toHaveBeenCalledOnce()
})

it('supports keyboard opening, menu navigation and Escape focus restoration', async () => {
  const actions = setup(), user = userEvent.setup(), target = screen.getByRole('tab', { name: '研报库' })
  target.focus()
  await user.keyboard('{Shift>}{F10}{/Shift}')
  expect(screen.getByRole('menuitem', { name: '关闭当前标签' })).toHaveFocus()
  await user.keyboard('{End}')
  expect(screen.getByRole('menuitem', { name: '关闭全部标签' })).toHaveFocus()
  await user.keyboard('{Home}{ArrowDown}')
  expect(screen.getByRole('menuitem', { name: '关闭其他标签' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(target).toHaveFocus()
  expect(actions.onActivate).not.toHaveBeenCalled()
})

it('dismisses on outside interaction, scrolling and when the target tab disappears', async () => {
  const actions = setup(), user = userEvent.setup()
  fireEvent.contextMenu(screen.getByRole('tab', { name: '研报库' }))
  await user.click(screen.getByRole('button', { name: '新建研究标签' }))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(actions.onNew).toHaveBeenCalledOnce()
  fireEvent.contextMenu(screen.getByRole('tab', { name: '研报库' }))
  fireEvent.scroll(screen.getByRole('tablist'))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  fireEvent.contextMenu(screen.getByRole('tab', { name: '研报库' }))
  actions.rerender(<WorkspaceTabs tabs={tabs.slice(0, 1)} activeId="research" {...actions} />)
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
})

it('shows a drop marker and commits the tab move only on drop without activating or closing a tab', () => {
  const actions = setup(), source = screen.getByRole('tab', { name: '研报库' }), target = screen.getByRole('tab', { name: 'QMT 脚本生成' })
  dragEvent(source, 'dragstart', 10)
  dragEvent(target, 'dragover', 20)
  expect(target.closest('.workspace-tab-item')).toHaveAttribute('data-drop', 'after')
  expect(source.closest('.workspace-tab-item')).toHaveAttribute('data-dragging', 'true')
  expect(actions.onMove).not.toHaveBeenCalled()
  dragEvent(target, 'drop', 20)
  expect(actions.onMove).toHaveBeenCalledExactlyOnceWith('reports', 'qmt', 'after')
  expect(actions.onActivate).not.toHaveBeenCalled()
  expect(actions.onClose).not.toHaveBeenCalled()
  expect(source.closest('.workspace-tab-item')).not.toHaveAttribute('data-dragging')
  expect(target.closest('.workspace-tab-item')).not.toHaveAttribute('data-drop')
})

it('cancels a drag without moving tabs and ignores external drops', () => {
  const actions = setup(), source = screen.getByRole('tab', { name: '研报库' }), target = screen.getByRole('tab', { name: 'QMT 脚本生成' })
  dragEvent(target, 'drop', 20)
  expect(actions.onMove).not.toHaveBeenCalled()
  dragEvent(source, 'dragstart')
  dragEvent(target, 'dragover', 20)
  dragEvent(source, 'dragend')
  expect(actions.onMove).not.toHaveBeenCalled()
  expect(target.closest('.workspace-tab-item')).not.toHaveAttribute('data-drop')
})

it('dismisses the context menu when dragging starts and keeps the close button separate from the drag handle', () => {
  setup()
  const source = screen.getByRole('tab', { name: '研报库' })
  fireEvent.contextMenu(source)
  dragEvent(source, 'dragstart')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(source).toHaveAttribute('draggable', 'true')
  expect(screen.getByRole('button', { name: '关闭标签：研报库' })).not.toHaveAttribute('draggable', 'true')
  dragEvent(source, 'dragend')
})

it('supports keyboard reordering without changing the active tab', async () => {
  const actions = setup(), user = userEvent.setup(), source = screen.getByRole('tab', { name: '研报库' })
  source.focus()
  await user.keyboard('{Control>}{Shift>}{ArrowLeft}{/Shift}{/Control}')
  expect(actions.onMove).toHaveBeenCalledExactlyOnceWith('reports', 'research', 'before')
  expect(actions.onActivate).not.toHaveBeenCalled()
})

it.each([['关闭左侧标签', 'left'], ['关闭右侧标签', 'right']])('targets the right-clicked tab for %s without selecting it', async (label, side) => {
  const actions = setup(), user = userEvent.setup()
  fireEvent.contextMenu(screen.getByRole('tab', { name: '研报库' }))
  await user.click(screen.getByRole('menuitem', { name: label }))
  expect(actions.onCloseSide).toHaveBeenCalledExactlyOnceWith('reports', side)
  expect(actions.onActivate).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('disables side-closing at the boundaries and follows the current reordered positions', () => {
  const actions = setup()
  fireEvent.contextMenu(screen.getByRole('tab', { name: '新研究' }))
  expect(screen.getByRole('menuitem', { name: '关闭左侧标签' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '关闭右侧标签' })).toBeEnabled()
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'QMT 脚本生成' }))
  expect(screen.getByRole('menuitem', { name: '关闭左侧标签' })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: '关闭右侧标签' })).toBeDisabled()
  actions.rerender(<WorkspaceTabs tabs={[tabs[2], tabs[0], tabs[1]]} activeId="research" {...actions} />)
  expect(screen.getByRole('menuitem', { name: '关闭左侧标签' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '关闭右侧标签' })).toBeEnabled()
})

it('offers reopening when closed history is available and dismisses the menu after reopening', async () => {
  const actions = setup(), user = userEvent.setup()
  actions.rerender(<WorkspaceTabs tabs={tabs} activeId="research" {...actions} canReopen />)
  fireEvent.contextMenu(screen.getByRole('tab', { name: '研报库' }))
  expect(screen.getByRole('menuitem', { name: '重新打开关闭的标签' })).toBeEnabled()
  await user.keyboard('{End}{Enter}')
  expect(actions.onReopen).toHaveBeenCalledExactlyOnceWith()
  expect(actions.onActivate).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('lists complete titles and workflow types and restores focus when dismissed', async () => {
  const title = '很长的完整选股工作区标题，不应只在提示里显示'
  const actions = setup([...tabs, { id: 'selection', route: { page: 'conditions', view: 'conversation' }, title }]), user = userEvent.setup()
  const trigger = screen.getByRole('button', { name: '已打开工作区（4）' })
  await user.click(trigger)
  expect(screen.getByRole('menu', { name: '已打开工作区' })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: `选股 ${title}` })).toHaveTextContent(title)
  await user.keyboard('{Escape}')
  expect(trigger).toHaveFocus()
  await user.click(trigger)
  await user.click(trigger)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  await user.click(trigger)
  await user.click(screen.getByRole('menuitem', { name: `选股 ${title}` }))
  expect(actions.onActivate).toHaveBeenCalledWith('selection')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('labels new tabs with the current workflow and ignores composing tab shortcuts', () => {
  const actions = setup()
  actions.rerender(<WorkspaceTabs tabs={tabs} activeId="research" {...actions} newWorkflow="screening" />)
  fireEvent.click(screen.getByRole('button', { name: '新建选股标签' }))
  expect(actions.onNew).toHaveBeenCalledOnce()
  fireEvent.keyDown(screen.getByRole('tab', { name: '新研究' }), { key: 'ArrowRight', isComposing: true })
  expect(actions.onActivate).not.toHaveBeenCalled()
})

it('keeps a newly opened menu through background layout refreshes but closes on viewport resize', () => {
  setup()
  fireEvent.contextMenu(screen.getByRole('tab', { name: '新研究' }))
  fireEvent(window, new Event('resize'))
  expect(screen.getByRole('menu', { name: '标签页操作' })).toBeInTheDocument()
  const width = window.innerWidth
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width - 100 })
  fireEvent(window, new Event('resize'))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
})
