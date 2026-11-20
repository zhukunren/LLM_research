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
  cutoff: '2026-11-20T16:00:00+08:00', message: '采集完成',
  reason: '样例研报指出，电子材料是营收增长的主要贡献来源。',
  basis: '参考研报：《样例公司季度点评》 研报作者：样例证券 示例作者，发布日期 2026年10月29日。',
  report: { document_id: 'sample-report', title: '样例公司季度点评', broker: '样例证券', authors: '示例作者', publication_date: '2026-10-29' },
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
  vi.mocked(api).mockResolvedValue(catalog)
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
  expect(vi.mocked(api).mock.calls.every(([path]) => path === '/security-catalog')).toBe(true)
})

it('fills the collected report, lets the user edit it and copies plain text without URLs', async () => {
  let id = ''
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/security-catalog') return catalog
    if (path === endpoint) {
      const payload = JSON.parse(String(init?.body))
      id = payload.request_id
      expect(payload).toEqual({ request_id: id, code: '603650.SH', direction: '开仓买入' })
      return { ...fixture, request_id: id, state: 'awaiting_agent' }
    }
    expect(path).toBe(endpoint + '/' + id)
    return { ...fixture, request_id: id }
  })
  const { user, clipboard, view } = setup()
  fields('603650.SH', '开仓买入', '0%', '5', '46.70')
  await user.click(screen.getByRole('button', { name: 'AI 采集研报' }))
  await waitFor(() => expect(screen.getByLabelText(/^调仓理由/)).toHaveValue(fixture.reason))
  expect(screen.getByLabelText(/^调仓依据/)).toHaveValue(fixture.basis)
  await user.click(screen.getByText('已采集研报', { selector: 'summary' }))
  expect(screen.getByRole('link', { name: '打开研报原文' })).toHaveAttribute('href', '/api/v1/documents/sample-report/pdf')
  fill(/^调仓理由/, '复核[公告](https://example.com/report)后，继续观察电子材料。')
  fill('调仓后（%）', '5.5')
  await user.click(screen.getByRole('button', { name: '复制文案' }))
  const text = clipboard.mock.lastCall?.[0]
  expect(text).toContain('股票名称：彤程新材 603650\n调仓方向：开仓买入\n仓位变化：0%—5.5%\n参考价格：46.70')
  expect(text).toContain('调仓理由：复核公告后，继续观察电子材料。')
  expect(text).toContain('调仓依据：' + fixture.basis)
  expect(text).not.toContain('example.com')
  expect(text?.endsWith(disclosureLines.join('\n'))).toBe(true)

  view.unmount()
  render(<SecuritiesProvider><RebalanceSuggestionPage /></SecuritiesProvider>)
  await screen.findByText('已采集研报')
  expect(screen.getByLabelText(/^调仓理由/)).toHaveValue('复核[公告](https://example.com/report)后，继续观察电子材料。')
  expect(screen.getByLabelText('调仓后（%）')).toHaveValue('5.5')
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1)
})

it('preserves text edited during collection until the user applies the collected draft', async () => {
  let id = '', finish!: (value: unknown) => void
  const reply = new Promise(resolve => { finish = resolve })
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/security-catalog') return catalog
    if (path === endpoint) {
      id = JSON.parse(String(init?.body)).request_id
      return { ...fixture, request_id: id, state: 'awaiting_agent' }
    }
    return reply
  })
  const { user } = setup()
  fields('603650', '开仓买入', '0', '5', '46.70')
  await user.click(screen.getByRole('button', { name: 'AI 采集研报' }))
  await screen.findByRole('button', { name: '停止采集' })
  fill(/^调仓理由/, '用户已写好的内容')
  await act(async () => finish({ ...fixture, request_id: id }))
  expect(screen.getByLabelText(/^调仓理由/)).toHaveValue('用户已写好的内容')
  expect(screen.getByLabelText(/^调仓依据/)).toHaveValue('')
  await user.click(screen.getByText('已采集研报', { selector: 'summary' }))
  await user.click(screen.getByRole('button', { name: '填入理由和依据' }))
  expect(screen.getByLabelText(/^调仓理由/)).toHaveValue(fixture.reason)
  expect(screen.getByLabelText(/^调仓依据/)).toHaveValue(fixture.basis)
})
