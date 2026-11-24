import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import { sessionStorage } from '../authStorage'
import { disclosureLines } from '../clientService'
import { SecuritiesProvider } from '../components/StockSearch'
import RebalanceSuggestionPage from './RebalanceSuggestionPage'

vi.mock('../api', async original => ({ ...await original<typeof import('../api')>(), api: vi.fn() }))

const endpoint = '/client-service/rebalance-suggestions'
const catalog = { items: [
  { stock_code: '603650.SH', name: '彤程新材', market: 'SH' },
  { stock_code: '688012.SH', name: '中微公司', market: 'SH' },
] }
const fixture = {
  state: 'succeeded', code: '603650.SH', stock_name: '彤程新材', direction: '开仓买入',
  cutoff: '2026-11-20T16:00:00+08:00', message: '理由已生成',
  reason: '样例公告指出，电子材料是营收增长的主要贡献来源。',
  basis: '参考资料：《公司经营公告》（2026-10-29）',
  report: null,
  sources: [{ title: '公司经营公告', url: 'https://example.com/disclosure', published_at: '2026-10-29', quote: '公开资料原文。' }],
}
const quote = { code: '603650.SH', price: '46.70', observed_at: '2026-11-20T10:20:00+08:00', source: '腾讯行情', kind: 'live' }
const preview = {
  image: '/mock-rebalance.png', width: 1080, height: 1300,
  regions: [{ key: 'price', label: '参考价格', x: 15, y: 40, width: 300, height: 50, max: 18, value: '46.70', color: '#123456' }],
}

function supportingResponse(path: string) {
  if (path === '/security-catalog') return catalog
  if (path.startsWith(endpoint + '/quote?')) return quote
  if (path === endpoint + '/preview') return preview
  return undefined
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  sessionStorage.removeItem('client-service.rebalance.draft')
  sessionStorage.removeItem('client-service.rebalance.request')
})

const fill = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

function setup() {
  const user = userEvent.setup()
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
  const view = render(<SecuritiesProvider><RebalanceSuggestionPage /></SecuritiesProvider>)
  return { user, clipboard, view }
}

function fields(code: string, direction: string, before: string, after: string, price: string) {
  fill('股票代码', code)
  fill('调仓方向', direction)
  fill('调仓前（%）', before)
  fill('调仓后（%）', after)
  fill('参考价格', price)
}

it('copies a manual exit template with the fixed disclosure and optional paragraphs omitted', async () => {
  vi.mocked(api).mockImplementation(async path => supportingResponse(path))
  const { user, clipboard } = setup()
  const copy = screen.getByRole('button', { name: '复制文案' })
  expect(copy).toBeDisabled()
  fields('688012', '止盈调出', '6', '101', '262.00')
  await waitFor(() => expect(screen.getByLabelText('股票名称')).toHaveValue('中微公司'))
  expect(copy).toBeDisabled()
  fill('调仓后（%）', '0')
  await user.click(copy)
  expect(clipboard).toHaveBeenCalledWith([
    '投顾产品：丰收成长尊享（全账户）', '股票名称：中微公司 688012', '调仓方向：止盈调出',
    '仓位变化：6%—0%', '参考价格：262.00', '', ...disclosureLines,
  ].join('\n'))
  expect(vi.mocked(api).mock.calls.some(([path]) => path === endpoint)).toBe(false)
})

