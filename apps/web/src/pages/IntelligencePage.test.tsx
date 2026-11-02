import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import { defaultBriefScope, defaultAdvisorScope, type BriefCatalog, type BriefDetail, type AdvisorReport } from '../intelligence'
import IntelligencePage from './IntelligencePage'

vi.mock('../api', async original => ({ ...await original<typeof import('../api')>(), api: vi.fn() }))
const callbacks = () => ({ onLocation: vi.fn(), onResearch: vi.fn(), onSettings: vi.fn() })
const catalog: BriefCatalog = { items: [], total: 0, next_offset: null, latest_result_id: null, default_scope: defaultBriefScope, legacy: [] }
const run: BriefDetail = {
  id: 'run-1', kind: 'market', version: 1, scope: defaultBriefScope, cutoff_at: '2026-10-20T10:00:00+08:00',
  window_start: '2026-10-19T10:00:00+08:00', created_at: '2026-10-20T02:00:00Z', finished_at: null,
  state: 'queued', previous_id: null, conversation_id: 'conversation-1', turn_id: 'turn-1', retry_of: null,
  title: '市场简报', item_count: null, error: null, result: null, source_count: 0, search_count: 0,
  activity: [{ id: 1, stage: 'scope', message: '范围与截止时间已保存，等待后台执行。', created_at: '2026-10-20T02:00:00Z' }], sources: [],
}
const citation = { source_id: 'source-1', title: '原始公司公告', url: 'https://example.com/source', quote: '这里是保存的公告原文摘录。',
  quote_start: 0, quote_end: 13, quote_verified: true, published_at: '2026-10-20', publication_precision: 'date',
  publication_quote: '', publication_basis: 'page_metadata', time_status: 'date_only', source_type: 'primary',
  retrieved_at: '2026-10-20T02:00:00Z', sha256: 'snapshot-hash' }
const completed: BriefDetail = { ...run, title: '订单变化简报', state: 'partial', item_count: 1, source_count: 1, result: {
  title: '订单变化简报', summary: '核对公司公告后整理订单变化及后续验证事项。',
  coverage: '已核对一份原始公告，其他行业资料未覆盖。', limitations: [], no_updates_reason: '',
  not_in_current: [], comparison: '按事件标识比较。', verification_note: '引用定位不代表结论获独立证实。',
  items: [{ event_key: 'order-event', title: '公司订单已签署', event_date: '2026-10-20', facts: '公司公告新增订单已经签署。',
    analysis: '订单交付尚需核对，不应直接等同于确认收入。', importance: 'high', ranking_reason: '有原始公告支持。',
    affected: ['半导体'], uncertainties: ['交付时间待核对'], next_check: '检查后续交付公告', policy_stage: null,
    industry_dimension: null, evidence: [citation], verification: 'time_pending', change: 'new' }],
} }
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear() })

it('opens a business scope form without launching work or showing a prompt editor', async () => {
  vi.mocked(api).mockResolvedValue(catalog as never)
  render(<IntelligencePage {...callbacks()} />)
  expect(await screen.findByRole('form', { name: '情报范围设置' })).toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: '中国内地' })).toBeChecked()
  expect(screen.queryByRole('textbox', { name: '研究要求' })).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true)
})

it('keeps settings in a drawer, retains unfinished inputs and leaves the current frozen result unchanged', async () => {
  vi.mocked(api).mockImplementation(async path => path.includes('/runs/') ? completed as never : { ...catalog, items: [completed], total: 1, latest_result_id: completed.id } as never)
  const user = userEvent.setup(), view = render(<IntelligencePage {...callbacks()} />)
  await screen.findByText('公司订单已签署')
  const current = screen.getByRole('region', { name: '当前情报成果' })
  const original = current.textContent
  const trigger = screen.getByRole('button', { name: '范围设置' })
  await user.click(trigger)
  const dialog = screen.getByRole('dialog', { name: '范围设置' })
  expect(view.container.querySelector('.intelligence-scope-form')).toBeNull()
  await user.selectOptions(within(dialog).getByLabelText('时间窗口'), '72')
  await user.type(within(dialog).getByLabelText('关注行业'), '半导体')
  await user.click(within(dialog).getByRole('button', { name: '返回成果' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
  expect(current.textContent).toBe(original)
  await user.click(trigger)
  expect(screen.getByLabelText('时间窗口')).toHaveValue('72')
  expect(screen.getByLabelText('关注行业')).toHaveValue('半导体')
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: '历史版本' }))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.queryByRole('form')).not.toBeInTheDocument()
  expect(view.container.querySelector('.intelligence-history')).toBeNull()
  expect(screen.getByRole('button', { name: /订单变化简报/ })).toHaveAttribute('aria-current', 'true')
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true)
})

