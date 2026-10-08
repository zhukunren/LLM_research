import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import { TaskLogic } from './TaskBrief'
import type { Conversation, SavedScreeningTask, ScreeningTaskRevision, WorkflowType } from '../../api'

const task: ScreeningTaskRevision = {
  task_id: 'one', revision: 1, original_user_messages: ['收盘价高于20日均线'],
  conditions: [{ condition_id: 'trend', library: 'technical', description: '收盘价高于20日均线', source_quote: '收盘价高于20日均线', expression: {} }],
  references: [{ reference_id: 'trend-ref', condition_id: 'trend', parameter_overrides: {} }],
  logic_tree: { op: 'condition', reference_id: 'trend-ref' },
  scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: '2026-09-14', report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null },
  unresolved: [],
}
const saved: SavedScreeningTask = { id: 'saved-1', name: '趋势跟踪', version: 2, task, created_at: '2026-09-28T08:00:00Z' }
const makeConversation = (id: string, revision = 1, workflow: WorkflowType = revision ? 'screening' : 'research'): Conversation => ({
  id, task_id: id, entry_scope: 'screening', workflow_type: workflow, research_mode: workflow, task_revision: revision, active_run_id: null, pending_execution: false, state: 'active',
  messages: [{ id: `${id}-message`, role: 'user', content: `需求${id}`, source_refs: [], created_at: saved.created_at }],
  turns: revision ? [{ id: `${id}-turn`, user_message_id: `${id}-message`, base_revision: 0, state: 'succeeded', response_text: '方案已整理', result: { task_revision: revision }, created_at: saved.created_at, updated_at: saved.created_at }] : [],
  created_at: saved.created_at, updated_at: saved.created_at,
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function mockApi(intercept?: (url: URL, method: string, body: Record<string, unknown>) => Response | undefined, workflow: WorkflowType = 'screening') {
  const conversations = [makeConversation('one', workflow === 'screening' ? 1 : 0, workflow), makeConversation('two', workflow === 'screening' ? 1 : 0, workflow)]
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    const result = intercept?.(url, method, init?.body ? JSON.parse(String(init.body)) : {})
    if (result) return result
    if (url.pathname === '/api/v1/conversations' && method === 'GET') return json({ items: conversations.map(item => ({ ...item, title: `需求${item.id}` })) })
    if (url.pathname.endsWith('/revisions/1')) return json(task)
    if (url.pathname.endsWith('/screening-runs')) return json({ items: [] })
    if (/\/research-(files|scans)$/.test(url.pathname)) return json({ items: [] })
    if (url.pathname.endsWith('/generated-files')) return json({ items: [] })
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
  it('does not auto-save default scope on loading an incomplete task and still allows a follow-up', async () => {
    const fetcher = mockApi(url => url.pathname.endsWith('/revisions/1') ? json({ ...task, scope: { ...task.scope, universe: null, as_of: null } }) : undefined)
    const user = userEvent.setup()
    render(<ConversationWorkspace initialWorkflowType="screening" data={{ available: true, last_date: '2026-09-30' }} />)
    await screen.findByRole('heading', { name: '筛选方案' })
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    await user.type(screen.getByLabelText(/研究要求|选股要求/), '请继续完善条件')
    await new Promise(resolve => globalThis.setTimeout(resolve, 500))
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/scope') && init?.method === 'POST')).toBe(false)
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('请继续完善条件')
    expect(screen.getByRole('button', { name: '发送修改' })).toBeEnabled()
  })

  it('executes from the button, preserves the retry request and creates a new request for another run', async () => {
    const requests: Record<string, unknown>[] = []
    let queued = false
    const fetcher = mockApi((url, method, body) => {
      if (url.pathname.endsWith('/execute') && method === 'POST') {
        requests.push(body)
        if (requests.length === 1) return json({ message: '启动暂时中断' }, 503)
        queued = true
        return json({ run_id: 'button-run' })
      }
      if (url.pathname.endsWith('/one/screening-runs')) return json({ items: queued ? [{ id: 'button-run', task_revision: 1, as_of: task.scope.as_of, status: 'succeeded', job_id: 'button-job', created_at: saved.created_at, finished_at: saved.created_at }] : [] })
      if (url.pathname.endsWith('/screening-runs/button-run')) return json({ id: 'button-run', task_revision: 1, as_of: task.scope.as_of, status: 'succeeded', task, result: {}, job: { state: 'succeeded', progress: 1, message: '' } })
      if (url.pathname.endsWith('/decisions')) return json({ items: [], total: 0 })
    })
    const user = userEvent.setup()
    render(<ConversationWorkspace initialWorkflowType="screening" />)
    await user.click(await screen.findByRole('button', { name: '确认并开始筛选' }))
    await screen.findByText('启动暂时中断')
    await user.click(screen.getByRole('button', { name: '确认并开始筛选' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({ action: 'button', revision: 1, request_id: expect.any(String) })
    await waitFor(() => expect(screen.getByRole('button', { name: '按当前条件再筛一次' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '按当前条件再筛一次' }))
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2].request_id).not.toBe(requests[1].request_id)
    expect(fetcher.mock.calls.some(([url]) => /\/(messages|process)$/.test(String(url)))).toBe(false)
  })

  it('automatically saves scope with an unsent draft and retries a failure without changing the request', async () => {
    const requests: Record<string, unknown>[] = []
    let revision = 1
    mockApi((url, method, body) => {
      if (url.pathname.endsWith('/one/scope') && method === 'POST') {
        requests.push(body)
        if (requests.length === 1) return json({ message: '范围保存中断' }, 503)
        revision = 2
        return json({ revision })
      }
      if (url.pathname === '/api/v1/conversations/one') return json(makeConversation('one', revision))
      if (url.pathname.endsWith('/revisions/2')) return json({ ...task, revision: 2, scope: { ...task.scope, as_of: '2026-09-13' } })
    })
    const user = userEvent.setup()
    render(<ConversationWorkspace initialWorkflowType="screening" />)
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    expect(screen.queryByRole('button', { name: '应用范围与日期' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText(/研究要求|选股要求/), '稍后比较估值')
    fireEvent.change(screen.getByLabelText('调整行情日期'), { target: { value: '2026-09-13' } })
    await screen.findByText('范围保存中断')
    await user.click(screen.getByRole('button', { name: '重试保存范围和日期' }))
    await screen.findByText('范围和日期已自动保存')
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({ base_revision: 1, as_of: '2026-09-13' })
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('稍后比较估值')
    expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled()
  })

  it('persists depth independently from workflow, restores it, and keeps it on save failure', async () => {
    let depth = 'standard'
    mockApi((url, method, body) => {
      if (url.pathname.endsWith('/one/workflow') && method === 'PATCH') {
        expect(body.workflow_type).toBeUndefined()
        if (body.research_depth === 'standard') return json({ message: '深度保存中断' }, 503)
        depth = String(body.research_depth)
        return json({ workflow_type: 'screening', research_depth: depth })
      }
      if (url.pathname.endsWith('/conversations/one')) return json({ ...makeConversation('one'), workflow_type: 'screening', research_depth: depth })
    })
    const user = userEvent.setup()
    const view = render(<ConversationWorkspace initialWorkflowType="screening" />)
    await user.click(screen.getByRole('button', { name: '选股设置' }))
    await waitFor(() => expect(screen.getByLabelText('研究深度')).toBeEnabled())
    await user.selectOptions(screen.getByLabelText('研究深度'), 'deep')
    await screen.findByText('研究深度已设为“深入”。')
    view.unmount()
    render(<ConversationWorkspace initialWorkflowType="screening" />)
    await user.click(screen.getByRole('button', { name: '选股设置' }))
    await waitFor(() => expect(screen.getByLabelText('研究深度')).toHaveValue('deep'))
    await user.selectOptions(screen.getByLabelText('研究深度'), 'standard')
    await screen.findByText('深度保存中断')
    expect(screen.getByLabelText('研究深度')).toHaveValue('deep')
  })

  it('saves with an automatic name in one click and retries the same request without executing', async () => {
    const requests: Record<string, unknown>[] = []
    const fetcher = mockApi((url, method, body) => {
      if (url.pathname.endsWith('/one/saved-screening-tasks') && method === 'POST') {
        requests.push(body)
        return requests.length === 1 ? json({ message: '连接暂时中断' }, 503) : json({ ...saved, name: body.name })
      }
    })
    const user = userEvent.setup()
    render(<ConversationWorkspace initialWorkflowType="screening" />)
    await user.click(await screen.findByText('保存方案与项目归属'))
    await user.click(await screen.findByRole('button', { name: '保存方案' }))
    await screen.findByText('连接暂时中断')
    expect(screen.queryByLabelText('方案名称')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存方案' }))
    await screen.findByText('已保存“收盘价高于20日均线”。')
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({ name: '收盘价高于20日均线', revision: 1 })
    expect(fetcher.mock.calls.some(([url]) => /\/(execute|process)$/.test(String(url)))).toBe(false)
  })

  it('keeps open research focused on the answer and reveals only actual artifacts', async () => {
    let hasOutput = false
    mockApi(url => {
      if (url.pathname === '/api/v1/conversations/one' || url.pathname === '/api/v1/conversations/two') {
        const id = url.pathname.endsWith('/one') ? 'one' : 'two'
        return json({ ...makeConversation(id, 0), messages: [{ id: `${id}-answer`, role: 'assistant', content: id === 'one' ? '## 订单研究结论\n\n订单已落地。' : '## 另一段研究', source_refs: [], created_at: saved.created_at }] })
      }
      if (url.pathname === '/api/v1/conversations/one/research-files') {
        hasOutput = true
        return json({ items: [{ name: '研究笔记.md', bytes: 100, url: '/api/v1/conversations/one/research-files/note.md' }] })
      }
    }, 'research')
    const user = userEvent.setup()
    render(<ConversationWorkspace initialWorkflowType="research" />)
    await screen.findByRole('heading', { name: '订单研究结论' })
    expect(screen.queryByRole('dialog', { name: '研究成果' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: '成果与文件' }))
    await screen.findByRole('link', { name: /研究笔记.md/ })
    expect(hasOutput).toBe(true)
    expect(screen.queryByRole('heading', { name: '筛选方案' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '筛选结果' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '研究成果' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '成果与文件' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: '最近研究对话' }))
    await user.click(screen.getByRole('button', { name: /需求two/ }))
    await screen.findByRole('heading', { name: '另一段研究' })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: '当前筛选任务和结果' })).not.toBeInTheDocument())
    expect(screen.queryByRole('link', { name: /研究笔记.md/ })).not.toBeInTheDocument()
  })

  it('lets beginners preview and edit an example without creating a conversation or executing a run', async () => {
    const fetcher = mockApi((url, method) => {
      if (url.pathname === '/api/v1/conversations' && method === 'GET') return json({ items: [] })
    }, 'research')
    const user = userEvent.setup()
    render(<ConversationWorkspace initialWorkflowType="research" />)
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    expect(screen.queryByRole('complementary', { name: '当前筛选任务和结果' })).not.toBeInTheDocument()
    await user.click(screen.getByText('示例问题'))
    await user.click(screen.getByRole('button', { name: '市场机会' }))
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('最近哪些股票值得进一步研究？请结合走势、成交和已有资料，列出理由与风险。')
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveFocus()
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it('preserves separate drafts when switching conversations and reopening the page', async () => {
    mockApi()
    const user = userEvent.setup()
    const view = render(<ConversationWorkspace initialWorkflowType="screening" />)
    await screen.findByText('收盘价高于20日均线')
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    await user.type(screen.getByLabelText(/研究要求|选股要求/), '把周期改成30日')
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('把周期改成30日')
    expect(screen.getByRole('button', { name: '确认并开始筛选' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '历史与方案' }))
    await user.click(screen.getByRole('button', { name: /需求one/ }))
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('把周期改成30日')
    await user.click(screen.getByRole('button', { name: '历史与方案' }))
    await user.click(screen.getByRole('button', { name: /需求two/ }))
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('')
    await user.type(screen.getByLabelText(/研究要求|选股要求/), '只看观察池')
    await user.click(screen.getByRole('button', { name: '历史与方案' }))
    await user.click(screen.getByRole('button', { name: /需求one/ }))
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('把周期改成30日'))
    view.unmount()
    render(<ConversationWorkspace initialWorkflowType="screening" />)
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('把周期改成30日'))
    await user.click(screen.getByRole('button', { name: '历史与方案' }))
    await user.click(screen.getByRole('button', { name: /需求two/ }))
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('只看观察池'))
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
    render(<ConversationWorkspace initialWorkflowType="screening" />)
    await user.click(await screen.findByRole('button', { name: '设置方案名称' }))
    await user.clear(screen.getByLabelText('方案名称'))
    await user.type(screen.getByLabelText('方案名称'), '趋势跟踪')
    await user.click(screen.getByRole('button', { name: '确认保存' }))
    await screen.findByText('连接暂时中断')
    await user.click(screen.getByRole('button', { name: '确认保存' }))
    await screen.findByText('已保存“趋势跟踪”。')
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({ name: '趋势跟踪', revision: 1 })
    expect(fetcher.mock.calls.some(([url]) => /\/(execute|process)$/.test(String(url)))).toBe(false)
    await user.click(screen.getByRole('button', { name: '历史与方案' }))
    await user.click(screen.getByRole('button', { name: '已保存方案' }))
    expect(await screen.findByText('趋势跟踪')).toBeInTheDocument()
  })

  it('reuses into a new editable conversation with the original cutoff and no execution', async () => {
    let reused = false
    const fresh = makeConversation('reused', 0, 'screening')
    const fetcher = mockApi((url, method) => {
      if (url.pathname === '/api/v1/conversations' && method === 'POST') return json(fresh)
      if (url.pathname.endsWith('/reused/messages')) return json({ message_id: 'reuse-message' })
      if (url.pathname.endsWith('/saved-1/reuse')) { reused = true; return json({ revision: 1 }) }
      if (url.pathname === '/api/v1/conversations' && method === 'GET' && reused) return json({ items: [{ ...fresh, task_revision: 1, title: '复用趋势跟踪' }] })
      if (url.pathname.endsWith('/conversations/reused')) return json({ ...makeConversation('reused'), messages: [{ id: 'assistant-reuse', role: 'assistant', content: '已复用趋势跟踪，请核对截止日。', source_refs: [], created_at: saved.created_at }] })
    })
    const user = userEvent.setup()
    render(<ConversationWorkspace initialWorkflowType="screening" />)
    await user.click(await screen.findByRole('button', { name: '历史与方案' }))
    await user.click(screen.getByRole('button', { name: '已保存方案' }))
    await user.click(await screen.findByText('趋势跟踪'))
    await user.click(screen.getByRole('button', { name: '按原日期复用' }))
    await screen.findByText('已复用趋势跟踪，请核对截止日。')
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    expect(screen.getByText('2026-09-14')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认并开始筛选' })).toBeEnabled()
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url))).toEqual([
      '/api/v1/conversations', '/api/v1/conversations/reused/messages', '/api/v1/conversations/reused/saved-screening-tasks/saved-1/reuse',
    ])
  })

  it('shows unresolved requirements and prevents saving or executing an incomplete task', async () => {
    mockApi(url => url.pathname.endsWith('/revisions/1') ? json({ ...task, unresolved: [{ kind: 'ambiguous', source_quote: '近期', question: '近期指多少个交易日？' }] }) : undefined)
    render(<ConversationWorkspace initialWorkflowType="screening" />)
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
    render(<ConversationWorkspace initialWorkflowType="screening" onSourceChange={onSourceChange} />)
    await screen.findByText('600000.SH')
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await screen.findByText('600020.SH')
    await user.selectOptions(screen.getByLabelText('查看筛选运行'), 'historic')
    await user.click(await screen.findByText('000001.SZ'))
    expect(screen.getByText('原运行的趋势条件 · 数据不足')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '追问这只股票' }))
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('这次为什么无法判断000001.SZ是否符合条件？')
    expect(onSourceChange).toHaveBeenLastCalledWith({ reference: { kind: 'screening_run', source_id: 'historic' }, label: '筛选结果 · 2026-09-14 · v1' })
    expect(offsetRequests).toContain('latest:20')
    expect(offsetRequests).toContain('historic:0')
    expect(offsetRequests).not.toContain('historic:20')
  })
})

