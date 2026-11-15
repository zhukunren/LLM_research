import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import { beijingDate, type CardContent, type ServiceCard, type ServiceSettings } from '../clientService'
import ClientServicePage from './ClientServicePage'

vi.mock('../api', () => ({ api: vi.fn() }))
const content: CardContent = { brand: '锦绣成长', headline: '', conclusion: '', action: '', focus: '', service: '联系投顾', risk: '市场有风险', adviser: '测试投顾', license: 'TEST123' }
const slots = [['preopen', '盘前简报', '08:45'], ['opening', '开盘观察', '09:45'], ['checkpoint', '关键时点', '10:30'], ['midday', '午间观察', '11:35'], ['late', '尾盘观察', '14:30'], ['close', '收盘总结', '15:30']]
const config: ServiceSettings = { revision: 0, enabled: false, timezone: 'Asia/Shanghai', weekdays: [0, 1, 2, 3, 4], templates: slots.map(([id, title, time]) => ({ id, title, time, enabled: true, content })) }
const initialCard: ServiceCard = {
  id: '00000000-0000-4000-8000-000000000001', service_date: beijingDate(), slot_id: 'checkpoint', cutoff: beijingDate() + 'T10:30:00+08:00', revision: 0,
  state: 'ready', message: '已采集', template: config.templates[2], content, updated_at: '',
  market: { summary: '市场走势分化。', quality: 'verified', cutoff: beijingDate() + 'T10:30:00+08:00',
    metrics: [{ label: '上证指数', value: '3600.00', observed_at: beijingDate() + 'T10:30:00+08:00', source_url: 'https://www.sse.com.cn' }],
    sources: [{ title: '交易所原文', url: 'https://www.sse.com.cn', published_at: null }], limitations: [] },
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(initialCard.service_date + 'T16:00:00+08:00')) })
afterEach(() => vi.useRealTimers())

function setup({ failPreview = false } = {}) {
  let card = structuredClone(initialCard), settings = structuredClone(config), previews = 0
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/client-service/settings') {
      if (init?.method === 'PUT') { settings = { ...JSON.parse(String(init.body)), revision: settings.revision + 1 } }
      return structuredClone(settings)
    }
    if (path.startsWith('/client-service/cards?')) return { items: path.includes(beijingDate()) ? [structuredClone(card)] : [] }
    if (path === '/client-service/cards') { card = { ...card, state: 'awaiting_agent' }; return structuredClone(card) }
    if (path.startsWith('/client-service/cards/') && init?.method === 'PUT') {
      card = { ...card, content: JSON.parse(String(init.body)).content, revision: card.revision + 1 }
      return structuredClone(card)
    }
    if (path === '/client-service/preview') {
      if (failPreview && JSON.parse(String(init?.body)).content.conclusion) throw new Error('预览失败')
      return { image: 'data:image/png;base64,preview' + (++previews), width: 1080, height: 1440 }
    }
    throw new Error('Unexpected request: ' + path)
  })
  return render(<ClientServicePage />)
}

it('loads the six time slots and source-checked market state without starting a model call', async () => {
  setup()
  const slots = await screen.findByRole('navigation', { name: '服务时点' })
  expect(within(slots).getAllByRole('button')).toHaveLength(6)
  expect(await screen.findByRole('region', { name: '市场来源与时点' })).toHaveTextContent('3600.00')
  expect(screen.getByRole('link', { name: '交易所原文' })).toHaveAttribute('href', 'https://www.sse.com.cn')
  expect(screen.queryByRole('textbox', { name: '市场状态' })).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.some(([path, init]) => path === '/client-service/cards' && init?.method === 'POST')).toBe(false)
})

it('syncs edited copy into the image preview and saves it without changing the collected market', async () => {
  const user = userEvent.setup(); setup()
  const field = await screen.findByRole('textbox', { name: '今日判断' })
  await user.type(field, '用户编辑的新判断')
  await waitFor(() => expect(screen.getByRole('button', { name: '下载 PNG' })).toBeEnabled())
  const previews = vi.mocked(api).mock.calls.filter(([path]) => path === '/client-service/preview')
  expect(JSON.parse(String(previews.at(-1)?.[1]?.body)).content.conclusion).toBe('用户编辑的新判断')
  await user.click(screen.getByRole('button', { name: '保存本次卡片' }))
  expect(await screen.findByRole('status')).toHaveTextContent('本次卡片已保存')
  const saved = vi.mocked(api).mock.calls.find(([path, init]) => path.includes('/cards/') && init?.method === 'PUT')
  const body = JSON.parse(String(saved?.[1]?.body))
  expect(body.revision).toBe(0)
  expect(body.content.conclusion).toBe('用户编辑的新判断')
  expect(body.market).toBeUndefined()
  expect(screen.getByRole('region', { name: '市场来源与时点' })).toHaveTextContent('3600.00')
})

it('preserves unsaved copy when switching slots and updates only the selected default template', async () => {
  const user = userEvent.setup(); setup()
  await user.type(await screen.findByRole('textbox', { name: '今日判断' }), '保留此时点草稿')
  const slots = screen.getByRole('navigation', { name: '服务时点' })
  await user.click(within(slots).getByRole('button', { name: /盘前简报/ }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('')
  await user.click(within(slots).getByRole('button', { name: /关键时点/ }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('保留此时点草稿')
  await user.click(screen.getByRole('button', { name: '保存为默认模板' }))
  await screen.findByText('默认模板和生成计划已保存')
  const saved = vi.mocked(api).mock.calls.find(([path, init]) => path.endsWith('/settings') && init?.method === 'PUT')
  const settings = JSON.parse(String(saved?.[1]?.body))
  expect(settings.templates[2].content.conclusion).toBe('保留此时点草稿')
  expect(settings.templates[0].content.conclusion).toBe('')
})

it('saves the Beijing schedule and starts research only on explicit collection', async () => {
  const user = userEvent.setup(); setup()
  await screen.findByRole('textbox', { name: '今日判断' })
  await user.click(screen.getByRole('checkbox', { name: '开启每日自动生成' }))
  fireEvent.change(screen.getByLabelText('关键时点生成时间'), { target: { value: '10:35' } })
  await user.click(screen.getByRole('button', { name: '保存模板和计划' }))
  await screen.findByText('默认模板和生成计划已保存')
  const saved = vi.mocked(api).mock.calls.find(([path, init]) => path.endsWith('/settings') && init?.method === 'PUT')
  const settings = JSON.parse(String(saved?.[1]?.body))
  expect(settings.enabled).toBe(true)
  expect(settings.timezone).toBe('Asia/Shanghai')
  expect(settings.templates[2].time).toBe('10:35')
  await user.click(screen.getByRole('button', { name: '重新采集市场状态' }))
  await screen.findByText('采集已开始，关闭页面后任务仍会继续')
  const generated = vi.mocked(api).mock.calls.find(([path, init]) => path === '/client-service/cards' && init?.method === 'POST')
  expect(JSON.parse(String(generated?.[1]?.body))).toMatchObject({ date: beijingDate(), slot_id: 'checkpoint', regenerate: true })
})

it('does not allow downloading an old preview after a newer edit fails', async () => {
  const user = userEvent.setup(); setup({ failPreview: true })
  await waitFor(() => expect(screen.getByRole('button', { name: '下载 PNG' })).toBeEnabled())
  await user.type(screen.getByRole('textbox', { name: '今日判断' }), '触发新的预览')
  expect(await screen.findByRole('alert')).toHaveTextContent('预览失败')
  expect(screen.getByRole('button', { name: '下载 PNG' })).toBeDisabled()
})