it('fills the chosen model draft, opens independent sources and copies plain text without URLs', async () => {
  let id = ''
  const focus = '优先核对最新公告。'
  vi.mocked(api).mockImplementation(async (path, init) => {
    const supporting = supportingResponse(path)
    if (supporting) return supporting
    if (path === endpoint) {
      const payload = JSON.parse(String(init?.body))
      id = payload.request_id
      expect(payload).toEqual({ request_id: id, code: '603650.SH', direction: '开仓买入', mode: 'deep', generation_focus: focus })
      return { ...fixture, request_id: id, state: 'awaiting_agent', mode: 'deep', generation_focus: focus }
    }
    expect(path).toBe(endpoint + '/' + id)
    return { ...fixture, request_id: id, mode: 'deep', generation_focus: focus }
  })
  const { user, clipboard, view } = setup()
  fields('603650.SH', '开仓买入', '0%', '5', '46.70')
  expect(screen.getByRole('button', { name: '即时' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: '深度' }))
  expect(screen.getByRole('button', { name: '深度' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByText('关注点（Prompt）', { selector: 'summary' }))
  fill('关注点（Prompt）', ` ${focus} `)
  await user.click(screen.getByRole('button', { name: 'AI生成' }))
  await waitFor(() => expect(screen.getByLabelText(/^调仓理由/)).toHaveValue(fixture.reason))
  expect(screen.getByText(`已提交关注点 · ${focus}`)).toBeVisible()
  await user.click(screen.getByRole('button', { name: '查看依据' }))
  expect(screen.getByRole('textbox', { name: '依据文案' })).toHaveValue(fixture.basis)
  expect(screen.getByRole('link', { name: '公司经营公告' })).toHaveAttribute('href', fixture.sources[0].url)
  await user.click(screen.getByRole('button', { name: '关闭调仓依据' }))
  fill(/^调仓理由/, '复核[公告](https://example.com/report)后，继续观察电子材料。')
  fill('调仓后（%）', '5.5')
  await user.click(screen.getByRole('button', { name: '复制文案' }))
  const text = clipboard.mock.lastCall?.[0]
  expect(text).toContain('股票名称：彤程新材 603650\n调仓方向：开仓买入\n仓位变化：0%—5.5%\n参考价格：46.70')
  expect(text).toContain('调仓理由：复核公告后，继续观察电子材料。')
  expect(text).toContain('调仓依据：' + fixture.basis)
  expect(text).not.toContain('example.com')
  expect(text).not.toContain(focus)
  expect(text?.endsWith(disclosureLines.join('\n'))).toBe(true)

  view.unmount()
  render(<SecuritiesProvider><RebalanceSuggestionPage /></SecuritiesProvider>)
  await screen.findByText('理由已生成')
  expect(screen.getByText(`已提交关注点 · ${focus}`)).toBeVisible()
  expect(screen.getByLabelText(/^调仓理由/)).toHaveValue('复核[公告](https://example.com/report)后，继续观察电子材料。')
  expect(screen.getByLabelText('调仓后（%）')).toHaveValue('5.5')
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1)
})

it('preserves text edited during collection until the user applies the collected draft', async () => {
  let id = '', finish!: (value: unknown) => void
  const reply = new Promise(resolve => { finish = resolve })
  vi.mocked(api).mockImplementation(async (path, init) => {
    const supporting = supportingResponse(path)
    if (supporting) return supporting
    if (path === endpoint) {
      id = JSON.parse(String(init?.body)).request_id
      expect(JSON.parse(String(init?.body)).mode).toBe('instant')
      return { ...fixture, request_id: id, state: 'awaiting_agent', mode: 'instant' }
    }
    return reply
  })
  const { user } = setup()
  fields('603650', '开仓买入', '0', '5', '46.70')
  await user.click(screen.getByRole('button', { name: 'AI生成' }))
  await screen.findByRole('button', { name: '停止生成' })
  fill(/^调仓理由/, '用户已写好的内容')
  await act(async () => finish({ ...fixture, request_id: id, mode: 'instant' }))
  expect(screen.getByLabelText(/^调仓理由/)).toHaveValue('用户已写好的内容')
  await user.click(screen.getByRole('button', { name: '查看本次 AI 草稿' }))
  expect(screen.getByRole('textbox', { name: '依据文案' })).toHaveValue('')
  await user.click(screen.getByRole('button', { name: '填入理由和依据' }))
  expect(screen.getByLabelText(/^调仓理由/)).toHaveValue(fixture.reason)
  expect(screen.getByRole('textbox', { name: '依据文案' })).toHaveValue(fixture.basis)
})

it('defaults to the timed quote, applies a different image theme and edits the price from the image', async () => {
  vi.mocked(api).mockImplementation(async path => supportingResponse(path))
  const { user } = setup()
  expect(await screen.findByRole('img', { name: '调仓建议图片预览' })).toBeVisible()
  const defaultTheme = screen.getByRole('button', { name: '东吴证券蓝' })
  expect(defaultTheme).toHaveAttribute('aria-pressed', 'true')
  expect(defaultTheme.querySelector('img')).toHaveAttribute('src', '/client-service/rebalance-themes/soochow.png')
  expect(screen.getByLabelText('股票代码')).toHaveValue('')
  expect(screen.getByRole('button', { name: '下载图片' })).toBeDisabled()
  fields('603650', '开仓买入', '0', '5', '')
  await waitFor(() => expect(screen.getByLabelText('参考价格')).toHaveValue('46.70'))
  expect(screen.getByText(/实时行情.*腾讯行情/)).toBeVisible()
  expect(screen.getByRole('form', { name: '模板编辑' })).toBeVisible()
  expect(screen.getByRole('region', { name: '草稿预览' })).toBeVisible()
  expect(screen.getByRole('complementary', { name: '调仓卡片底图' })).toBeVisible()
  expect(screen.getByRole('button', { name: '冰蓝科技' }).querySelector('img'))
    .toHaveAttribute('src', '/client-service/rebalance-themes/jade.png')
  await user.click(screen.getByRole('button', { name: '冰蓝科技' }))
  await waitFor(() => expect(vi.mocked(api).mock.calls.some(([path, init]) =>
    path === endpoint + '/preview' && JSON.parse(String(init?.body)).theme === 'jade',
  )).toBe(true))
  await user.click(await screen.findByRole('button', { name: '编辑图片中的参考价格' }))
  fill('图片中的参考价格', '47.00')
  await user.click(screen.getByRole('button', { name: '确认修改' }))
  expect(screen.getByLabelText('参考价格')).toHaveValue('47.00')
  expect(screen.queryByText(/实时行情.*腾讯行情/)).not.toBeInTheDocument()
})
