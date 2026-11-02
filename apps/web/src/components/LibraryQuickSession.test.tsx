import { act, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import LibraryQuickSession, { type LibraryQuickEntry } from './LibraryQuickSession'
const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0, finish: null as null | (() => void) }))
vi.mock('./conversation/ConversationWorkspace', async () => {
  const { useEffect, useState } = await import('react')
  return { default: () => {
    const [uploading, setUploading] = useState(false), [draft, setDraft] = useState('未发送')
    useEffect(() => { lifecycle.mounts++; return () => { lifecycle.unmounts++ } }, [])
    return <><input aria-label="测试草稿" value={draft} onChange={event => setDraft(event.target.value)} /><button onClick={() => { setUploading(true); lifecycle.finish = () => setUploading(false) }}>模拟进行中上传</button><p>{uploading ? '正在上传' : '上传空闲'}</p></>
  } }
})
const entry: LibraryQuickEntry = { id: 'source-session', scope: 'report', workflow: 'research', prompt: '', conversationId: 'same-conversation', source: { label: '来源页', reference: { kind: 'report_page', source_id: 'report', page_number: 3 } } }
function Harness() {
  const [expanded, setExpanded] = useState(false), [open, setOpen] = useState(true)
  return <><button onClick={() => setOpen(true)}>重开资料助手</button><LibraryQuickSession entry={entry} open={open} expanded={expanded} onExpand={() => setExpanded(true)} onClose={() => { setOpen(false); setExpanded(false) }} onChange={() => {}} data={null} /></>
}
it('preserves pending child work across expand, return and reopen without a remount', async () => {
  const user = userEvent.setup()
  render(<Harness />)
  const input = await screen.findByLabelText('测试草稿')
  await user.type(input, '持续输入')
  await user.click(screen.getByRole('button', { name: '模拟进行中上传' }))
  await user.click(screen.getByRole('button', { name: '展开研究' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '返回资料' })).toHaveFocus())
  expect(screen.getByLabelText('测试草稿')).toBe(input)
  expect(screen.getByText('正在上传')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '返回资料' }))
  await act(async () => lifecycle.finish?.())
  await user.click(screen.getByRole('button', { name: '重开资料助手' }))
  expect(screen.getByLabelText('测试草稿')).toBe(input)
  expect(input).toHaveValue('未发送持续输入')
  expect(screen.getByText('上传空闲')).toBeInTheDocument()
  expect(lifecycle.mounts).toBe(1)
  expect(lifecycle.unmounts).toBe(0)
})