it('closes history before opening a legacy conversation and keeps paged version selection read-only', async () => {
  const older = { ...completed, id: 'older', version: 1, title: '上期原始简报' }
  vi.mocked(api).mockImplementation(async path => {
    if (path.includes('offset=')) return { ...catalog, items: [older], total: 2 } as never
    if (path.includes('/runs/')) return (path.endsWith('older') ? older : completed) as never
    return { ...catalog, items: [completed], total: 2, next_offset: 1, latest_result_id: completed.id, legacy: [{ conversation_id: 'legacy', title: '升级前研究', started_at: '2026-10-01T00:00:00Z' }] } as never
  })
  const props = callbacks(), user = userEvent.setup()
  render(<IntelligencePage {...props} />)
  await screen.findByText('公司订单已签署')
  await user.click(screen.getByRole('button', { name: '历史版本' }))
  await user.click(screen.getByRole('button', { name: '更早的版本' }))
  await user.click(await screen.findByRole('button', { name: /上期原始简报/ }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(props.onLocation).toHaveBeenLastCalledWith('market', 'older')
  await user.click(screen.getByRole('button', { name: '历史版本' }))
  await user.click(screen.getByText('升级前的研究记录'))
  await user.click(screen.getByRole('button', { name: /升级前研究/ }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(props.onResearch).toHaveBeenCalledWith('legacy')
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true)
})

it('keeps validation feedback with its settings and closes the drawer before opening data services', async () => {
  vi.mocked(api).mockResolvedValue(catalog as never)
  const user = userEvent.setup(), props = callbacks()
  render(<IntelligencePage {...props} />)
  const dialog = await screen.findByRole('dialog', { name: '范围设置' })
  await user.click(within(dialog).getByRole('checkbox', { name: '中国内地' }))
  await user.click(within(dialog).getByRole('button', { name: '按此范围生成' }))
  expect(within(dialog).getByRole('alert')).toHaveTextContent('至少选择一个市场')
  await user.click(within(dialog).getByRole('button', { name: '数据与服务' }))
  expect(props.onSettings).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true)
})

it('submits structured scope once and reads real progress from the accepted run', async () => {
  const props = callbacks(), user = userEvent.setup()
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/intelligence/runs' && options?.method === 'POST') return run as never
    if (path.includes('/runs/')) return { ...run, state: 'running', source_count: 2, search_count: 3,
      activity: [...run.activity, { id: 2, stage: 'collect', message: '已保存原文：公司公告', created_at: run.created_at }] } as never
    return catalog as never
  })
  render(<IntelligencePage {...props} />)
  await screen.findByRole('form')
  await user.click(screen.getByRole('checkbox', { name: '美国' }))
  await user.selectOptions(screen.getByLabelText('时间窗口'), '72')
  await user.type(screen.getByLabelText('关注行业'), '半导体、算力')
  await user.click(screen.getByRole('button', { name: '按此范围生成' }))
  expect(await screen.findByText('已保存原文：公司公告')).toBeInTheDocument()
  const posts = vi.mocked(api).mock.calls.filter(([path, options]) => path === '/intelligence/runs' && options?.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({ kind: 'market', scope: { markets: ['CN', 'US'], industries: ['半导体', '算力'], lookback_hours: 72 } })
  expect(props.onLocation).toHaveBeenCalledWith('market', 'run-1')
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
})

it('reuses the same submission after a transport failure and a page remount', async () => {
  let failed = true
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/intelligence/runs' && options?.method === 'POST') {
      if (failed) throw new Error('连接中断')
      return run as never
    }
    return path.includes('/runs/') ? run as never : catalog as never
  })
  const user = userEvent.setup(), first = render(<IntelligencePage {...callbacks()} />)
  await user.click(await screen.findByRole('button', { name: '按此范围生成' }))
  await screen.findByText('连接中断')
  first.unmount()
  failed = false
  render(<IntelligencePage {...callbacks()} />)
  await user.click(await screen.findByRole('button', { name: '继续提交' }))
  await screen.findByRole('region', { name: '实际执行进展' })
  const posts = vi.mocked(api).mock.calls.filter(([path, options]) => path === '/intelligence/runs' && options?.method === 'POST')
  expect(posts).toHaveLength(2)
  expect(posts[0][1]!.body).toEqual(posts[1][1]!.body)
})

