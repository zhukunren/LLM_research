import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import { TaskLogic } from './TaskBrief'
import type { Conversation, SavedScreeningTask, ScreeningTaskRevision } from '../../api'

const task: ScreeningTaskRevision = {
  task_id: 'one', revision: 1, original_user_messages: ['收盘价高于20日均线'],
  conditions: [{ condition_id: 'trend', library: 'technical', description: '收盘价高于20日均线', source_quote: '收盘价高于20日均线', expression: {} }],
  references: [{ reference_id: 'trend-ref', condition_id: 'trend', parameter_overrides: {} }],
  logic_tree: { op: 'condition', reference_id: 'trend-ref' },
  scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: '2026-09-14', report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null },
  unresolved: [],
}
const saved: SavedScreeningTask = { id: 'saved-1', name: '趋势跟踪', version: 2, task, created_at: '2026-09-28T08:00:00Z' }
const makeConversation = (id: string, revision = 1): Conversation => ({
  id, task_id: id, entry_scope: 'screening', task_revision: revision, active_run_id: null, pending_execution: false, state: 'active',
  messages: [{ id: `${id}-message`, role: 'user', content: `需求${id}`, source_refs: [], created_at: saved.created_at }], turns: [], created_at: saved.created_at, updated_at: saved.created_at,
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function mockApi(intercept?: (url: URL, method: string, body: Record<string, unknown>) => Response | undefined) {
  const conversations = [makeConversation('one'), makeConversation('two')]
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    const result = intercept?.(url, method, init?.body ? JSON.parse(String(init.body)) : {})
    if (result) return result
    if (url.pathname === '/api/v1/conversations' && method === 'GET') return json({ items: conversations.map(item => ({ ...item, title: `需求${item.id}` })) })
    if (url.pathname.endsWith('/revisions/1')) return json(task)
    if (url.pathname.endsWith('/screening-runs')) return json({ items: [] })
    if (url.pathname === '/api/v1/saved-screening-tasks') return json({ items: [saved] })
    const current = conversations.find(item => url.pathname === `/api/v1/conversations/${item.id}`)
    if (current) return json(current)
    return json({ message: `Unhandled ${method} ${url.pathname}` }, 404)
  })
  vi.stubGlobal('fetch', fetcher)
  let nextId = 0
  vi.stubGlobal('crypto', { randomUUID: () => `request-${++nextId}` })
  return fetcher
}

