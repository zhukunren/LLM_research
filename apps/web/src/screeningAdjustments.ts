import type { ScreeningTaskRevision } from './api'

export type ScreeningAdjustment = { id: string; label: string; prompt: string }

type Condition = ScreeningTaskRevision['conditions'][number]

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

function suggestion(condition: Condition, key: string, label: string): ScreeningAdjustment {
  return {
    id: `${condition.condition_id}:${key}`,
    label,
    prompt: `在保留其他条件的前提下，${label}，然后重新筛选。`,
  }
}

/**
 * Conservative, parameter-level adjustments for a zero-match result. Only
 * known parameter names on technical conditions are proposed; the model still
 * creates the next plan, so the user can review it before running.
 */
export function screeningAdjustments(task?: ScreeningTaskRevision | null): ScreeningAdjustment[] {
  if (!task) return []
  const adjustments: ScreeningAdjustment[] = []
  for (const condition of task.conditions) {
    const parameters = condition.program?.parameters ?? {}
    const description = condition.description
    if (typeof parameters.threshold === 'number') {
      const current = parameters.threshold
      if (/RSI/i.test(description) && /(?:小于|<|低于)/.test(description)) {
        const next = Math.min(90, Math.round(current + 5))
        if (next > current) adjustments.push(suggestion(condition, 'threshold', `把 RSI 阈值从 ${formatNumber(current)} 放宽到 ${next}`))
      } else if (/(?:涨幅|收益|return|收盘价\s*[\/÷])/i.test(description)) {
        const next = Number((current >= 2 ? current - 1 : current * 0.7).toFixed(2))
        if (next > 0 && next < current) adjustments.push(suggestion(condition, 'threshold', `把涨幅阈值从 ${formatNumber(current)}% 放宽到 ${formatNumber(next)}%`))
      } else if (/(?:成交量|量比|放量|volume)/i.test(description)) {
        const next = Number(Math.max(1.05, current * 0.8).toFixed(2))
        if (next < current) adjustments.push(suggestion(condition, 'threshold', `把放量阈值从 ${formatNumber(current)} 倍放宽到 ${formatNumber(next)} 倍`))
      }
    }
    if (typeof parameters.window === 'number' && /(?:SMA|均线|移动平均)/.test(description)) {
      const current = parameters.window
      const next = Math.max(2, current - 5)
      if (next < current) adjustments.push(suggestion(condition, 'window', `把均线周期从 ${formatNumber(current)} 日缩短到 ${next} 日`))
    }
    if (typeof parameters.slow === 'number' && typeof parameters.fast === 'number' && /(?:SMA|均线|移动平均)/.test(description)) {
      const current = parameters.slow
      const next = Math.max(parameters.fast + 1, current - 5)
      if (next < current) adjustments.push(suggestion(condition, 'slow', `把长均线周期从 ${formatNumber(current)} 日缩短到 ${next} 日`))
    }
  }
  const unique = new Map(adjustments.map(item => [item.label, item]))
  return [...unique.values()].slice(0, 3)
}