it('reads frozen evidence, clearly marks time uncertainty, and changes history without writes', async () => {
  const props = callbacks(), user = userEvent.setup()
  const older = { ...completed, id: 'older', version: 1, cutoff_at: '2026-10-19T10:00:00+08:00' }
  vi.mocked(api).mockImplementation(async path => {
    if (path.endsWith('/evidence/source-1')) return { id: 'source-1', ...citation, text: citation.quote + '后续上下文。', publisher_date: '2026-10-20' } as never
    if (path.endsWith('/runs/older')) return older as never
    if (path.includes('/runs/')) return completed as never
    return { ...catalog, items: [completed, older], total: 2, latest_result_id: run.id } as never
  })
  render(<IntelligencePage {...props} />)
  await screen.findByText('公司订单已签署')
  expect(screen.getByText('来源时间待核验')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /原始公司公告/ }))
  const dialog = await screen.findByRole('dialog', { name: '简报原文证据' })
  expect(await within(dialog).findByText('打开来源网站')).toHaveAttribute('href', citation.url)
  await waitFor(() => expect(dialog.querySelector('mark')).not.toBeNull())
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '历史版本' }))
  await user.click(screen.getByRole('button', { name: /订单变化简报.*2026\/10\/19/ }))
  expect(props.onLocation).toHaveBeenLastCalledWith('market', 'older')
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true)
})

it('a failed detail read never silently substitutes the latest successful version', async () => {
  vi.mocked(api).mockImplementation(async path => {
    if (path.includes('/runs/missing')) throw new Error('找不到这份情报成果')
    return { ...catalog, latest_result_id: 'run-1', items: [completed], total: 1 } as never
  })
  const props = callbacks()
  render(<IntelligencePage {...props} runId="missing" />)
  expect(await screen.findByText(/结果读取失败/)).toBeInTheDocument()
  expect(props.onLocation).not.toHaveBeenCalled()
  expect(screen.queryByText('订单变化简报')).not.toBeInTheDocument()
})

it('ignores an old response after selecting another version', async () => {
  let finish!: (value: never) => void
  vi.mocked(api).mockImplementation(path => path.endsWith('/runs/run-1')
    ? new Promise(resolve => { finish = resolve })
    : Promise.resolve(path.includes('/runs/') ? { ...completed, id: 'run-2' } as never : catalog as never))
  const props = callbacks(), view = render(<IntelligencePage {...props} runId="run-1" />)
  await waitFor(() => expect(finish).toBeDefined())
  view.rerender(<IntelligencePage {...props} runId="run-2" />)
  await screen.findByText('订单变化简报')
  await act(async () => finish({ ...run, title: '过期结果' } as never))
  expect(screen.queryByText('过期结果')).not.toBeInTheDocument()
})

it('requires an explicit stock selection and sends structured adviser inputs', async () => {
  const user = userEvent.setup()
  vi.mocked(api).mockImplementation(async (path, init) => path === '/intelligence/runs' && init?.method === 'POST'
    ? { ...run, kind: 'stock-rationale' } as never : path.includes('/runs/') ? { ...run, kind: 'stock-rationale' } as never : catalog as never)
  render(<IntelligencePage {...callbacks()} kind="stock-rationale" />)
  await user.click(await screen.findByRole('button', { name: '按此设置生成' }))
  expect(screen.getByText('请先从股票目录选择要研究的股票。')).toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true)
  await user.type(screen.getByRole('combobox', { name: '投顾研究股票' }), '600519.SH')
  await user.type(screen.getByLabelText('推荐背景（可选）'), '已向客户提及，需核对经营与估值依据')
  await user.selectOptions(screen.getByLabelText('分析期限'), 'long')
  await user.click(screen.getByRole('button', { name: '按此设置生成' }))
  const posted = vi.mocked(api).mock.calls.find(([path, init]) => path === '/intelligence/runs' && init?.method === 'POST')!
  expect(JSON.parse(posted[1]!.body as string)).toMatchObject({ kind: 'stock-rationale', scope: { advisor: { stock_code: '600519.SH', horizon: 'long', recommendation_background: '已向客户提及，需核对经营与估值依据' } } })
})

it('clears an old stock selection when a new search is started', async () => {
  vi.mocked(api).mockResolvedValue({ ...catalog, default_scope: { ...defaultBriefScope, advisor: { ...defaultAdvisorScope, stock_code: '600519.SH' } } } as never)
  const user = userEvent.setup()
  render(<IntelligencePage {...callbacks()} kind="stock-analysis" />)
  const stock = await screen.findByRole('combobox', { name: '投顾研究股票' })
  await user.click(stock)
  await user.type(stock, '其他公司')
  await user.click(screen.getByRole('button', { name: '按此设置生成' }))
  expect(screen.getByText('请先从股票目录选择要研究的股票。')).toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true)
})

