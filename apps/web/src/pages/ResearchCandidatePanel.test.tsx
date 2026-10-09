import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ObservationPage from './ObservationPage'
import type { ResearchCandidate } from './ResearchCandidatePanel'

const original: ResearchCandidate = {
  id: 'candidate', revision: 1, source_kind: 'research_candidate', stock_code: '600519.SH', name: '贵州茅台',
  status: 'watching', note: '核对经营改善', verification: '下一期公告', invalidation: '现金流恶化',
  conversation_id: 'research', source_message_id: 'answer', source_text: '原研究答复：改善仍需验证。', project_id: null,
  scope: { as_of: '2026-09-30' }, as_of: '2026-09-30', source_scope_status: 'frozen', source_scope_revision: 2,
  created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z',
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

describe('独立研究候选跟踪', () => {
  it('直接定位非首屏候选，旧会话选择和分页结果不能替换URL指定对象', async () => {
    sessionStorage.setItem('observation.candidate', '"old-candidate"')
    const unrelated = { ...original, id: 'first-page', name: '首屏公司' }
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).endsWith('/research-candidates/candidate') ? json(original) : json({ items: [unrelated], total: 50 }))
    vi.stubGlobal('fetch', fetcher)
    const location = vi.fn()
    const view = render(<ObservationPage data={null} initialCandidateId="candidate" initialTab="candidates" onLocationChange={location} />)
    expect(await screen.findByRole('complementary', { name: '研究候选详情' })).toHaveTextContent('贵州茅台')
    expect(location).toHaveBeenCalledWith('candidates', 'candidate', false)
    const next = { ...original, id: 'next-candidate', name: '第二条公司' }
    fetcher.mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith('/next-candidate') ? json(next) : json({ items: [unrelated], total: 50 }))
    view.rerender(<ObservationPage data={null} initialCandidateId="next-candidate" initialTab="candidates" onLocationChange={location} />)
    await waitFor(() => expect(screen.getByRole('complementary', { name: '研究候选详情' })).toHaveTextContent('第二条公司'))
    expect(location).toHaveBeenLastCalledWith('candidates', 'next-candidate', false)
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it('失效候选书签显示404并保留指定ID，避免默默展示首屏其他公司', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/missing') ? json({ message: '找不到研究候选。' }, 404) : json({ items: [original], total: 1 }))
    vi.stubGlobal('fetch', fetcher)
    const location = vi.fn()
    render(<ObservationPage data={null} initialCandidateId="missing" initialTab="candidates" onLocationChange={location} />)
    expect(await screen.findByText('找不到研究候选。')).toBeInTheDocument()
    await screen.findByRole('region', { name: '研究候选列表' })
    expect(screen.queryByRole('complementary', { name: '研究候选详情' })).not.toBeInTheDocument()
    expect(location).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('observation.candidate')).toBe('"missing"')
  })

  it('打开来源及保存验证事项保留引用且不调用筛选执行', async () => {
    let item = original
    const patches: unknown[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PATCH') { const change = JSON.parse(String(init.body)); patches.push(change); item = { ...item, ...change, revision: item.revision + 1 }; return json(item) }
      if (url.includes('/research-candidates?')) return json({ items: [item], total: 1 })
      return json({}, 404)
    })
    vi.stubGlobal('fetch', fetcher)
    const open = vi.fn(), user = userEvent.setup()
    render(<ObservationPage data={null} onOpenResearch={open} />)
    await screen.findByText('贵州茅台 · 研究候选')
    await user.click(screen.getByText('研究来源与原答复'))
    expect(screen.getByText(original.source_text)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '打开来源研究对话' }))
    expect(open).toHaveBeenCalledWith('research')
    await user.type(screen.getByLabelText('后续验证事项'), '，补充反方公告')
    await user.click(screen.getByRole('button', { name: '候选列表' }))
    await user.click(screen.getByRole('button', { name: '候选详情' }))
    expect(screen.getByLabelText('后续验证事项')).toHaveValue('下一期公告，补充反方公告')
    expect(patches).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '保存研究观察' }))
    await screen.findByText('研究观察记录已保存')
    expect(patches[0]).toMatchObject({ revision: 1, verification: '下一期公告，补充反方公告' })
    expect(patches[0]).not.toHaveProperty('source_text')
    expect(fetcher.mock.calls.every(([input]) => !String(input).includes('/runs'))).toBe(true)
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true)
  })

  it('来源日期和未知范围在展开原答复前可见', async () => {
    const legacy = { ...original, as_of: null, source_scope_status: 'unknown', source_scope_revision: null }
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [legacy], total: 1 })))
    render(<ObservationPage data={null} />)
    await screen.findByRole('complementary', { name: '研究候选详情' })
    const sourceWarning = screen.getByText(/来源未记录截止日.*旧来源的研究范围未知/)
    expect(sourceWarning).toBeVisible()
    expect(sourceWarning.closest('details')).toBeNull()
    expect(screen.queryByText('RESEARCH WATCHLIST')).not.toBeInTheDocument()
    expect(screen.queryByText('下一步验证')).not.toBeInTheDocument()
    expect(screen.getByLabelText('失效条件')).toHaveValue('现金流恶化')
  })

  it('较旧revision保存冲突时保留草稿并提示重新加载', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'PATCH' ? json({ detail: '观察记录已更新，请重新加载后再保存' }, 409) : json({ items: [original], total: 1 })))
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    const input = await screen.findByLabelText('研究候选备注')
    await user.type(input, '新增想法')
    await user.click(screen.getByRole('button', { name: '保存研究观察' }))
    await screen.findByText('观察记录已更新，请重新加载后再保存')
    expect(input).toHaveValue('核对经营改善新增想法')
    expect(screen.getByRole('button', { name: '保存研究观察' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重新加载较新记录' })).toBeInTheDocument()
  })

  it('研究候选搜索与状态作为分页API参数', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => json({ items: [], total: 0 }))
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    await screen.findByText('还没有研究候选')
    await user.type(screen.getByLabelText('搜索研究候选'), '现金流')
    await user.selectOptions(screen.getByLabelText('研究候选状态筛选'), 'priority')
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => String(input).includes('status=priority') && decodeURIComponent(String(input)).includes('query=现金流'))).toBe(true))
  })

  it('重点候选排序与详情一致，切换候选后仍可继续未保存的验证草稿', async () => {
    const priority: ResearchCandidate = { ...original, id: 'priority', name: '重点公司', stock_code: '000001.SZ', status: 'priority', note: '重点验证' }
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [priority, original], total: 2 })))
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    await screen.findByText('重点公司 · 研究候选')
    const table = within(screen.getByRole('region', { name: '研究候选列表' })).getByRole('table')
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('重点公司')
    await user.click(within(table).getByRole('button', { name: /贵州茅台/ }))
    await user.type(screen.getByLabelText('后续验证事项'), '，补充渠道验证')
    await user.click(within(table).getByRole('button', { name: /重点公司/ }))
    await user.click(within(table).getByRole('button', { name: /贵州茅台/ }))
    expect(screen.getByLabelText('后续验证事项')).toHaveValue('下一期公告，补充渠道验证')
    await user.click(screen.getByRole('button', { name: '恢复已保存记录' }))
    expect(screen.getByLabelText('后续验证事项')).toHaveValue('下一期公告')
    expect(screen.getByRole('button', { name: '保存研究观察' })).toBeDisabled()
  })

  it('筛选中的候选改变状态保存后重新取数并更新匹配结果', async () => {
    let item: ResearchCandidate = { ...original, status: 'priority' }
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') { item = { ...item, ...JSON.parse(String(init.body)), revision: item.revision + 1 }; return json(item) }
      const selectedStatus = new URL(String(input), 'http://localhost').searchParams.get('status')
      const items = !selectedStatus || selectedStatus === item.status ? [item] : []
      return json({ items, total: items.length })
    })
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    await screen.findByText('贵州茅台 · 研究候选')
    await user.selectOptions(screen.getByLabelText('研究候选状态筛选'), 'priority')
    await screen.findByLabelText('研究候选观察状态')
    await user.selectOptions(screen.getByLabelText('研究候选观察状态'), 'ended')
    await user.click(screen.getByRole('button', { name: '保存研究观察' }))
    await screen.findByText('没有匹配的研究候选')
    expect(screen.queryByRole('region', { name: '研究候选列表' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '显示全部研究候选' }))
    await screen.findByText('贵州茅台 · 研究候选')
    expect(screen.getByLabelText('研究候选观察状态')).toHaveValue('ended')
  })
})