it('restores an unsent new research draft instead of reopening the latest conversation', async () => {
  const fetcher = mockApi(undefined, 'research')
  const user = userEvent.setup()
  const view = render(<ConversationWorkspace initialWorkflowType="research" />)
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('需求one'))
  await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '新研究' }))
  await user.type(screen.getByLabelText(/研究要求|选股要求/), '比较两家公司的订单兑现质量')
  view.unmount()
  render(<ConversationWorkspace initialWorkflowType="research" />)
  await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
  expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('比较两家公司的订单兑现质量')
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
})

it('restores each scope independently when leaving a fresh research draft', async () => {
  mockApi(undefined, 'research')
  localStorage.setItem('conversation.active.report', 'two')
  localStorage.setItem('conversation.active.pattern', 'one')
  const user = userEvent.setup()
  const view = render(<ConversationWorkspace initialWorkflowType="research" />)
  await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '新研究' }))
  await user.type(screen.getByLabelText(/研究要求|选股要求/), '尚未发送的研究问题')
  await user.click(screen.getByRole('button', { name: '最近研究对话' }))
  await user.selectOptions(screen.getByLabelText('对话范围'), 'report')
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('需求two'))
  await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '新研究' }))
  view.rerender(<ConversationWorkspace initialWorkflowType="research" initialScope="pattern" />)
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('需求one'))
  expect(localStorage.getItem('conversation.active.screening')).toBe('__new__')
  expect(JSON.parse(sessionStorage.getItem('conversation.drafts')!)['research:screening:new']).toBe('尚未发送的研究问题')
})
