import { serviceStateLabels } from '../clientServicePresentation'
import { signalPercent } from '../dailySignals'
import { observationOwners, percent, watchLabels } from '../observationPresentation'
import definitions from './catalog.json'

export type Value = string | number | boolean | readonly number[] | null
export type Row = Record<string, Value>
export type Column = { key: string; label: string; detail?: string; format?: string; labels?: Record<string, string | undefined>; edit?: number | string }
export type Chart = { title: string; group?: string; label?: string; metric?: string; format?: string }
export type Definition = { title: string; search: string; columns: Column[]; filter?: string; secondFilter?: string; chart?: Chart; identity: string[] }
export type SnapshotPanelData = { panel: string; rows: Row[]; total: number; date?: string; sampleSize?: number; notice?: string; unavailable?: boolean; partial?: boolean }

export const catalog: Record<string, Definition> = definitions

export function labelsFor(column: Column | undefined): Record<string, string | undefined> | undefined {
  if (column?.format === 'observation-status') return watchLabels
  if (column?.format === 'observation-owner') return observationOwners
  if (column?.format === 'service-state') return serviceStateLabels
  return column?.labels
}

export function display(value: Value | undefined, column?: Column): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'number') {
    if (column?.format === 'market-percent') return percent(value)
    if (column?.format === 'signal-percent') return signalPercent(value)
    if (column?.format === 'number') return value.toLocaleString('zh-CN')
  }
  return labelsFor(column)?.[String(value)] || String(value)
}

export function panelChanges(panel: string, definition: Definition, original: Row[], rows: Row[]) {
  const editable = definition.columns.filter(column => column.edit)
  return rows.flatMap((row, index) => {
    const before = original[index]
    const changed = editable.filter(column => row[column.key] !== before[column.key])
    if (!changed.length) return []
    return [{
      panel, identity: Object.fromEntries(definition.identity.map(key => [key, before[key]])),
      before: Object.fromEntries(changed.map(({ key }) => [key, before[key]])),
      after: Object.fromEntries(changed.map(({ key }) => [key, row[key]])),
    }]
  })
}

export function chartPoints(rows: Row[], category: string, metric?: string): Array<[string, number]> {
  const bins = new Map<string, number>()
  for (const row of rows) {
    const key = String(row[category] ?? '')
    if (metric) {
      const value = row[metric]
      if (typeof value === 'number' && Number.isFinite(value)) bins.set(key, value)
    } else {
      bins.set(key, (bins.get(key) ?? 0) + 1)
    }
  }
  return [...bins]
}
