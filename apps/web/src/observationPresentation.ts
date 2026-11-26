export const watchLabels: Record<string, string> = { watching: '观察中', priority: '重点关注', ended: '结束观察' }
export const observationOwners: Record<string, string> = { research: '研究', manual: '手动', screening: '选股' }

export const percent = (value: number | null | undefined) => value == null ? '—' : (value > 0 ? '+' : '') + value.toFixed(2) + '%'
export const returnClass = (value: number | null | undefined) => value == null || value === 0 ? 'observation-neutral' : value > 0 ? 'observation-up' : 'observation-down'
