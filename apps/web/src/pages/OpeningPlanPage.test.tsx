import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import { sessionStorage } from '../authStorage'
import { fixedDisclosure } from '../clientService'
import OpeningPlanPage from './OpeningPlanPage'

vi.mock('../api', async original => ({ ...await original<typeof import('../api')>(), api: vi.fn() }))

const endpoint = '/client-service/opening-plans'
const planDate = '2026-11-20'
const fixture = {
  plan_date: planDate, cutoff: '2026-11-20T09:15:00+08:00', state: 'succeeded',
  message: '已采集 2 个段落，可编辑后复制。',
  sections: { overnight: '样例说明上个交易日的行情。', judgment: '样例观察量能。' },
  sources: [{ title: '市场原文', url: 'https://example.com/market', published_at: '2026-11-19' }],
  market: { index: '上证指数', trade_date: '2026-11-19', close: '3550.00', pct_change: null, source: '本地日线' },
}
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const defaultEditor = { template: { revision: 0, content: { theme: 'soochow', sections: {} }, collection_request_id: null }, saved: null }
const png = 'data:image/png;base64,cGxhbg=='
function mockApi(collect: (path: string, init?: RequestInit) => Promise<unknown> = async () => { throw new Error('Unexpected collection request') },
  upcoming = () => planDate) {
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === endpoint + '/default-date') return { plan_date: upcoming() }
    if (path.startsWith(endpoint + '/preview')) return { image: png, width: 1080, height: 1660, regions: [] }
    if (path.startsWith(endpoint + '/editor/')) return defaultEditor
    return collect(path, init)
  })
}
async function collectPlan(user: ReturnType<typeof userEvent.setup>) {
  const button = screen.getByRole('button', { name: 'AI生成' })
  await waitFor(() => expect(button).toBeEnabled())
  await user.click(button)
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  mockApi()
  sessionStorage.removeItem('client-service.opening.date')
  for (const date of [planDate, '2026-11-18', '2026-11-23']) {
    sessionStorage.removeItem('client-service.opening.draft.' + date)
    sessionStorage.removeItem('client-service.opening.request.' + date)
  }
})

it('copies an editable dated template with fixed adviser details, selected sections and no URLs', async () => {
  const user = userEvent.setup()
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
  render(<OpeningPlanPage />)
  const copy = await screen.findByRole('button', { name: '复制文案' })
  expect(copy).toBeDisabled()
  fill('计划日期', planDate)
  fill('今日核心判断', '依据[行情公告](https://example.com/market)观察量能。')
  fill('今日方向一', '防御观察\n参与条件由投顾核对。')
  fill('今日风控', '盘中先观察。')
  await user.click(screen.getByRole('button', { name: '复制文案' }))
  const text = clipboard.mock.lastCall?.[0] || ''
  expect(text).toContain('2026年11月20日（星期五）开盘计划\n投资顾问：' + fixedDisclosure.adviser)
  expect(text).toContain('【今日核心判断】依据行情公告观察量能。')
  expect(text).toContain('【今日方向一】防御观察\n参与条件由投顾核对。')
  expect(text).toContain('【今日风控】盘中先观察。')
  expect(text).toContain('风险提示：本计划风险等级R4')
  expect(text).not.toMatch(/https?:\/\/|【今日新股】|【今日方向二】/)
  expect(text.endsWith(fixedDisclosure.institution)).toBe(true)
  expect(vi.mocked(api).mock.calls.some(([path]) => path === endpoint)).toBe(false)

  await user.click(screen.getByRole('button', { name: '文案' }))
  fill('计划日期', '2026-11-18')
  expect(screen.getByLabelText('今日核心判断')).toHaveValue('')
  expect(screen.getByLabelText('可复制的开盘计划')).toHaveTextContent('2026年11月18日（星期三）开盘计划')
  fill('今日核心判断', '另一日的计划。')
  fill('计划日期', planDate)
  expect(screen.getByLabelText('今日核心判断')).toHaveValue('依据[行情公告](https://example.com/market)观察量能。')
})

