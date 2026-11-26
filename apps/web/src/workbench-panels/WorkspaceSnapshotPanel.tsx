import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import EmptyState from '../components/EmptyState'
import TimeLabel from '../components/TimeLabel'
import WorkspaceChart from '../components/WorkspaceChart'
import { WorkspaceDataTable, WorkspaceMetric, WorkspaceSearchField, WorkspaceSelect } from '../components/WorkspaceDataControls'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import { chartPalette } from '../chartTheme'
import { serviceStateLabels } from '../clientServicePresentation'
import { signalPercent } from '../dailySignals'
import { observationOwners, percent, returnClass, watchLabels } from '../observationPresentation'
import definitions from './catalog.json'

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

type Value = string | number | boolean | null
type Row = Record<string, Value>
type Column = { key: string; label: string; detail?: string; format?: string; labels?: Record<string, string | undefined>; edit?: number | string }
type Chart = { title: string; group?: string; label?: string; metric?: string; format?: string }
type Definition = { title: string; search: string; columns: Column[]; filter?: string; secondFilter?: string; chart?: Chart; identity: string[] }
const catalog: Record<string, Definition> = definitions

export type SnapshotPanelData = { panel: string; rows: Row[]; total: number; date?: string; notice?: string; unavailable?: boolean; partial?: boolean }

function labelsFor(column: Column | undefined): Record<string, string | undefined> | undefined {
  if (column?.format === 'observation-status') return watchLabels
  if (column?.format === 'observation-owner') return observationOwners
  if (column?.format === 'service-state') return serviceStateLabels
  return column?.labels
}

function display(value: Value | undefined, column?: Column): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'number') {
    if (column?.format === 'market-percent') return percent(value)
    if (column?.format === 'signal-percent') return signalPercent(value)
    if (column?.format === 'number') return value.toLocaleString('zh-CN')
  }
  return labelsFor(column)?.[String(value)] || String(value)
}

