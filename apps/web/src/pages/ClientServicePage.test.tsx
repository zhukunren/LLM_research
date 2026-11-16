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
      const current = JSON.parse(String(init?.body)).content
      return { image: 'data:image/png;base64,preview' + (++previews), width: 1080, height: 1440, regions: [
        {key:'conclusion',label:'今日判断',x:98,y:500,width:908,height:106,max:160,value:current.conclusion,color:'#153c60'},
        {key:'market.summary',label:'市场摘要',x:72,y:720,width:936,height:86,max:600,value:current.market_overrides?.summary || '市场走势分化。',color:'#153c60'},
      ] }
    }
    throw new Error('Unexpected request: ' + path)
  })
  return render(<ClientServicePage />)
}

it('loads the six time slots and source-checked market state without starting a model call', async () => {
  setup()
  const slots = await screen.findByRole('navigation', { name: '服务时点' })
  expect(within(slots).getAllByRole('button')).toHaveLength(7)
  expect(within(slots).getAllByRole('button')[0]).toHaveAccessibleName('实时股评卡片')
  await userEvent.click(await screen.findByText('市场来源与时点', { selector: 'summary' }))
  expect(screen.getByRole('region', { name: '市场来源与时点' })).toHaveTextContent('3600.00')
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
  await user.click(screen.getByText('市场来源与时点', { selector: 'summary' }))
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
  await screen.findByText('默认模板已保存，今后此时点沿用当前文案')
  const saved = vi.mocked(api).mock.calls.find(([path, init]) => path.endsWith('/settings') && init?.method === 'PUT')
  const settings = JSON.parse(String(saved?.[1]?.body))
  expect(settings.templates[2].content.conclusion).toBe('保留此时点草稿')
  expect(settings.templates[0].content.conclusion).toBe('')
})