it('shows verdict, opposing evidence and separate short/full drafts for an adviser report', async () => {
  const user = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const report: AdvisorReport = { stock_code: '600519.SH', verdict: 'conditional', conclusion: '已有订单证据，但交付与估值仍需核对后形成判断。', effective_date: '2026-10-20', session_status: null,
    supporting_points: [{ title: '订单线索', explanation: '有公告原文支持订单已签署，但不能直接推导收入。', evidence_keys: ['order-event'] }],
    contrary_points: [], risks: ['交付不及预期'], invalidation_conditions: ['订单发生实质变化'], action_conditions: ['核对后续交付和估值'],
    suitability: '中期研究，客户风险信息尚未提供', client_copy: '客户短稿：订单已有证据，但需要继续核对交付和估值。', full_copy: '完整稿：分别核对经营、量价、估值和反方依据，在条件满足后再形成建议。' }
  const data = { ...completed, kind: 'stock-rationale', result: { ...completed.result!, advisor_report: report } }
  vi.mocked(api).mockImplementation(async path => path.includes('/runs/') ? data as never : { ...catalog, items: [data], latest_result_id: data.id } as never)
  render(<IntelligencePage {...callbacks()} kind="stock-rationale" />)
  expect(await screen.findByRole('region', { name: '投顾研判与稿件' })).toBeInTheDocument()
  expect(screen.getByText('有条件支持')).toBeInTheDocument()
  const shortDraft = screen.getByRole('textbox', { name: '客户短稿正文' })
  expect(shortDraft).toHaveValue(report.client_copy)
  await user.clear(shortDraft)
  await user.type(shortDraft, '投顾修改后的沟通稿，等待交付兑现后再决定。')
  await user.click(screen.getByRole('button', { name: '复制短稿' }))
  expect(copy).toHaveBeenLastCalledWith(expect.stringContaining('投顾修改后的沟通稿，等待交付兑现后再决定。'))
  await user.click(screen.getByRole('button', { name: '完整稿' }))
  expect(screen.getByRole('textbox', { name: '完整稿正文' })).toHaveValue(report.full_copy)
  expect(screen.getByRole('button', { name: '复制完整稿' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '客户短稿' }))
  expect(screen.getByRole('textbox', { name: '客户短稿正文' })).toHaveValue('投顾修改后的沟通稿，等待交付兑现后再决定。')
  await user.click(screen.getByRole('button', { name: '恢复生成稿' }))
  expect(screen.getByRole('textbox', { name: '客户短稿正文' })).toHaveValue(report.client_copy)
  expect(screen.getByText('AI 生成 · 待投顾核对')).toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true)
})

it('shows closing defaults and Beijing event timing, and copies only the dated client draft', async () => {
  const user = userEvent.setup(), copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const clientDraft = '盘面回顾：沪深两市成交额约1.46万亿元。热点板块：科技方向活跃。明日观察：活动安排在北京时间10月21日17:00、A股收盘后。市场有风险，投资需谨慎。'
  const report: AdvisorReport = { stock_code: null, verdict: 'review', conclusion: '指数表现分化，后续观察成交和上涨股票数量是否继续增加。', effective_date: '2026-10-20', session_status: 'closed',
    supporting_points: [], contrary_points: [], risks: ['板块轮动可能较快'], invalidation_conditions: ['成交和上涨股票数量回落'], action_conditions: ['核对正式公告'],
    suitability: '面向普通客户的市场资讯交流', client_copy: clientDraft, full_copy: '内部完整稿保留精确统计、来源与缺口。',
    closing_review: { turnover: { market_scope: 'SH_SZ', amount_yi: 14561.12, evidence_keys: ['order-event'], comparison: { market_scope: 'SH_SZ', change_yi: 185.95, evidence_keys: ['order-event'] } },
      events: [{ title: '产业活动主题演讲', evidence_keys: ['order-event'], local_start: '2026-10-21T11:00:00+02:00', source_timezone: 'Europe/Berlin', beijing_start: '2026-10-21T17:00:00+08:00', session_relation: 'after_close', client_copy_excerpt: '活动安排在北京时间10月21日17:00、A股收盘后。' }], scope_notes: '行业与概念统计分别核对。' } }
  const data = { ...completed, kind: 'closing', result: { ...completed.result!, advisor_report: report } }
  vi.mocked(api).mockImplementation(async path => path.includes('/runs/') ? data as never : { ...catalog, items: [data], latest_result_id: data.id } as never)
  render(<IntelligencePage {...callbacks()} kind="closing" />)
  await screen.findByRole('region', { name: '投顾研判与稿件' })
  await user.click(screen.getByText('本版行情口径与事件北京时间'))
  expect(screen.getByText(/成交额口径：沪深两市/)).toBeVisible()
  expect(screen.getByText(/产业活动主题演讲：北京时间2026\/10\/21 17:00/)).toBeVisible()
  await user.click(screen.getByRole('button', { name: '复制短稿' }))
  expect(copy).toHaveBeenLastCalledWith('2026-10-20 A股收评\n\n' + clientDraft)
  expect(screen.getByText('AI 生成 · 待投顾核对')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '任务设置' }))
  expect(screen.getByRole('note')).toHaveTextContent('默认优先沪深两市成交额')
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true)
})
