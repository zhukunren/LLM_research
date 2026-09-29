import type { Filter } from './api'

const operators: Record<string, string> = { gt: '大于', gte: '不低于', lt: '小于', lte: '不高于', eq: '等于' }
const fields: Record<string, string> = { close: '收盘价', open: '开盘价', high: '最高价', low: '最低价', volume: '成交量', amount: '成交额' }

export function conditionParameter(expression: Filter['expression'], key: string): unknown {
  const parts = key.split('.')
  let current: unknown = expression
  if (parts[0] === 'formula') { current = expression.formula; parts.shift() }
  for (const part of parts) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)]
    else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[part]
    else return undefined
  }
  return current
}

export function applyConditionParameters(expression: Filter['expression'], overrides?: Record<string, string | number>): Filter['expression'] {
  const result = JSON.parse(JSON.stringify(expression)) as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const parts = key.split('.')
    let current: unknown = result
    if (parts[0] === 'formula') { current = result.formula; parts.shift() }
    if (!parts.length) continue
    for (const part of parts.slice(0, -1)) {
      if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)]
      else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[part]
      else { current = undefined; break }
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      (current as Record<string, unknown>)[parts.at(-1)!] = value
    }
  }
  return result
}

function formulaText(value: unknown): string {
  if (!value || typeof value !== 'object') return '公式'
  const node = value as Record<string, unknown>
  const child = (key: string) => formulaText(node[key])
  const number = (input: unknown) => typeof input === 'number' ? String(input) : '?'
  const window = number(node.window)
  const field = fields[String(node.field)] ?? String(node.field ?? '行情')
  const indicators: Record<string, string> = { sma: '均线', ema: '指数均线', rsi: 'RSI', bollinger: '布林上轨', macd_dif: 'MACD DIF', macd_dea: 'MACD DEA', macd_hist: 'MACD 柱', kdj_k: 'KDJ K', kdj_d: 'KDJ D', kdj_j: 'KDJ J', atr: 'ATR' }
  switch (node.op) {
    case 'field': return field
    case 'constant': return number(node.value)
    case 'indicator': return `${window}日${indicators[String(node.name)] ?? String(node.name)}`
    case 'return_pct': return `近${window}日涨幅`
    case 'relative_volume': return `当日成交量 / 前${window}日均量`
    case 'rolling': return `最近${window}日${({ mean: '均值', sum: '合计', min: '最低值', max: '最高值', std: '标准差' } as Record<string, string>)[String(node.method)] ?? '统计值'}（${child('input')}）`
    case 'lag': return `${number(node.period)}个交易日前的${child('input')}`
    case 'binary': return `（${child('left')} ${{ add: '+', subtract: '−', multiply: '×', divide: '÷' }[String(node.operator)] ?? '?'} ${child('right')}）`
    case 'compare': return `${child('left')}${operators[String(node.operator)] ?? '比较'}${child('right')}`
    case 'cross': return `${child('left')}${node.direction === 'down' ? '下穿' : '上穿'}${child('right')}`
    case 'logic': {
      const children = Array.isArray(node.children) ? node.children.map(formulaText) : []
      return node.operator === 'not' ? `不满足（${children[0] ?? '条件'}）` : `（${children.join(node.operator === 'any' ? '，或' : '，且')}）`
    }
    case 'consecutive': return `连续${number(node.days)}个交易日逐日满足（${child('input')}）`
    case 'within': return `最近${window}个交易日内曾满足（${child('input')}）`
    case 'count_true': return `最近${window}个交易日的满足次数（${child('input')}）`
    default: return '时序公式'
  }
}

export function conditionText(library: Filter['library'], expression: Filter['expression'], fallback = ''): string {
  if (library !== 'technical') return fallback
  const e = expression, comparator = operators[String(e.operator)] ?? '比较', window = e.window
  if (e.op === 'timeseries_filter') return String(e.summary ?? (fallback.trim() ? fallback : formulaText(e.formula)))
  if (e.op === 'generated_timeseries_filter') {
    const summary = String(e.summary ?? fallback)
    const values = e.parameters && typeof e.parameters === 'object' ? e.parameters as Record<string, unknown> : {}
    const specs = e.parameter_specs && typeof e.parameter_specs === 'object' ? e.parameter_specs as Record<string, { label?: string }> : {}
    const parameters = Object.entries(values).map(([key, value]) => {
      const formatted = String(value)
      return specs[key]?.label && !summary.includes(formatted) ? String(specs[key].label) + ' ' + formatted : ''
    }).filter(Boolean)
    return parameters.length ? summary + ' · ' + parameters.join(' · ') : summary
  }
  if (e.op === 'metric_compare') {
    const repetition = e.consecutive_days ? `连续 ${e.consecutive_days} 个交易日，每日` : ''
    if (e.metric === 'return_pct') return `${repetition}近 ${window} 个交易日涨幅${comparator} ${e.value}%`
    if (e.metric === 'volume_ratio') return `${repetition}${e.consecutive_days ? '' : '当日'}成交量${comparator}此前 ${window} 日均量的 ${e.value} 倍`
    return `收盘价${comparator} ${e.value} 元`
  }
  if (e.op === 'ma_cross') return `${e.fast_window} 日均线当日${e.direction === 'down' ? '下穿' : '上穿'} ${e.slow_window} 日均线`
  if (e.op === 'indicator_compare') {
    if (e.indicator === 'sma' && e.compare_field === 'close' && (e.field ?? 'close') === 'close') {
      const inverse: Record<string, string> = { gt: '小于', gte: '不高于', lt: '大于', lte: '不低于', eq: '等于' }
      return `收盘价${inverse[String(e.operator)]} ${window} 日均线`
    }
    return `${actualLabel(e)}${comparator} ${e.compare_field ? fields[String(e.compare_field)] : e.value}`
  }
  return fallback
}

export function actualLabel(e?: Filter['expression']): string {
  if (!e) return '实际计算值'
  if (e.op === 'metric_compare') return e.metric === 'return_pct' ? '实际涨幅' : e.metric === 'volume_ratio' ? '实际成交量倍数' : '实际收盘价'
  const names: Record<string, string> = { sma: '日均线', ema: '日指数均线', rsi: '日 RSI', macd_hist: 'MACD 柱', macd_dif: 'MACD DIF', macd_dea: 'MACD DEA', kdj_k: 'KDJ K', kdj_d: 'KDJ D', kdj_j: 'KDJ J', atr: 'ATR', bollinger: '布林带上轨' }
  return e.field === 'volume' ? `${e.window} 日平均成交量` : `${String(e.indicator).startsWith('macd_') ? '' : `${e.window} `}${names[String(e.indicator)] ?? '实际计算值'}`
}

export function targetLabel(e?: Filter['expression']): string { return e?.compare_field ? fields[String(e.compare_field)] ?? '比较值' : '' }
