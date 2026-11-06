import type { ConversationScope } from './api'

export const screeningMethods = [
  { id: 'technical', label: '技术选股', description: '调整指标和规则，用日线行情试算', short: '指标与日线规则' },
  { id: 'pattern', label: '形态选股', description: '截取、绘制或上传走势，查找相似形态', short: '行情、绘图与截图' },
  { id: 'news', label: '资讯选股', description: '按事件与时间窗口筛选，核对资讯原文', short: '事件与原文依据' },
  { id: 'report', label: '研报选股', description: '从研报中核对经营判断与实际证据', short: '事实、观点与预测' },
] as const

export type ScreeningMethod = (typeof screeningMethods)[number]['id']
export type ScreeningFormMethod = Exclude<ScreeningMethod, 'pattern'>
export const isScreeningMethod = (value: unknown): value is ScreeningMethod => screeningMethods.some(item => item.id === value)
export const screeningMethodLabel = (method: ScreeningMethod) => screeningMethods.find(item => item.id === method)!.label
export const methodScope = (method: ScreeningMethod): ConversationScope => method
export type EvidenceBasis = 'actual' | 'forecast' | 'separate'
export type EvidenceScreeningOptions = { lookback: number; basis: EvidenceBasis }
export const evidenceBasisLabels: Record<EvidenceBasis, string> = {
  actual: '已发生事实与实际经营数据', forecast: '分析师预测与未来判断', separate: '分别核对事实与预测',
}

export function evidenceScreeningPrompt(method: 'news' | 'report', requirement: string, options: EvidenceScreeningOptions, asOf: string) {
  const window = `${asOf ? `截至 ${asOf}` : '截至本次筛选日期'}的近 ${options.lookback} 个自然日`
  const boundary = method === 'news'
    ? `资讯窗口：${window}发布的资讯。按事件内容和原文判断，不能仅凭提及公司名称或关键词就认定符合。`
    : `研报窗口：${window}发布的研报。证据口径：${evidenceBasisLabels[options.basis]}。分别标明事实、公司表述、分析师观点和预测，不把预测当作已实现业绩。`
  return `请筛选符合以下要求的股票：\n${requirement.trim()}\n\n${boundary}\n逐只返回股票名单、符合或不符合的理由，以及支持判断的${method === 'news' ? '资讯日期与原文' : '研报日期、页码与原文'}。没有充分证据的股票单独列为数据不足，不视为符合。`
}

export function templateDescription(template: { id?: string; name: string; formula: string; rules?: string[] }, parameters: Record<string, number>) {
  if (template.id === 'above_sma') return `收盘价高于 ${parameters.window} 日简单均线（含当日）`
  if (template.id === 'return_above') return `近 ${parameters.window} 个交易日涨幅大于 ${parameters.threshold}%`
  if (template.id === 'ma_cross') return `${parameters.fast} 日均线上穿 ${parameters.slow} 日均线（当日大于，前一交易日小于或等于）`
  return (template.rules?.length ? template.rules.join('；且 ') : template.formula).replace(/\{(\w+)\}/g, (_, key: string) => String(parameters[key] ?? ''))
}