describe('screening product flow', () => {
  it('lets beginners preview and edit an example without creating a conversation or executing a run', async () => {
    const fetcher = mockApi((url, method) => {
      if (url.pathname === '/api/v1/conversations' && method === 'GET') return json({ items: [] })
    })
    const user = userEvent.setup()
    render(<ConversationWorkspace />)
    await waitFor(() => expect(screen.getByLabelText('筛选要求')).toBeEnabled())
    expect(screen.queryByRole('complementary', { name: '当前筛选任务和结果' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '趋势向上' }))
    expect(screen.getByLabelText('筛选要求')).toHaveValue('筛选收盘价高于20日均线，且近5个交易日涨幅大于3%的股票。')
    expect(screen.getByLabelText('筛选要求')).toHaveFocus()
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it('preserves separate drafts when switching conversations and reopening the page', async () => {
    mockApi()
    const user = userEvent.setup()
    const view = render(<ConversationWorkspace />)
    await screen.findByText('收盘价高于20日均线')
    await waitFor(() => expect(screen.getByLabelText('筛选要求')).toBeEnabled())
    await user.type(screen.getByLabelText('筛选要求'), '把周期改成30日')
    expect(screen.getByLabelText('筛选要求')).toHaveValue('把周期改成30日')
    expect(screen.getByRole('button', { name: '确认并开始筛选' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /需求one/ }))
    expect(screen.getByLabelText('筛选要求')).toHaveValue('把周期改成30日')
    await user.click(screen.getByRole('button', { name: /需求two/ }))
    await waitFor(() => expect(screen.getByLabelText('筛选要求')).toBeEnabled())
    expect(screen.getByLabelText('筛选要求')).toHaveValue('')
    await user.type(screen.getByLabelText('筛选要求'), '只看观察池')
    await user.click(screen.getByRole('button', { name: /需求one/ }))
    await waitFor(() => expect(screen.getByLabelText('筛选要求')).toHaveValue('把周期改成30日'))
    view.unmount()
    render(<ConversationWorkspace />)
    await waitFor(() => expect(screen.getByLabelText('筛选要求')).toHaveValue('把周期改成30日'))
    await user.click(screen.getByRole('button', { name: /需求two/ }))
    await waitFor(() => expect(screen.getByLabelText('筛选要求')).toHaveValue('只看观察池'))
  })

  it('saves a fixed revision and safely retries without executing or creating another asset', async () => {
    const requests: Record<string, unknown>[] = []
    const fetcher = mockApi((url, method, body) => {
      if (url.pathname.endsWith('/one/saved-screening-tasks') && method === 'POST') {
        requests.push(body)
        return requests.length === 1 ? json({ message: '连接暂时中断' }, 503) : json({ ...saved, name: body.name })
      }
    })
    const user = userEvent.setup()
    render(<ConversationWorkspace />)
    await user.click(await screen.findByRole('button', { name: '保存方案' }))
    await user.clear(screen.getByLabelText('方案名称'))
    await user.type(screen.getByLabelText('方案名称'), '趋势跟踪')
    await user.click(screen.getByRole('button', { name: '确认保存' }))
    await screen.findByText('连接暂时中断')
    await user.click(screen.getByRole('button', { name: '确认保存' }))
    await screen.findByText('已保存“趋势跟踪”，可在左侧“已保存方案”中复用。')
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({ name: '趋势跟踪', revision: 1 })
    expect(fetcher.mock.calls.some(([url]) => /\/(execute|process)$/.test(String(url)))).toBe(false)
    await user.click(screen.getByRole('button', { name: '已保存方案' }))
    expect(await screen.findByText('趋势跟踪')).toBeInTheDocument()
  })

  it('reuses into a new editable conversation with the original cutoff and no execution', async () => {
    let reused = false
    const fresh = makeConversation('reused', 0)
    const fetcher = mockApi((url, method) => {
      if (url.pathname === '/api/v1/conversations' && method === 'POST') return json(fresh)
      if (url.pathname.endsWith('/reused/messages')) return json({ message_id: 'reuse-message' })
      if (url.pathname.endsWith('/saved-1/reuse')) { reused = true; return json({ revision: 1 }) }
      if (url.pathname === '/api/v1/conversations' && method === 'GET' && reused) return json({ items: [{ ...fresh, task_revision: 1, title: '复用趋势跟踪' }] })
      if (url.pathname.endsWith('/conversations/reused')) return json({ ...fresh, task_revision: 1, messages: [{ id: 'assistant-reuse', role: 'assistant', content: '已复用趋势跟踪，请核对截止日。', source_refs: [], created_at: saved.created_at }] })
    })
    const user = userEvent.setup()
    render(<ConversationWorkspace />)
    await user.click(screen.getByRole('button', { name: '已保存方案' }))
    await user.click(await screen.findByText('趋势跟踪'))
    await user.click(screen.getByRole('button', { name: '按原日期复用' }))
    await screen.findByText('已复用趋势跟踪，请核对截止日。')
    await waitFor(() => expect(screen.getByLabelText('筛选要求')).toBeEnabled())
    expect(screen.getByText('2026-09-14')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认并开始筛选' })).toBeEnabled()
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url))).toEqual([
      '/api/v1/conversations', '/api/v1/conversations/reused/messages', '/api/v1/conversations/reused/saved-screening-tasks/saved-1/reuse',
    ])
  })

  it('shows unresolved requirements and prevents saving or executing an incomplete task', async () => {
    mockApi(url => url.pathname.endsWith('/revisions/1') ? json({ ...task, unresolved: [{ kind: 'ambiguous', source_quote: '近期', question: '近期指多少个交易日？' }] }) : undefined)
    render(<ConversationWorkspace />)
    expect(await screen.findByText('近期指多少个交易日？')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存方案' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '确认并开始筛选' })).not.toBeInTheDocument()
  })

  it('keeps OR and exclusion groups visible, including reference-specific parameters', () => {
    const nested: ScreeningTaskRevision = { ...task,
      conditions: [...task.conditions, { ...task.conditions[0], condition_id: 'risk', description: '研报明确提示订单风险', library: 'report' }],
      references: [...task.references, { reference_id: 'long-trend', condition_id: 'trend', parameter_overrides: { window: 60 } }, { reference_id: 'risk-ref', condition_id: 'risk', parameter_overrides: {} }],
      logic_tree: { op: 'all', children: [{ op: 'any', children: [{ op: 'condition', reference_id: 'trend-ref' }, { op: 'condition', reference_id: 'long-trend' }] }, { op: 'not', children: [{ op: 'condition', reference_id: 'risk-ref' }] }] },
    }
    render(<TaskLogic task={nested} />)
    expect(screen.getByText('同时满足')).toBeInTheDocument()
    const anyGroup = screen.getByText('满足任一').parentElement!
    expect(within(anyGroup).getAllByText('收盘价高于20日均线')).toHaveLength(2)
    expect(within(anyGroup).getByText('本次采用的参数：周期 60')).toBeInTheDocument()
    const exclusion = screen.getByText('排除以下情况').parentElement!
    expect(within(exclusion).getByText('研报明确提示订单风险')).toBeInTheDocument()
  })

  it('resets result paging when switching runs and attaches the viewed run to a follow-up', async () => {
    const onSourceChange = vi.fn()
    const offsetRequests: string[] = []
    mockApi(url => {
      if (url.pathname === '/api/v1/conversations/one') return json({ ...makeConversation('one'), active_run_id: 'latest' })
      if (url.pathname === '/api/v1/conversations/one/screening-runs') return json({ items: [
        { id: 'latest', task_revision: 1, as_of: '2026-09-28', status: 'succeeded' },
        { id: 'historic', task_revision: 1, as_of: '2026-09-14', status: 'succeeded' },
      ] })
      const runId = url.pathname.includes('/historic') ? 'historic' : 'latest'
      if (url.pathname.endsWith('/decisions')) {
        offsetRequests.push(`${runId}:${url.searchParams.get('offset')}`)
        const code = runId === 'historic' ? '000001.SZ' : url.searchParams.get('offset') === '20' ? '600020.SH' : '600000.SH'
        return json({ items: [{ stock_code: code, state: 'unknown', evaluation_status: 'completed', reason_code: 'missing', condition_decisions: [{ condition_id: 'trend', reference_id: 'trend-ref', state: 'unknown', evaluation_status: 'completed', reason_code: 'missing', explanation: '历史行情不足', actual_values: {}, thresholds: {}, units: {} }] }], total: runId === 'historic' ? 1 : 41 })
      }
      if (/screening-runs\/(latest|historic)$/.test(url.pathname)) return json({
        id: runId, task_revision: 1, as_of: runId === 'historic' ? '2026-09-14' : '2026-09-28', status: 'succeeded', task: { ...task, conditions: [{ ...task.conditions[0], description: '原运行的趋势条件' }] },
        result: { coverage: { target_total: 41, true_count: 0, false_count: 0, unknown_count: 41, failed_count: 0, not_evaluated_count: 0 } }, job: { progress: 1, state: 'succeeded', message: '完成' },
      })
    })
    const user = userEvent.setup()
    render(<ConversationWorkspace onSourceChange={onSourceChange} />)
    await screen.findByText('600000.SH')
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await screen.findByText('600020.SH')
    await user.selectOptions(screen.getByLabelText('查看筛选运行'), 'historic')
    await user.click(await screen.findByText('000001.SZ'))
    expect(screen.getByText('原运行的趋势条件 · 数据不足')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '追问这只股票' }))
    expect(screen.getByLabelText('筛选要求')).toHaveValue('这次为什么无法判断000001.SZ是否符合条件？')
    expect(onSourceChange).toHaveBeenLastCalledWith({ reference: { kind: 'screening_run', source_id: 'historic' }, label: '筛选结果 · 2026-09-14 · v1' })
    expect(offsetRequests).toContain('latest:20')
    expect(offsetRequests).toContain('historic:0')
    expect(offsetRequests).not.toContain('historic:20')
  })
})
