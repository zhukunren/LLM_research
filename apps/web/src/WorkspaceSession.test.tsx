import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { expect, it } from 'vitest'
import { WorkspaceSessionPane } from './WorkspaceSession'
import type { WorkspaceTab } from './workspaceTabs'
import WorkspacePageHeading from './components/WorkspacePageHeading'
import ConditionWorkspaceDrawer from './components/ConditionWorkspaceDrawer'

it('restores nested reading positions even when the browser clears detached scroll offsets', async () => {
  const tab: WorkspaceTab = { id: 'one', route: { page: 'screening', newDraft: true }, title: '新研究' }
  const pane = (active: boolean) => <WorkspaceSessionPane tab={tab} active={active} onTitle={() => {}}><div data-testid="reader"><textarea aria-label="draft" defaultValue="原草稿" /></div></WorkspaceSessionPane>
  const view = render(pane(true))
  const reader = screen.getByTestId('reader'), draft = screen.getByLabelText('draft')
  fireEvent.scroll(reader, { target: { scrollTop: 180, scrollLeft: 24 } })
  view.rerender(pane(false))
  expect(screen.queryByLabelText('draft')).not.toBeInTheDocument()
  reader.scrollTop = 0
  reader.scrollLeft = 0
  view.rerender(pane(true))
  await waitFor(() => expect(reader.scrollTop).toBe(180))
  expect(reader.scrollLeft).toBe(24)
  expect(screen.getByLabelText('draft')).toBe(draft)
  expect(draft).toHaveValue('原草稿')
})

it('shows only active-page actions in the shared toolbar and retains each page state', () => {
  const target = document.createElement('div')
  document.body.append(target)
  const calls: string[] = []
  function Page({ name }: { name: string }) {
    const [draft, setDraft] = useState('')
    return <><WorkspacePageHeading actions={<button onClick={() => calls.push(`${name}:${draft}`)}>操作{name}</button>}><h1>{name}</h1></WorkspacePageHeading><input aria-label={`草稿${name}`} value={draft} onChange={event => setDraft(event.target.value)} /></>
  }
  const content = (active: string) => <>{['one', 'two'].map(id => <WorkspaceSessionPane key={id} tab={{ id, route: { page: 'news' }, title: id }} active={active === id} actionsTarget={target} onTitle={() => {}}><Page name={id} /></WorkspaceSessionPane>)}</>
  const view = render(content('one'))
  fireEvent.change(screen.getByLabelText('草稿one'), { target: { value: '保留当前资料' } })
  fireEvent.click(within(target).getByRole('button', { name: '操作one' }))
  view.rerender(content('two'))
  expect(within(target).queryByRole('button', { name: '操作one' })).not.toBeInTheDocument()
  fireEvent.click(within(target).getByRole('button', { name: '操作two' }))
  view.rerender(content('one'))
  expect(screen.getByLabelText('草稿one')).toHaveValue('保留当前资料')
  expect(within(target).getAllByRole('button')).toHaveLength(1)
  expect(calls).toEqual(['one:保留当前资料', 'two:'])
  view.unmount(); expect(target).toBeEmptyDOMElement(); target.remove()
})

it('removes a condition drawer from inactive workspaces and restores its unfinished draft on return', () => {
  const tab: WorkspaceTab = { id: 'conditions', route: { page: 'conditions', view: 'library' }, title: '条件库' }
  const originalOverflow = document.body.style.overflow
  const content = (active: boolean) => <WorkspaceSessionPane tab={tab} active={active} onTitle={() => {}}>
    <ConditionWorkspaceDrawer title="新增条件" onClose={() => {}}><textarea aria-label="条件描述" defaultValue="" /></ConditionWorkspaceDrawer>
  </WorkspaceSessionPane>
  const view = render(content(true))
  const draft = screen.getByLabelText('条件描述')
  fireEvent.change(draft, { target: { value: '保留尚未提交的条件' } })
  expect(document.body.style.overflow).toBe('hidden')
  view.rerender(content(false))
  expect(screen.queryByRole('dialog', { name: '新增条件' })).not.toBeInTheDocument()
  expect(document.body.style.overflow).toBe(originalOverflow)
  view.rerender(content(true))
  expect(screen.getByRole('dialog', { name: '新增条件' })).toBeInTheDocument()
  expect(screen.getByLabelText('条件描述')).toBe(draft)
  expect(draft).toHaveValue('保留尚未提交的条件')
  expect(screen.getByRole('button', { name: '关闭条件详情' })).toHaveFocus()
  view.unmount()
  expect(document.body.style.overflow).toBe(originalOverflow)
})
