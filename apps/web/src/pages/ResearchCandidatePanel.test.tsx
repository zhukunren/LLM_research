import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ObservationPage from './ObservationPage'
import type { ResearchCandidate } from './ResearchCandidatePanel'

const candidate: ResearchCandidate = {
  id: 'candidate', revision: 1, source_kind: 'research_candidate', stock_code: '600519.SH', name: '贵州茅台',
  status: 'watching', note: '核对经营改善', verification: '下一期公告', invalidation: '现金流恶化',
  conversation_id: 'research', source_message_id: 'answer', source_text: '原研究答复：改善仍需验证。', project_id: null,
  scope: { as_of: '2026-09-30' }, as_of: '2026-09-30', source_scope_status: 'frozen', source_scope_revision: 2,
  created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z',
}
const entry = {
  kind: 'candidate', entry_id: 'candidate', candidate_id: 'candidate', run_id: null,
  stock_code: '600519.SH', name: '贵州茅台', status: 'watching', note: '核对经营改善',
  verification: '下一期公告', updated_at: '2026-10-04T00:00:00Z', joined_at: '2026-10-04T00:00:00Z', basis_date: '2026-10-04',
  owner_type: 'research', owner_key: 'inbox', owner_label: '研究收件箱',
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function mockApi(intercept?: (url: URL, init?: RequestInit) => Response | undefined) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const custom = intercept?.(url, init)
    if (custom) return custom
    if (url.pathname.endsWith('/owners')) return json({ items: [{ value: 'inbox', label: '研究收件箱', group: 'research', count: 1 }] })
    if (url.pathname.endsWith('/entries')) return json({ items: [entry], total: 1 })
    if (url.pathname.endsWith('/research-candidates/candidate')) return json(candidate)
    return json({ message: '未处理请求' }, 404)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('统一列表中的研究观察详情', () => {
  it('候选书签直接定位详情，列表分页不能替换指定对象', async () => {
    const other = { ...entry, entry_id: 'other', candidate_id: 'other', stock_code: '600036.SH', name: '招商银行' }
    const fetcher = mockApi(url => url.pathname.endsWith('/entries') ? json({ items: [other], total: 50 }) : undefined)
    const location = vi.fn()
    const view = render(<ObservationPage data={null} initialCandidateId="candidate" initialTab="candidates" onLocationChange={location} />)
    expect(await screen.findByRole('complementary', { name: '观察详情' })).toHaveTextContent('贵州茅台')
    await waitFor(() => expect(screen.getByRole('region', { name: '观察记录列表' })).toHaveTextContent('招商银行'))
    expect(location).not.toHaveBeenCalled()
    view.rerender(<ObservationPage data={null} initialCandidateId="other" initialTab="candidates" onLocationChange={location} />)
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => String(input).endsWith('/research-candidates/other'))).toBe(true))
  })

  it('失效候选书签显示错误，不默默选择首屏公司', async () => {
    mockApi(url => url.pathname.endsWith('/research-candidates/missing') ? json({ message: '找不到研究候选。' }, 404) : undefined)
    render(<ObservationPage data={null} initialCandidateId="missing" initialTab="candidates" />)
    expect(await screen.findByText('找不到研究候选。')).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: '观察详情' })).not.toBeInTheDocument()
  })

  it('编辑验证事项保留原研究来源，并只提交可编辑字段', async () => {
    let saved: unknown
    mockApi((url, init) => {
      if (url.pathname.endsWith('/research-candidates/candidate') && init?.method === 'PATCH') {
        saved = JSON.parse(String(init.body))
        return json({ ...candidate, ...(saved as object), revision: 2 })
      }
    })
    const open = vi.fn(), user = userEvent.setup()
    render(<ObservationPage data={null} onOpenResearch={open} />)
    const list = await screen.findByRole('region', { name: '观察记录列表' })
    await user.click(await within(list).findByRole('button', { name: '查看贵州茅台观察详情' }))
    await screen.findByRole('complementary', { name: '观察详情' })
    await user.click(screen.getByText('研究来源与原答复'))
    expect(screen.getByText(candidate.source_text)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '打开来源研究对话' }))
    expect(open).toHaveBeenCalledWith('research')
    await user.type(screen.getByLabelText('后续验证事项'), '，补充反方公告')
    await user.click(screen.getByRole('button', { name: '保存观察记录' }))
    await screen.findByText('观察记录已保存')
    expect(saved).toMatchObject({ revision: 1, verification: '下一期公告，补充反方公告' })
    expect(saved).not.toHaveProperty('source_text')
  })

  it('保存冲突时保留草稿并允许重新加载', async () => {
    mockApi((_url, init) => init?.method === 'PATCH' ? json({ detail: '观察记录已更新，请重新加载后再保存' }, 409) : undefined)
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    const list = await screen.findByRole('region', { name: '观察记录列表' })
    await user.click(await within(list).findByRole('button', { name: '查看贵州茅台观察详情' }))
    const input = await screen.findByLabelText('观察备注')
    await user.type(input, '新增想法')
    await user.click(screen.getByRole('button', { name: '保存观察记录' }))
    await screen.findByText('观察记录已更新，请重新加载后再保存')
    expect(input).toHaveValue('核对经营改善新增想法')
    expect(screen.getByRole('button', { name: '重新加载较新记录' })).toBeInTheDocument()
  })
})
