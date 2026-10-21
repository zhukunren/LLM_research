import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { expect, it } from 'vitest'
import { WorkspaceSessionPane } from './WorkspaceSession'
import type { WorkspaceTab } from './workspaceTabs'
import WorkspacePageHeading from './components/WorkspacePageHeading'

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
