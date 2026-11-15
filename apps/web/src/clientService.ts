export type CardContent = {
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
export const contentFields: { key: keyof CardContent; label: string; max: number; rows?: number }[] = [
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
    card?.market?.summary || '市场状态尚未采集。',
    ...(card?.market?.metrics.map(item => `${item.label}：${item.value}`) || []),
    ...contentFields.filter(field => ['conclusion', 'action', 'focus', 'service', 'risk'].includes(field.key) && content[field.key]).map(field => `${field.label}：${content[field.key]}`),
    [content.adviser, content.license].filter(Boolean).join(' '),
    ...(card?.market?.limitations.length ? ['数据说明：' + card.market.limitations.join('；')] : []),
    ...(card?.market?.sources.map(source => `来源：${source.title} ${source.url}`) || []),
  ].filter(Boolean).join('\n')
}