it('rechecks automatic dates at collection and keeps the previous draft on its own date', async () => {
  const nextDate = '2026-11-23'
  const focus = '优先补充盘前速览。'
  let upcoming = planDate
  let requestId = ''
  sessionStorage.setItem('client-service.opening.date', JSON.stringify('2026-11-18'))
  mockApi(async (path, init) => {
    if (path === endpoint) {
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({ plan_date: nextDate, model_mode: 'deep', generation_focus: focus })
      requestId = body.request_id
    } else expect(path).toBe(endpoint + '/' + requestId)
    return { ...fixture, plan_date: nextDate, request_id: requestId, generation_focus: focus,
      sections: { judgment: '下一交易日观察量能。' } }
  }, () => upcoming)
  const user = userEvent.setup()
  render(<OpeningPlanPage />)
  await screen.findByRole('button', { name: 'AI生成' })
  expect(screen.getByLabelText('计划日期')).toHaveValue(planDate)
  fill('今日核心判断', '原日期的草稿。')
  await user.click(screen.getByRole('button', { name: '深度' }))
  await user.click(screen.getByText('关注点（Prompt）', { selector: 'summary' }))
  fill('关注点（Prompt）', focus)
  upcoming = nextDate
  await collectPlan(user)
  await waitFor(() => expect(screen.getByLabelText('今日核心判断')).toHaveValue('下一交易日观察量能。'))
  expect(screen.getByLabelText('计划日期')).toHaveValue(nextDate)
  expect(screen.getByText(`已提交关注点 · ${focus}`)).toBeVisible()
  expect(screen.getByRole('button', { name: '深度' })).toHaveAttribute('aria-pressed', 'true')
  fill('计划日期', planDate)
  expect(screen.getByLabelText('今日核心判断')).toHaveValue('原日期的草稿。')
  expect(vi.mocked(api).mock.calls.filter(([path, init]) => path === endpoint && init?.method === 'POST')).toHaveLength(1)
})

it('fills untouched sections, preserves edits and leaves the source available for review', async () => {
  let id = ''
  let resolve!: (value: unknown) => void
  const collected = new Promise(resolveResult => { resolve = resolveResult })
  mockApi(async (path, init) => {
    if (path === endpoint) {
      const request = JSON.parse(String(init?.body))
      id = request.request_id
      expect(request).toEqual({ request_id: id, plan_date: planDate, model_mode: 'deep' })
      return { ...fixture, request_id: id, state: 'awaiting_agent' }
    }
    expect(path).toBe(endpoint + '/' + id)
    return collected
  })
  const user = userEvent.setup()
  const page = render(<OpeningPlanPage />)
  fill('计划日期', planDate)
  await user.click(screen.getByRole('button', { name: '深度' }))
  await collectPlan(user)
  await screen.findByRole('button', { name: '停止生成' })
  fill('今日核心判断', '用户手写判断。')
  fill('今日风控', '用户填写仓位口径。')
  await act(async () => resolve({ ...fixture, request_id: id }))
  await waitFor(() => expect(screen.getByLabelText('隔夜与昨日')).toHaveValue(fixture.sections.overnight))
  expect(screen.getByLabelText('今日核心判断')).toHaveValue('用户手写判断。')
  expect(screen.getByLabelText('今日风控')).toHaveValue('用户填写仓位口径。')
  await user.click(screen.getByText('采集资料与来源'))
  expect(screen.getByRole('link', { name: '市场原文' })).toHaveAttribute('href', fixture.sources[0].url)
  await user.click(screen.getByRole('button', { name: '文案' }))
  expect(screen.getByLabelText('可复制的开盘计划')).not.toHaveTextContent(fixture.sources[0].url)
  await user.click(screen.getByRole('button', { name: '填入今日核心判断' }))
  expect(screen.getByLabelText('今日核心判断')).toHaveValue(fixture.sections.judgment)

  fill('隔夜与昨日', '')
  page.unmount()
  render(<OpeningPlanPage />)
  await screen.findByText('采集资料与来源')
  expect(screen.getByLabelText('隔夜与昨日')).toHaveValue('')
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1)
})

