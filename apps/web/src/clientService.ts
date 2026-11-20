import disclosure from '../../api/app/assets/client-service/disclosure.json'

export const fixedDisclosure = disclosure
export const disclosureLines = [
  `风险提示：${disclosure.risk}`, `投顾顾问：${disclosure.adviser}`,
  `投顾执业编码：${disclosure.license}`, `执业机构：${disclosure.institution}`,
]
export function withFixedDisclosure(content: CardContent): CardContent {
  return { ...content, ...fixedDisclosure }
}

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
  service: string; risk: string; adviser: string; license: string; institution?: string
}
export type ServiceTemplate = { id: string; title: string; time: string; enabled: boolean; content: CardContent }
export type ServiceSettings = { revision: number; enabled: boolean; timezone: 'Asia/Shanghai'; weekdays: number[]; templates: ServiceTemplate[] }
export type MarketSnapshot = {
  summary: string; cutoff: string; quality: 'verified' | 'partial'
  metrics: { label: string; value: string; observed_at: string | null; source_url: string | null }[]
  public_notes?: string[]
  data_note?: string
  raw_metrics?: { label: string; value: string; observed_at: string | null; source_url: string | null }[]
  sources: { title: string; url: string; published_at: string | null }[]; limitations: string[]
}
export type ServiceCard = {
  id: string; service_date: string; slot_id: string; cutoff: string; revision: number
  state: 'awaiting_agent' | 'running' | 'ready' | 'failed'; message: string
  template: ServiceTemplate; content: CardContent; market: MarketSnapshot | null; updated_at: string
}
export const conclusionLimit = 160
export const contentFields: { key: Exclude<keyof CardContent, 'theme' | 'market_overrides' | keyof typeof fixedDisclosure>; label: string; max: number; rows?: number }[] = [
  { key: 'brand', label: '服务名称', max: 20 }, { key: 'headline', label: '卡片标题', max: 20 },
  { key: 'conclusion', label: '今日判断', max: conclusionLimit, rows: 3 }, { key: 'action', label: '行动安排', max: 180, rows: 3 },
  { key: 'focus', label: '观察重点', max: 140, rows: 3 }, { key: 'service', label: '服务说明', max: 80, rows: 2 },
]
export function beijingDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) }
export function marketTime(value: string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) }

const urlCharacter = /[^\s<>{}\[\]()"'（）【】《》“”‘’，。；：、！？]/.source
const urlHost = /(?<![a-z0-9@_.-])(?:[a-z0-9-]+\.)+(?:com|cn|net|org|gov|edu|hk|io|pro|info)(?![a-z0-9-]|\.[a-z0-9])/.source
const urlTail = String.raw`${urlCharacter}*(?:\(${urlCharacter}*\)${urlCharacter}*)*`
const webAddress = String.raw`(?:(?:https?://|www\.)${urlCharacter}${urlTail}|${urlHost}(?:[/?#]${urlTail})?)`
const markdownWebLink = new RegExp(String.raw`!?\[([^\]\r\n]*)\]\([ \t]*<?${webAddress}>?(?:[ \t]+"[^"\r\n]*")?[ \t]*\)`, 'gi')
const webLink = new RegExp(String.raw`<${webAddress}>|（${webAddress}）|\(${webAddress}\)|${webAddress}`, 'gi')

export function withoutWebLinks(text: string) {
  const cleaned = text.replace(markdownWebLink, '$1').replace(webLink, address => address.match(/[.,;:!?]+$/)?.[0] ?? '')
  return cleaned === text ? text : cleaned.replace(/[ \t]+(?=[，。；：、！？.,;:!?])/g, '').trim()
}

export function forwardingLines(lines: readonly string[]) {
  return lines.map(line => withoutWebLinks(line).trim()).filter(Boolean)
}

export function forwardingSourceTitles(sources: readonly { title: string }[]) {
  return [...new Set(forwardingLines(sources.map(source => source.title || '')))]
}

export function cardText(template: ServiceTemplate, content: CardContent, card: ServiceCard | undefined, date: string) {
  const notes = forwardingLines(card?.market?.public_notes || [])
  const title = withoutWebLinks(content.headline) || withoutWebLinks(template.title)
  const summary = content.market_overrides?.summary || card?.market?.summary || '市场状态尚未采集。'
  return [`【${withoutWebLinks(content.brand)}·${title}】${date} ${template.time}`,
    withoutWebLinks(summary),
    ...(card?.market?.metrics.map((item, index) => {
      const label = withoutWebLinks(content.market_overrides?.[`metric.${index}.label`] || item.label)
      const value = withoutWebLinks(content.market_overrides?.[`metric.${index}.value`] || item.value)
      return `${label}：${value}`
    }) || []),
    ...contentFields.filter(field => ['conclusion', 'action', 'focus', 'service'].includes(field.key)).flatMap(field => {
      const text = withoutWebLinks(content[field.key])
      const label = template.id.startsWith('live-') && field.key === 'action' ? '盘面主线' : field.label
      return text ? [`${label}：${text}`] : []
    }),
    ...(notes.length ? ['数据说明：' + notes.join('；')] : []),
    ...(Object.keys(content.market_overrides || {}).length ? ['展示说明：市场展示文字含手工编辑，原始采集记录可在工作台来源中核对。'] : []),
    ...forwardingSourceTitles(card?.market?.sources || []).map(title => `来源：${title}`),
    ...disclosureLines,
  ].filter(Boolean).join('\n')
}

export type CardTextRegion = { key: string; label: string; x: number; y: number; width: number; height: number; max: number; value: string; color: string }
export type CardPreview = { image: string; width: number; height: number; draft?: boolean; regions?: CardTextRegion[]; image_hash?: string; saved_image_hash?: string; checks?: {state:string;issues:{area:string;message:string;severity:string}[]} }

/** The older preview endpoint ignores the draft query parameter. */
export async function markDraftPreview(preview: CardPreview): Promise<CardPreview> {
  const image = new Image()
  image.src = preview.image
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('暂时无法生成带草稿标记的预览。')
  context.drawImage(image, 0, 0)
  const scale = canvas.width / 1080
  context.scale(scale, scale)
  const label = '草稿 · 待核对'
  context.font = '600 22px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  const width = Math.ceil(context.measureText(label).width) + 28
  const left = 1016 - width
  context.fillStyle = '#fff1d5'
  context.fillRect(left, 107, width, 39)
  context.fillStyle = '#213d55'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(label, left + width / 2, 126)
  return { ...preview, draft: true, image: canvas.toDataURL('image/png'), image_hash: undefined, saved_image_hash: preview.image_hash }
}
