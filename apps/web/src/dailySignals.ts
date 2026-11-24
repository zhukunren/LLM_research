export const dailySignalsEndpoint = '/api/v1/daily-signals/signals'

export type SignalStock = { code: string; name: string; position_ratio: number | null; position_date: string }
export type DailyStrategy = {
  strategy_name: string; strategy_title: string; generation_id: string
  buy_signals: SignalStock[]; sell_signals: SignalStock[]; covers_date: boolean
  win_rate: number | null; avg_trade_return: number | null; ann_return: number | null
  sample_count: number; known_pnl_count: number; win_count: number | null; sample_start: string; sample_end: string
  ann_return_start: string; ann_return_end: string; ann_return_day_count: number; data_end: string
}
export type DailySignals = { date: string; dates: string[]; n: number; unavailable_count: number; strategies: DailyStrategy[] }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('信号数据格式异常，请稍后重试。')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('信号数据缺少必要信息。')
  return value
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('信号统计格式异常。')
  return value
}
function metric(value: unknown): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('信号收益统计格式异常。')
  return value
}
function stocks(value: unknown): SignalStock[] {
  if (!Array.isArray(value)) throw new Error('股票信号格式异常。')
  return value.map(item => {
    const stock = record(item)
    const ratio = stock.position_ratio
    return {
      code: text(stock.code),
      name: text(stock.name),
      position_ratio: typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 ? ratio : null,
      position_date: typeof stock.position_date === 'string' ? stock.position_date : '',
    }
  })
}
export function parseDailySignals(value: unknown): DailySignals {
  const data = record(value)
  if (data.schema_version !== 1) throw new Error('暂不支持此信号数据版本，请联系维护者更新。')
  if (!Array.isArray(data.strategies) || !Array.isArray(data.dates)) throw new Error('信号数据缺少策略或日期。')
  const n = count(data.n)
  if (n < 1 || n > 10000) throw new Error('信号样本数超出有效范围。')
  const strategies = data.strategies.map(value => {
    const item = record(value)
    if (typeof item.covers_date !== 'boolean') throw new Error('信号数据缺少日期覆盖状态。')
    const winRate = metric(item.win_rate)
    if (winRate !== null && (winRate < 0 || winRate > 1)) throw new Error('胜率数据超出有效范围。')
    return {
      strategy_name: text(item.strategy_name), strategy_title: text(item.strategy_title), generation_id: text(item.generation_id),
      buy_signals: stocks(item.buy_signals), sell_signals: stocks(item.sell_signals), covers_date: item.covers_date,
      win_rate: winRate, avg_trade_return: metric(item.avg_trade_return), ann_return: metric(item.ann_return),
      sample_count: count(item.sample_count), known_pnl_count: count(item.known_pnl_count),
      win_count: item.win_count == null ? null : count(item.win_count),
      sample_start: text(item.sample_start), sample_end: text(item.sample_end), data_end: text(item.data_end),
      ann_return_start: text(item.ann_return_start ?? ''), ann_return_end: text(item.ann_return_end ?? ''),
      ann_return_day_count: count(item.ann_return_day_count ?? 0),
    }
  })
  return { date: text(data.date), dates: data.dates.map(text), n, unavailable_count: count(data.unavailable_count), strategies }
}

export function signalPercent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(2)}%`
}

export type SignalSortKey = 'win_rate' | 'avg_trade_return' | 'ann_return'
export type SignalSort = { key: SignalSortKey; direction: 'asc' | 'desc' } | null
export function sortDailyStrategies(items: DailyStrategy[], sort: SignalSort): DailyStrategy[] {
  if (!sort) return items
  return [...items].sort((a, b) => {
    const left = a.covers_date ? a[sort.key] : null, right = b.covers_date ? b[sort.key] : null
    if (left === null) return right === null ? 0 : 1
    if (right === null) return -1
    return sort.direction === 'desc' ? right - left : left - right
  })
}