it('applies a pending result only to its own plan date', async () => {
  let id = ''
  let resolve!: (value: unknown) => void
  const collected = new Promise(resolveResult => { resolve = resolveResult })
  mockApi(async (path, init) => {
    if (path === endpoint) {
      id = JSON.parse(String(init?.body)).request_id
      return { ...fixture, request_id: id, state: 'awaiting_agent' }
    }
    return collected
  })
  const user = userEvent.setup()
  render(<OpeningPlanPage />)
  fill('计划日期', planDate)
  await collectPlan(user)
  await screen.findByRole('button', { name: '停止生成' })
  fill('计划日期', '2026-11-18')
  await act(async () => resolve({ ...fixture, request_id: id }))
  expect(screen.getByLabelText('隔夜与昨日')).toHaveValue('')
  fill('计划日期', planDate)
  await waitFor(() => expect(screen.getByLabelText('隔夜与昨日')).toHaveValue(fixture.sections.overnight))
})

it('fills available market data when the online collection is incomplete', async () => {
  const message = 'AI 采集未完成。已填入可核对的本地日线。'
  let id = ''
  mockApi(async (path, init) => {
    if (path === endpoint) {
      id = JSON.parse(String(init?.body)).request_id
      return { ...fixture, request_id: id, state: 'awaiting_agent' }
    }
    return { ...fixture, request_id: id, message, state: 'partial', sources: [],
      sections: { overnight: fixture.sections.overnight } }
  })
  const user = userEvent.setup()
  render(<OpeningPlanPage />)
  fill('计划日期', planDate)
  await collectPlan(user)
  await screen.findByText(message)
  expect(screen.getByLabelText('隔夜与昨日')).toHaveValue(fixture.sections.overnight)
  expect(screen.getByLabelText('今日核心判断')).toHaveValue('')
})

it('previews and exports the selected artwork, and saves a dated card apart from the default template', async () => {
  let template = defaultEditor.template
  let saved: typeof template | null = null
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === endpoint + '/default-date') return { plan_date: planDate }
    if (path.startsWith(endpoint + '/preview')) return { image: png, width: 1080, height: 1660, regions: [] }
    if (init?.method === 'PUT') {
      const submitted = JSON.parse(String(init.body))
      const value = { ...submitted, revision: submitted.revision + 1 }
      if (path.endsWith('/template')) template = value
      else saved = value
      return value
    }
    return { template, saved: path.endsWith(planDate) ? saved : null }
  })
  const user = userEvent.setup()
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<OpeningPlanPage />)
  fill('计划日期', planDate)
  await screen.findByRole('img', { name: '开盘计划图片预览' })
  expect(screen.getByRole('button', { name: '东吴证券蓝' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: '下载草稿图片' })).toBeDisabled()
  fill('今日核心判断', '关注成交量。')
  await user.click(screen.getByRole('button', { name: '冰蓝科技' }))
  await user.click(screen.getByRole('button', { name: '保存为默认模板' }))
  await screen.findByText('默认模板已保存，未保存的日期会使用此模板')
  fill('今日核心判断', '当天补充观察量能。')
  await user.click(screen.getByRole('button', { name: '保存本次卡片' }))
  await screen.findByRole('region', { name: '成品预览' })
  const exportButton = screen.getByRole('button', { name: '下载图片' })
  await waitFor(() => expect(exportButton).toBeEnabled())
  await user.click(exportButton)
  expect(download).toHaveBeenCalledOnce()
  expect((download.mock.contexts[0] as HTMLAnchorElement).download).toBe(`开盘计划-${planDate}.png`)
  download.mockRestore()
  expect(vi.mocked(api).mock.calls.some(([path, init]) => path === endpoint + '/preview'
    && JSON.parse(String(init?.body)).theme === 'jade')).toBe(true)
  fill('计划日期', '2026-11-18')
  await waitFor(() => expect(screen.getByLabelText('今日核心判断')).toHaveValue('关注成交量。'))
  fill('计划日期', planDate)
  await waitFor(() => expect(screen.getByLabelText('今日核心判断')).toHaveValue('当天补充观察量能。'))
})
