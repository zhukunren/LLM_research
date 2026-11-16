// Keep the persisted jade key for cards and drafts; its collection is now Ice Blue Technology.
export type CardTheme = 'river' | 'jade' | 'gold' | 'cosmos' | 'cinnabar' | 'ocean' | 'platinum'
export const cardThemes: { id: CardTheme; name: string; description: string }[] = [
  { id: 'river', name: '锦绣江岸', description: '蓝金城市 · 江岸光影' },
  { id: 'jade', name: '冰蓝科技', description: '芯片光路 · 数据网络' },
  { id: 'gold', name: '曜金几何', description: '曜石金属 · 几何光影' },
  { id: 'cosmos', name: '星穹银紫', description: '银紫星轨 · 静谧宇宙' },
  { id: 'cinnabar', name: '朱砂丹霞', description: '朱砂岩层 · 晨昏山色' },
  { id: 'ocean', name: '远洋航线', description: '深蓝海图 · 银色航迹' },
  { id: 'platinum', name: '铂银建筑', description: '银灰建筑 · 光影秩序' },
]
export function cardArtworkPosition(slot: string) {
  const index = ['preopen', 'opening', 'checkpoint', 'midday', 'late', 'close'].indexOf(slot)
  const cell = index < 0 ? 6 : index
  return `${cell % 2 * 100}% ${Math.floor(cell / 2) * 100 / 3}%`
}
export type CardContent = {
  theme?: CardTheme
  market_overrides?: Record<string, string>
  brand: string; headline: string; conclusion: string; action: string; focus: string
  service: string; risk: string; adviser: string; license: string
}
export type ServiceTemplate = { id: string; title: string; time: string; enabled: boolean; content: CardContent }
export type ServiceSettings = { revision: number; enabled: boolean; timezone: 'Asia/Shanghai'; weekdays: number[]; templates: ServiceTemplate[] }
export type MarketSnapshot = {
  summary: string; cutoff: string; quality: 'verified' | 'partial'
  metrics: { label: string; value: string; observed_at: string | null; source_url: string | null }[]
  sources: { title: string; url: string; published_at: string | null }[]; limitations: string[]
}
export type ServiceCard = {
  id: string; service_date: string; slot_id: string; cutoff: string; revision: number
  state: 'awaiting_agent' | 'running' | 'ready' | 'failed'; message: string
  template: ServiceTemplate; content: CardContent; market: MarketSnapshot | null; updated_at: string
}
export const contentFields: { key: Exclude<keyof CardContent, 'theme' | 'market_overrides'>; label: string; max: number; rows?: number }[] = [
  { key: 'brand', label: '服务名称', max: 20 }, { key: 'headline', label: '卡片标题', max: 20 },
  { key: 'conclusion', label: '今日判断', max: 160, rows: 3 }, { key: 'action', label: '行动安排', max: 180, rows: 3 },
  { key: 'focus', label: '观察重点', max: 140, rows: 3 }, { key: 'service', label: '服务说明', max: 80, rows: 2 },
  { key: 'adviser', label: '投顾姓名', max: 30 }, { key: 'license', label: '执业编号', max: 30 },
  { key: 'risk', label: '风险提示', max: 100, rows: 2 },
]
export function beijingDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) }
export function marketTime(value: string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) }
export function cardText(template: ServiceTemplate, content: CardContent, card: ServiceCard | undefined, date: string) {
  return [`【${content.brand}·${content.headline || template.title}】${date} ${template.time}`,
    content.market_overrides?.summary || card?.market?.summary || '市场状态尚未采集。',
    ...(card?.market?.metrics.map((item, index) => `${content.market_overrides?.[`metric.${index}.label`] || item.label}：${content.market_overrides?.[`metric.${index}.value`] || item.value}`) || []),
    ...contentFields.filter(field => ['conclusion', 'action', 'focus', 'service', 'risk'].includes(field.key) && content[field.key]).map(field => `${field.label}：${content[field.key]}`),
    [content.adviser, content.license].filter(Boolean).join(' '),
    ...(card?.market?.limitations.length ? ['数据说明：' + card.market.limitations.join('；')] : []),
    ...(Object.keys(content.market_overrides || {}).length ? ['展示说明：市场展示文字含手工编辑，原始采集记录可在工作台来源中核对。'] : []),
    ...(card?.market?.sources.map(source => `来源：${source.title} ${source.url}`) || []),
  ].filter(Boolean).join('\n')
}

export type CardTextRegion = { key: string; label: string; x: number; y: number; width: number; height: number; max: number; value: string; color: string }
export type CardPreview = { image: string; width: number; height: number; regions?: CardTextRegion[] }