function panelChanges(panel: string, definition: Definition, original: Row[], rows: Row[]) {
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

function PanelChart({ chart, columns, rows, onSelect }: { chart: Chart; columns: Column[]; rows: Row[]; onSelect: (key: string, value: string) => void }) {
  const category = chart.group ?? chart.label
  if (!category) return null
  const column = columns.find(item => item.key === category)
  const bins = new Map<string, number>()
  for (const row of rows) {
    const key = String(row[category] ?? '')
    if (chart.metric) {
      const metric = row[chart.metric]
      if (typeof metric === 'number' && Number.isFinite(metric)) bins.set(key, metric)
    } else {
      bins.set(key, (bins.get(key) ?? 0) + 1)
    }
  }
  const points = [...bins]
  if (!points.length) return null
  const metricColumn = columns.find(item => item.key === chart.metric)
  const option = {
    animation: false, textStyle: { fontFamily: chartPalette.fontFamily, color: chartPalette.text },
    grid: { left: 10, right: 72, top: 6, bottom: 10, containLabel: true },
    xAxis: { type: 'value' as const, show: false },
    yAxis: { type: 'category' as const, inverse: true, data: points.map(([value]) => display(value, column)),
      axisLabel: { color: chartPalette.muted, width: 158, overflow: 'truncate' as const }, axisTick: { show: false }, axisLine: { show: false } },
    series: [{ type: 'bar' as const, barMaxWidth: 14, data: points.map(([, count]) => count),
      itemStyle: { color: chartPalette.primary, borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right' as const, color: chartPalette.text, formatter: ({ value }: { value: unknown }) => display(typeof value === 'number' ? value : null, metricColumn) } }],
  }
  return <section className="snapshot-chart" aria-label={chart.title}>
    <h2>{chart.title}</h2>
    <WorkspaceChart option={option} notMerge style={{ height: Math.max(88, points.length * 27 + 20) }}
      onEvents={{ click: (event: { dataIndex: number }) => { if (points[event.dataIndex]) onSelect(category, points[event.dataIndex][0]) } }} />
    <div className="snapshot-chart-filters" aria-label="按图表筛选">
      {points.map(([value, count]) => <button type="button" className="text-button workspace-button" key={value} onClick={() => onSelect(category, value)}>{display(value, column)} {display(count, metricColumn)}</button>)}
    </div>
  </section>
}

export default function WorkspaceSnapshotPanel({ data, active }: { data: SnapshotPanelData; active: boolean }) {
  const definition = Object.hasOwn(catalog, data.panel) ? catalog[data.panel] : undefined
  const [rows, setRows] = useState(data.rows)
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [chartFilter, setChartFilter] = useState<{ key: string; value: string }>()
  const [sort, setSort] = useState<{ key: string; direction: 'ascending' | 'descending' }>()
  const list = useMemo(() => {
    if (!definition) return []
    const term = query.trim().toLocaleLowerCase('zh-CN')
    const results = rows.map((row, index) => ({ row, index })).filter(({ row }) =>
      Object.entries(filters).every(([field, selected]) => !selected || String(row[field] ?? '') === selected) &&
      (!chartFilter || String(row[chartFilter.key] ?? '') === chartFilter.value) &&
      (!term || definition.columns.some(column => (display(row[column.key], column) + ' ' + (column.detail ? display(row[column.detail]) : '')).toLocaleLowerCase('zh-CN').includes(term))))
    if (!sort) return results
    return results.sort((a, b) => {
      const left = a.row[sort.key], right = b.row[sort.key]
      if (left == null) return right == null ? 0 : 1
      if (right == null) return -1
      const diff = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), 'zh-CN', { numeric: true })
      return sort.direction === 'ascending' ? diff : -diff
    })
  }, [definition, rows, query, filters, chartFilter, sort])
  if (!definition) return <EmptyState title="这个面板暂不可用" compact />

  const changes = panelChanges(data.panel, definition, data.rows, rows)
  function edit(index: number, key: string, value: string) {
    setRows(current => current.map((row, position) => position === index ? { ...row, [key]: value } : row))
  }
  const filterNames = [definition.filter, definition.secondFilter].filter((key): key is string => !!key)
  return <main className="snapshot-panel workspace-tool-page">
    <WorkspacePageHeading actions={null}>
      <h1>{definition.title}</h1>
      {data.date && <p>数据日期 {data.date}</p>}
    </WorkspacePageHeading>
    <div className="workspace-filters">
      <WorkspaceSearchField type="search" className="workspace-search" aria-label={definition.search} placeholder={definition.search} value={query} onChange={event => setQuery(event.target.value)} />
      {filterNames.map(key => {
        const column = definition.columns.find(item => item.key === key)
        const options = [...new Set(rows.map(row => String(row[key] ?? '')).filter(Boolean))]
        return <WorkspaceSelect key={key} aria-label={`${column?.label ?? key}筛选`} value={filters[key] ?? ''} onChange={event => setFilters(current => ({ ...current, [key]: event.target.value }))}>
          <option value="">全部{column?.label ?? key}</option>
          {options.map(value => <option key={value} value={value}>{display(value, column)}</option>)}
        </WorkspaceSelect>
      })}
      {chartFilter && <button type="button" className="text-button workspace-button" onClick={() => setChartFilter(undefined)}>清除图表筛选</button>}
    </div>
    <div className="snapshot-metrics" role="status">
      <WorkspaceMetric label="已载入" value={data.partial ? `${rows.length} 条` : `${rows.length} / ${data.total.toLocaleString('zh-CN')} 条`} />
      <WorkspaceMetric label="当前显示" value={`${list.length} 条`} />
      {!!changes.length && <WorkspaceMetric label="修改草稿" value={`${changes.length} 条`} />}
    </div>
    {data.notice && <p className="snapshot-notice" role="status">{data.notice}</p>}
    {active && definition.chart && !!list.length && <PanelChart chart={definition.chart} columns={definition.columns} rows={list.map(item => item.row)}
      onSelect={(key, value) => setChartFilter(previous => previous?.key === key && previous.value === value ? undefined : { key, value })} />}
    {list.length ? <div className="workspace-table-scroll" tabIndex={0} aria-label={definition.title}>
      <WorkspaceDataTable aria-label={definition.title}>
        <thead><tr>{definition.columns.map(column => <th key={column.key} aria-sort={sort?.key === column.key ? sort.direction : 'none'}>
          <button type="button" className="snapshot-sort workspace-button" onClick={() => setSort(current => ({ key: column.key, direction: current?.key === column.key && current.direction === 'ascending' ? 'descending' : 'ascending' }))}>
            {column.label}{sort?.key === column.key ? sort.direction === 'ascending' ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : <ArrowUpDown size={13} />}
          </button>
        </th>)}</tr></thead>
        <tbody>{list.map(({ row, index }) => <tr key={index}>{definition.columns.map(column => {
          const value = row[column.key]
          const name = String(row.name || row.title || row.stock_code || `第 ${index + 1} 条`)
          const labels = labelsFor(column)
          return <td key={column.key} className={column.format === 'market-percent' ? returnClass(typeof value === 'number' ? value : null) : undefined}>
            {column.edit === 'select' && labels ? <WorkspaceSelect aria-label={`${name} ${column.label}`} value={String(value ?? '')} onChange={event => edit(index, column.key, event.target.value)}>
              {Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </WorkspaceSelect> : typeof column.edit === 'number' ? <input className="workspace-field" aria-label={`${name} ${column.label}`} maxLength={column.edit} value={String(value ?? '')} onChange={event => edit(index, column.key, event.target.value)} /> :
              column.format === 'time' && typeof value === 'string' && value ? <TimeLabel value={value} hour12={false} /> : display(value, column)}
            {column.detail && row[column.detail] && <small>{display(row[column.detail])}</small>}
          </td>
        })}</tr>)}</tbody>
      </WorkspaceDataTable>
    </div> : <EmptyState compact title={data.unavailable ? '面板数据暂不可用' : rows.length ? '没有匹配的记录' : '当前没有记录'} />}
    {!!changes.length && <details className="snapshot-changes">
      <summary>查看修改单</summary>
      <p>将修改单复制给 Agent，请它核对后保存到工作台。</p>
      <textarea readOnly className="workspace-field" aria-label="修改单" rows={5} value={JSON.stringify(changes, null, 2)} onFocus={event => event.currentTarget.select()} />
    </details>}
  </main>
}
