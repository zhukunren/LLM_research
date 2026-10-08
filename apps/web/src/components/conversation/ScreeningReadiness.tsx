import { useEffect, useId, useState } from 'react'
import { api, type ConversationScope, type DataStatus, type ScreeningTaskRevision } from '../../api'
import { taskUniverseLabel } from './TaskBrief'
import './screening-readiness.css'

type Availability = 'available' | 'partial' | 'unavailable'
export type ScreeningCapability = { id: string; title: string; availability: Availability }
export type ScreeningCapabilities = { capabilities: ScreeningCapability[] }
type Props = {
  data?: DataStatus | null
  scope?: ConversationScope
  task?: ScreeningTaskRevision | null
  onOpenData?: () => void
  selectedUniverseLabel?: string
  asOf?: string
  showScope?: boolean
}
const sources: Record<string, { id: string; name: string; action: string }> = {
  technical: { id: 'market.daily_bars', name: '日线行情', action: '接入日线行情后再执行' },
  report: { id: 'report.page_search', name: '研报原文', action: '先导入并索引相关研报' },
  news: { id: 'news.local_search', name: '资讯原文', action: '先导入相关资讯' },
  pattern: { id: 'market.daily_bars', name: '日线行情', action: '接入日线行情后再执行' },
}

// This is source availability, not a per-condition execution guarantee. The API
// does not expose condition coverage or required lookback/readiness contracts.
export function screeningSourceReadiness(data: DataStatus | null | undefined, manifest: ScreeningCapabilities | null, scope: ConversationScope, task?: ScreeningTaskRevision | null, selectedAsOf?: string) {
  const libraries = task?.conditions.length ? [...new Set(task.conditions.map(item => item.library))] : [scope]
  const requirements = [...new Map(libraries.map(library => sources[library]).filter(Boolean).map(source => [source.id, source])).values()]
  if (!requirements.length) requirements.push(sources.technical)
  const issues: string[] = []
  let unavailable = 0
  let unknown = false
  if (task?.conditions.some(condition => !sources[condition.library])) {
    unknown = true
    issues.push('部分条件的数据需求尚未确认，请在方案中核对所需数据。')
  }
  for (const source of requirements) {
    const availability = manifest?.capabilities.find(item => item.id === source.id)?.availability
    const noMarketData = source.id === 'market.daily_bars' && data && (!data.available || data.rows === 0 || data.securities === 0)
    if (availability === 'unavailable' || noMarketData) {
      unavailable++
      issues.push(`${source.name}暂不可用，${source.action}。`)
    } else if (!availability || availability === 'partial') {
      unknown = true
      issues.push(`${source.name}可用范围尚未确认，请检查数据与服务。`)
    }
  }
  const asOf = selectedAsOf ?? task?.scope.as_of
  const needsMarket = requirements.some(source => source.id === 'market.daily_bars')
  if (needsMarket && asOf && data?.last_date && asOf > data.last_date) {
    issues.push(`截止日晚于最新行情（${data.last_date}），需更新行情或核对截止日。`)
  }
  if (needsMarket && asOf && data?.first_date && asOf < data.first_date) {
    issues.push(`截止日早于行情起始日（${data.first_date}），需补充历史数据或核对截止日。`)
  }
  const state = unavailable === requirements.length ? 'unavailable' : unavailable || unknown || issues.length ? 'partial' : 'available'
  return { state, issues, sourceNames: requirements.map(source => source.name).join('、') }
}

export default function ScreeningReadiness({ data, scope = 'screening', task, onOpenData, selectedUniverseLabel, asOf, showScope = true }: Props) {
  const [manifest, setManifest] = useState<ScreeningCapabilities | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    api<ScreeningCapabilities>('/screening-capabilities', { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.capabilities)) throw new Error('Invalid capability response')
      if (!controller.signal.aborted) setManifest(result)
    }).catch(() => { if (!controller.signal.aborted) { setFailed(true); setManifest(null) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [attempt, data?.available, data?.last_date])
  const readiness = screeningSourceReadiness(data, manifest, scope, task, asOf)
  const canRefresh = !loading && (failed || readiness.state !== 'available')
  useEffect(() => { setExpanded(canRefresh) }, [canRefresh])
  const label = loading ? '正在检查数据' : failed ? '数据状态待确认' : ({ available: '数据来源已接入', partial: '数据部分可用 / 待确认', unavailable: '所需数据暂不可用' })[readiness.state]
  const universe = selectedUniverseLabel ?? (task ? taskUniverseLabel(task) : '全部 A 股（默认范围）')
  const date = asOf !== undefined ? asOf || '待确定' : task ? task.scope.as_of || '待确定' : data?.last_date ? `${data.last_date}（默认最新行情日）` : '待行情接入后确定'
  const unsupported = manifest?.capabilities.filter(item => ['fundamentals.market_cap', 'securities.historical_classification', 'market.minute_bars'].includes(item.id) && item.availability === 'unavailable') ?? []
  return <section className="screening-readiness" aria-label="筛选数据准备情况">
    <div className="screening-readiness-summary"><strong>{label}</strong>{showScope && <span>{universe} · 截止日：{date}</span>}<button type="button" className="text-button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>查看数据范围与限制</button></div>
    <div id={detailsId} hidden={!expanded}>
      {!loading && <p>{failed ? '暂时无法核对数据状态，可重试检查；已写的条件会保留。' : readiness.issues.length ? readiness.issues.join(' ') : `${readiness.sourceNames}已接入；每项条件的历史长度、证券覆盖和计算口径仍需核对。`}</p>}
      <p>{data?.last_date ? `本地行情截至 ${data.last_date}${data.first_date ? `，起始于 ${data.first_date}` : ''}。默认日期不代表今天的行情。` : '尚未确认本地行情日期。'}</p>
      {!!unsupported.length && <p>暂不支持：{unsupported.map(item => ({ 'fundamentals.market_cap': '历史财务与估值', 'securities.historical_classification': '历史行业、ST及证券状态', 'market.minute_bars': '分钟行情' })[item.id]).join('、')}。涉及这些数据的条件需要补充数据或由你明确调整。</p>}
      <p>这里只检查数据来源是否可用，不保证每项条件都能完成。复权、量额单位和逐证券数据覆盖以方案与执行结果为准；数据不足会标为未知，不会自动删除条件。</p>
    {(canRefresh || onOpenData) && <div className="screening-readiness-actions">{canRefresh && <button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>重新检查</button>}{onOpenData && <button type="button" className="text-button" onClick={onOpenData}>检查数据与服务</button>}</div>}
    </div>
  </section>
}