it('saves the Beijing schedule and starts research only on explicit collection', async () => {
  const user = userEvent.setup(); setup()
  await screen.findByRole('textbox', { name: '今日判断' })
  await user.click(screen.getByRole('button', { name: '设置每日生成计划' }))
  await user.click(screen.getByRole('checkbox', { name: '开启每日自动生成' }))
  fireEvent.change(screen.getByLabelText('关键时点生成时间'), { target: { value: '10:35' } })
  await user.click(screen.getByRole('button', { name: '保存生成计划' }))
  await screen.findByText('自动生成计划已保存')
  const saved = vi.mocked(api).mock.calls.find(([path, init]) => path.endsWith('/settings') && init?.method === 'PUT')
  const settings = JSON.parse(String(saved?.[1]?.body))
  expect(settings.enabled).toBe(true)
  expect(settings.timezone).toBe('Asia/Shanghai')
  expect(settings.templates[2].time).toBe('10:35')
  await user.click(screen.getByRole('button', { name: '关闭生成计划' }))
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

it('keeps schedule saves separate from the selected card draft', async () => {
  const user = userEvent.setup(); setup()
  await user.type(await screen.findByRole('textbox', { name: '今日判断' }), '仅用于今天的判断')
  await user.click(screen.getByRole('button', { name: '设置每日生成计划' }))
  fireEvent.change(screen.getByLabelText('关键时点生成时间'), { target: { value: '10:50' } })
  await user.click(screen.getByRole('button', { name: '关闭生成计划' }))
  await user.click(screen.getByRole('button', { name: '保存为默认模板' }))
  await screen.findByText('默认模板已保存，今后此时点沿用当前文案')
  let saves = vi.mocked(api).mock.calls.filter(([path, init]) => path.endsWith('/settings') && init?.method === 'PUT')
  expect(JSON.parse(String(saves[0][1]?.body)).templates[2].time).toBe('10:30')
  await user.clear(screen.getByRole('textbox', { name: '今日判断' }))
  await user.type(screen.getByRole('textbox', { name: '今日判断' }), '不要存为默认的草稿')
  await user.click(screen.getByRole('button', { name: '设置每日生成计划' }))
  expect(screen.getByLabelText('关键时点生成时间')).toHaveValue('10:50')
  await user.click(screen.getByRole('button', { name: '保存生成计划' }))
  await screen.findByText('自动生成计划已保存')
  saves = vi.mocked(api).mock.calls.filter(([path, init]) => path.endsWith('/settings') && init?.method === 'PUT')
  expect(JSON.parse(String(saves[1][1]?.body)).templates[2]).toMatchObject({ time: '10:50', content: { conclusion: '仅用于今天的判断' } })
  await user.click(screen.getByRole('button', { name: '关闭生成计划' }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('不要存为默认的草稿')
})

it('restores saved content and can undo without losing the draft', async () => {
  const user = userEvent.setup(); setup()
  await user.type(await screen.findByRole('textbox', { name: '今日判断' }), '保留草稿')
  await user.click(screen.getByRole('button', { name: '恢复' }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('')
  await user.click(screen.getByRole('button', { name: '撤销' }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('保留草稿')
})

it('shows the current copy in text mode and rejects an empty service name', async () => {
  const user = userEvent.setup(); setup()
  await user.type(await screen.findByRole('textbox', { name: '今日判断' }), '即时编辑的判断')
  await user.click(screen.getByRole('button', { name: '文案' }))
  expect(screen.getByLabelText('文案预览')).toHaveTextContent('即时编辑的判断')
  expect(screen.getByLabelText('文案预览')).toHaveTextContent('来源：交易所原文')
  await user.clear(screen.getByRole('textbox', { name: '服务名称' }))
  expect(screen.getByRole('textbox', { name: '服务名称' })).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByRole('button', { name: '下载 PNG' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '保存本次卡片' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '保存为默认模板' })).toBeDisabled()
})

it('preserves drafts across dates and prevents collection for future slots', async () => {
  const user = userEvent.setup(); setup()
  await user.type(await screen.findByRole('textbox', { name: '今日判断' }), '今天草稿')
  await user.click(screen.getByRole('button', { name: '后一天' }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('')
  expect(screen.getByRole('button', { name: '采集市场状态' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '今天' }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('今天草稿')
})

it('can retry a failed preview without editing or losing content', async () => {
  const user = userEvent.setup(); setup({ failPreview: true })
  await user.type(await screen.findByRole('textbox', { name: '今日判断' }), '保留内容')
  await screen.findByRole('alert')
  const before = vi.mocked(api).mock.calls.filter(([path]) => path === '/client-service/preview').length
  await user.click(screen.getByRole('button', { name: '重试预览' }))
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/client-service/preview').length).toBeGreaterThan(before))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('保留内容')
})

it('downloads the latest completed preview with the selected date and slot', async () => {
  const user = userEvent.setup(); setup()
  const downloads: { href: string; filename: string }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, filename: this.download })
  })
  await waitFor(() => expect(screen.getByRole('button', { name: '下载 PNG' })).toBeEnabled())
  const first = screen.getByRole('img', { name: /时点卡预览/ }).getAttribute('src')
  await user.type(screen.getByRole('textbox', { name: '今日判断' }), '更新后的导出文案')
  expect(screen.getByRole('button', { name: '下载 PNG' })).toBeDisabled()
  await waitFor(() => expect(screen.getByRole('button', { name: '下载 PNG' })).toBeEnabled())
  const latest = screen.getByRole('img', { name: /时点卡预览/ }).getAttribute('src')
  expect(latest).not.toBe(first)
  await user.click(screen.getByRole('button', { name: '下载 PNG' }))
  expect(downloads).toEqual([{ href: latest, filename: `market-card-${beijingDate()}-checkpoint.png` }])
})


it('opens the generation schedule in a right drawer and restores editor focus on close', async () => {
  const user = userEvent.setup(); setup()
  await screen.findByRole('textbox', { name: '今日判断' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '设置每日生成计划' }))
  expect(screen.getByRole('dialog', { name: '每日生成计划' })).toHaveClass('condition-workspace-drawer')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '设置每日生成计划' })).toHaveFocus()
})

it('starts an independent instant briefing and selects it without overwriting a scheduled draft', async () => {
  const user = userEvent.setup(); setup()
  await user.type(await screen.findByRole('textbox', { name: '今日判断' }), '固定时点草稿')
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, init) => path === '/client-service/briefs' ? {
    ...initialCard, id: 'instant-id', slot_id: 'live-12345678901234567890123456789012',
    cutoff: beijingDate() + 'T16:00:00+08:00', state: 'awaiting_agent', market: null,
    content: { ...content, conclusion: '' }, template: { ...config.templates[2], id: 'live-12345678901234567890123456789012', title: '即时简报', time: '16:00' },
  } : original(path, init))
  await user.click(screen.getByRole('button', { name: '实时股评卡片' }))
  await user.click(screen.getByRole('button', { name: '生成即时简报' }))
  expect(await screen.findByRole('region', { name: '即时简报记录' })).toHaveTextContent('16:00:00')
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('')
  expect(screen.getByRole('button', { name: '保存为默认模板' })).toBeDisabled()
  await user.click(within(screen.getByRole('navigation', { name: '服务时点' })).getByRole('button', { name: /关键时点/ }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('固定时点草稿')
  const call = vi.mocked(api).mock.calls.find(([path]) => path === '/client-service/briefs')
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({theme:'river'})
})

it('merges generated fields into an in-progress draft without replacing user edits', async () => {
  const user = userEvent.setup(); setup()
  await screen.findByRole('textbox', { name: '今日判断' })
  const original = vi.mocked(api).getMockImplementation()!
  const live = { ...initialCard, id: 'live-merge', slot_id: 'live-12345678901234567890123456789012', state: 'running', market: null, revision: 0, content: { ...content }, template: { ...config.templates[2], id: 'live-12345678901234567890123456789012', title: '即时简报' } }
  let completed = false
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/client-service/briefs') return structuredClone(live)
    if (path.startsWith('/client-service/cards?')) return { items: [initialCard, completed ? { ...live, state: 'ready', revision: 1, content: { ...content, headline: '自动生成标题', conclusion: '自动判断', action: '自动观察安排', focus: '自动观察重点' } } : live] }
    return original(path, init)
  })
  await user.click(screen.getByRole('button', { name: '实时股评卡片' }))
  await user.click(screen.getByRole('button', { name: '生成即时简报' }))
  await screen.findByRole('region', { name: '即时简报记录' })
  await user.type(screen.getByRole('textbox', { name: '今日判断' }), '用户正在写的判断')
  completed = true
  await waitFor(() => expect(screen.getByRole('textbox', { name: '行动安排' })).toHaveValue('自动观察安排'), { timeout: 6500 })
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('用户正在写的判断')
  expect(screen.getByRole('textbox', { name: '卡片标题' })).toHaveValue('自动生成标题')
}, 8000)

it('switches theme previews, saves the card theme and retains unsaved choices per slot', async () => {
  const user = userEvent.setup(); setup()
  await screen.findByRole('textbox', { name: '今日判断' })
  expect(within(screen.getByRole('region', { name: '图片预览' })).getByRole('complementary', { name: '卡片套图' })).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '卡片编辑' })).queryByRole('complementary', { name: '卡片套图' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '锦绣江岸' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: '上一套底图' }))
  expect(screen.getByRole('button', { name: '铂银建筑' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: '下一套底图' }))
  expect(screen.getByRole('button', { name: '锦绣江岸' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: '冰蓝科技' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '下载 PNG' })).toBeEnabled())
  const previews = vi.mocked(api).mock.calls.filter(([path]) => path === '/client-service/preview')
  expect(JSON.parse(String(previews.at(-1)?.[1]?.body)).content.theme).toBe('jade')
  const slots = screen.getByRole('navigation', { name: '服务时点' })
  await user.click(within(slots).getByRole('button', { name: /盘前简报/ }))
  expect(screen.getByRole('button', { name: '锦绣江岸' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(within(slots).getByRole('button', { name: /关键时点/ }))
  expect(screen.getByRole('button', { name: '冰蓝科技' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: '保存本次卡片' }))
  await screen.findByText('本次卡片已保存')
  const saved = vi.mocked(api).mock.calls.find(([path, init]) => path.includes('/cards/') && init?.method === 'PUT')
  expect(JSON.parse(String(saved?.[1]?.body)).content.theme).toBe('jade')
})

it('applies a collection to future slots without replacing saved copy or pending schedule edits', async () => {
  const user = userEvent.setup(); setup()
  await screen.findByRole('textbox', { name: '今日判断' })
  await user.click(screen.getByRole('button', { name: '设置每日生成计划' }))
  fireEvent.change(screen.getByLabelText('关键时点生成时间'), { target: { value: '10:50' } })
  await user.click(screen.getByRole('button', { name: '关闭生成计划' }))
  await user.click(screen.getByRole('button', { name: '曜金几何' }))
  await user.type(screen.getByRole('textbox', { name: '今日判断' }), '只保留在当前草稿')
  await user.click(screen.getByRole('button', { name: '设为全时点默认' }))
  await screen.findByText('「曜金几何」已设为所有时点的默认套图，以后生成时自动匹配对应底图')
  const saved = vi.mocked(api).mock.calls.find(([path, init]) => path.endsWith('/settings') && init?.method === 'PUT')
  const settings = JSON.parse(String(saved?.[1]?.body))
  expect(settings.templates.every((item: {content: CardContent}) => item.content.theme === 'gold' && item.content.conclusion === '')).toBe(true)
  expect(settings.templates[2].time).toBe('10:30')
  await user.click(screen.getByRole('button', { name: '设置每日生成计划' }))
  expect(screen.getByLabelText('关键时点生成时间')).toHaveValue('10:50')
})


it('selects the realtime slot without a model call, then preserves its draft when explicitly generating', async () => {
  const user = userEvent.setup(); setup()
  await screen.findByRole('textbox', { name: '今日判断' })
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/client-service/briefs') return { ...initialCard, id: 'live-create', slot_id: 'live-12345678901234567890123456789012', state: 'running', content: { ...content }, template: { ...config.templates[2], id: 'live-12345678901234567890123456789012', title: '即时简报' } }
    if (path === '/client-service/cards/live-create' && init?.method === 'PUT') return { ...initialCard, id: 'live-create', slot_id: 'live-12345678901234567890123456789012', content: JSON.parse(String(init.body)).content, revision: 1, template: { ...config.templates[2], id: 'live-12345678901234567890123456789012', title: '即时简报' } }
    return original(path, init)
  })
  await user.click(within(screen.getByRole('navigation', { name: '服务时点' })).getByRole('button', { name: '实时股评卡片' }))
  expect(screen.queryByRole('button', { name: /^实时股评$/ })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('')
  expect(vi.mocked(api).mock.calls.some(([path]) => path === '/client-service/briefs')).toBe(false)
  await user.type(screen.getByRole('textbox', { name: '今日判断' }), '准备好的即时判断')
  await user.click(screen.getByRole('button', { name: '生成即时简报' }))
  await screen.findByText('实时股评已启动，Codex 正在检索并生成即时简报')
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('准备好的即时判断')
  const saved = vi.mocked(api).mock.calls.find(([path, init]) => path === '/client-service/cards/live-create' && init?.method === 'PUT')
  expect(JSON.parse(String(saved?.[1]?.body)).content.conclusion).toBe('准备好的即时判断')
})

