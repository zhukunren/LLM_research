import names from './columnNames.zh-CN.json'

type Labels = Readonly<Record<string, string>>
export type TushareColumn = { field: string; label: string }

// The per-dataset entries use the field definitions linked from the Tushare catalog.
// A field can represent a different measure or unit in another dataset.
const common: Labels = names.common
const datasets: Readonly<Record<string, Labels>> = names.datasets

export function tushareColumns(dataset: string, fields: string[]): TushareColumn[] {
  const local: Labels = Object.hasOwn(datasets, dataset) ? datasets[dataset] : {}
  const columns = fields.map(field => ({
    field,
    label: Object.hasOwn(local, field) ? local[field] : Object.hasOwn(common, field) ? common[field] : field,
  }))
  const counts = new Map<string, number>()
  for (const { label } of columns) counts.set(label, (counts.get(label) ?? 0) + 1)

  return columns.map(column => (counts.get(column.label) ?? 0) > 1
    ? { ...column, label: `${column.label}（${column.field}）` }
    : column)
}