it('opens the latest card in a fullscreen viewer and restores focus after Escape', async () => {
  const user = userEvent.setup(); setup()
  await waitFor(() => expect(screen.getByRole('button', { name: /^全屏查看$/ })).toBeEnabled())
  const trigger = screen.getByRole('button', { name: /^全屏查看$/ })
  const image = screen.getByRole('img', { name: /时点卡预览/ }).getAttribute('src')
  await user.click(trigger)
  const dialog = screen.getByRole('dialog', { name: '成品全屏预览' })
  expect(dialog).toHaveClass('client-card-fullscreen')
  expect(within(dialog).getByRole('img', { name: '全屏成品图片' })).toHaveAttribute('src', image)
  await user.click(within(dialog).getByRole('button', { name: '放大阅读' }))
  expect(within(dialog).getByRole('button', { name: '适应窗口' })).toHaveAttribute('aria-pressed', 'true')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

it('browses the theme list without changing the selected theme or starting research', async () => {
  const user = userEvent.setup(); setup()
  const list = await screen.findByRole('group', { name: '套图风格' })
  Object.defineProperties(list, { clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 900 } })
  const scroll = vi.fn()
  list.scrollBy = scroll
  fireEvent.scroll(list)
  expect(screen.getByRole('button', { name: '向下浏览套图' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '向上浏览套图' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '向下浏览套图' }))
  expect(scroll).toHaveBeenCalledWith({ top: 225, behavior: 'smooth' })
  expect(screen.getByRole('button', { name: '锦绣江岸' })).toHaveAttribute('aria-pressed', 'true')
  list.scrollTop = 600
  fireEvent.scroll(list)
  expect(screen.getByRole('button', { name: '向下浏览套图' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '向上浏览套图' })).toBeEnabled()
  expect(vi.mocked(api).mock.calls.some(([path]) => path === '/client-service/briefs')).toBe(false)
})


it('edits copy directly on the image and synchronizes the sidebar and exported preview', async () => {
  const user = userEvent.setup(); setup()
  await user.click(await screen.findByRole('button', { name: '编辑图片中的今日判断' }))
  const field = screen.getByRole('textbox', { name: '图片中的今日判断' })
  await user.type(field, '直接在图片上修改判断')
  await user.click(screen.getByRole('button', { name: '确认修改' }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('直接在图片上修改判断')
  await waitFor(() => expect(screen.getByRole('button', { name: '下载 PNG' })).toBeEnabled())
  const previews = vi.mocked(api).mock.calls.filter(([path]) => path === '/client-service/preview')
  expect(JSON.parse(String(previews.at(-1)?.[1]?.body)).content.conclusion).toBe('直接在图片上修改判断')
})

it('cancels an image edit and keeps market display changes separate from collected sources', async () => {
  const user = userEvent.setup(); setup()
  await user.click(await screen.findByRole('button', { name: '编辑图片中的今日判断' }))
  await user.type(screen.getByRole('textbox', { name: '图片中的今日判断' }), '不要提交')
  await user.click(screen.getByRole('button', { name: /^取消$/ }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('')
  await user.click(screen.getByRole('button', { name: '编辑图片中的市场摘要' }))
  await user.clear(screen.getByRole('textbox', { name: '图片中的市场摘要' }))
  await user.type(screen.getByRole('textbox', { name: '图片中的市场摘要' }), '人工修订的摘要')
  await user.click(screen.getByRole('button', { name: '确认修改' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '下载 PNG' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '保存本次卡片' }))
  await screen.findByText('本次卡片已保存')
  const saved = vi.mocked(api).mock.calls.find(([path, init]) => path.includes('/cards/') && init?.method === 'PUT')
  expect(JSON.parse(String(saved?.[1]?.body)).content.market_overrides).toEqual({summary:'人工修订的摘要'})
  expect(JSON.parse(String(saved?.[1]?.body)).market).toBeUndefined()
})

it('keeps an inline text draft focused while background card updates regenerate the image', async () => {
  const user = userEvent.setup(); setup()
  await user.click(await screen.findByRole('button', { name: '编辑图片中的今日判断' }))
  const field = screen.getByRole('textbox', { name: '图片中的今日判断' })
  await user.type(field, '输入中的判断不能被覆盖')
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, init) => path.startsWith('/client-service/cards?') ? { items: [{ ...initialCard, revision: 1, content: { ...content, action: '后台完成的新内容' } }] } : original(path, init))
  await waitFor(() => expect(screen.getByRole('textbox', { name: '行动安排' })).toHaveValue('后台完成的新内容'), { timeout: 6500 })
  expect(screen.getByRole('textbox', { name: '图片中的今日判断' })).toHaveValue('输入中的判断不能被覆盖')
  expect(screen.getByRole('textbox', { name: '图片中的今日判断' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: '确认修改' }))
  expect(screen.getByRole('textbox', { name: '今日判断' })).toHaveValue('输入中的判断不能被覆盖')
}, 8000)
