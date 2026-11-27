import { catalog, chartPoints, display, labelsFor, panelChanges, type Column, type Row, type SnapshotPanelData } from './snapshotPresentation'
import { element, type PanelMount } from './workspaceDeck'
import { panelViews, stateTone } from './panelViews'
import { metric, mountRecords } from './snapshotRecords'
import { returnClass, watchLabels } from '../observationPresentation'
import { fullTimeDescription, parsedTime, shortTime } from '../timeLabels'

export const mountSnapshotPanel: PanelMount = (target: HTMLElement, data: SnapshotPanelData) => {
  const definition = catalog[data.panel]
  const view = panelViews[data.panel as keyof typeof panelViews]
  const rows = data.rows.map(row => ({ ...row }))
  const surface = element('section', '', 'snapshot-panel')
  const heading = element('header', '', 'page-heading')
  heading.append(element('h1', view.heading ?? definition.title))
  if (data.date) heading.append(element('p', '数据日期 ' + data.date))
  if (Number.isFinite(data.sampleSize)) heading.append(element('p', `近 ${data.sampleSize} 笔已平仓样本`))
  const loaded = metric('已载入', data.partial ? `${rows.length} 条` : `${rows.length} / ${data.total} 条`)
  const shown = metric('当前显示')
  const summary = element('div', '', 'snapshot-metrics')
  summary.setAttribute('role', 'status')
  summary.append(loaded.field, shown.field)
  const statistics = data.panel === 'observation' ? Object.entries(watchLabels).map(([key, label]) => ({ key, ...metric(label) }))
    : view.layout === 'strategy' ? ['buy_count', 'sell_count'].map((key, index) => ({ key, ...metric(['买入信号', '卖出信号'][index]) })) : []
  summary.append(...statistics.map(item => item.field))

  const controls = element('div', '', 'workspace-filters')
  const choices = element('div', '', 'snapshot-filter-tabs')
  const graph = element('section', '', 'snapshot-chart')
  const table = element('table', '', 'workspace-data-table')
  table.setAttribute('aria-label', definition.title)
  const body = table.createTBody()
  const columns = table.createTHead().insertRow()
  const scroll = element('div', '', 'workspace-table-scroll')
  const empty = element('p', '', 'snapshot-empty')
  const changes = element('details', '', 'snapshot-changes')
  const draft = element('textarea', '', 'workspace-field')
  draft.readOnly = true
  draft.setAttribute('aria-label', '修改单')
  changes.append(element('summary', '查看修改单'), element('p', '将修改单发给助理并说明要保存的改动。'), draft)
  scroll.append(table)
  const records = view.layout === 'table' ? null : mountRecords(view, definition, field)
  const results = records?.container ?? scroll
  surface.append(heading)
  if (view.layout !== 'coverage') surface.append(controls, choices, summary)
  if (data.notice) surface.append(element('p', data.notice, 'snapshot-notice'))
  if (view.layout === 'table') surface.append(graph, results, empty)
  else surface.append(results, empty, graph)
  surface.append(changes)
  target.append(surface)

  const search = element('input', '', 'workspace-field')
  search.type = 'search'
  search.placeholder = definition.search
  search.setAttribute('aria-label', definition.search)
  const searchField = element('label', '', 'workspace-field-shell workspace-search')
  searchField.append(search)
  controls.append(searchField)
  const filters = new Map<string, string>()
  for (const key of [definition.filter, definition.secondFilter]) {
    const column = definition.columns.find(item => item.key === key)
    if (!column) continue
    const actual = new Set(rows.map(row => String(row[column.key] ?? '')).filter(Boolean))
    if (view.filterTabs === key) {
      const all = [...new Set([...Object.keys(labelsFor(column) ?? {}), ...actual])]
      choices.setAttribute('aria-label', column.label + '筛选')
      choices.setAttribute('role', 'group')
      for (const choice of ['', ...all]) {
        const button = element('button', choice ? display(choice, column) : '全部' + column.label)
        button.type = 'button'
        button.setAttribute('aria-pressed', String(!choice))
        button.addEventListener('click', () => {
          for (const item of choices.children) item.setAttribute('aria-pressed', String(item === button))
          filters.set(column.key, choice)
          refresh()
        })
        choices.append(button)
      }
    } else {
      const field = element('select', '', 'workspace-field workspace-select')
      field.setAttribute('aria-label', column.label + '筛选')
      field.add(new Option('全部' + column.label, ''))
      for (const choice of actual) field.add(new Option(display(choice, column), choice))
      field.addEventListener('change', () => { filters.set(column.key, field.value); refresh() })
      controls.append(field)
    }
  }
  choices.hidden = !choices.childElementCount

  let chartFilter: [string, string] | undefined
  let sort: { key: string; direction: number } | undefined
  const clearChart = element('button', '清除图表筛选', 'text-button workspace-button')
  clearChart.addEventListener('click', () => { chartFilter = undefined; refresh() })
  if (records && rows.length > 1) {
    const order = element('select', '', 'workspace-field workspace-select')
    order.setAttribute('aria-label', '排序')
    order.add(new Option('默认顺序', ''))
    for (const column of definition.columns) {
      order.add(new Option(`${column.label} · 升序`, '+' + column.key))
      order.add(new Option(`${column.label} · 降序`, '-' + column.key))
    }
    order.addEventListener('change', () => {
      sort = order.value ? { key: order.value.slice(1), direction: order.value.startsWith('+') ? 1 : -1 } : undefined
      refresh()
    })
    controls.append(order)
  }
  controls.append(clearChart)
  search.addEventListener('input', refresh)

  function visibleRows() {
    const term = search.value.trim().toLocaleLowerCase('zh-CN')
    const selected = rows.filter(row => (
      [...filters].every(([key, choice]) => !choice || String(row[key] ?? '') === choice) &&
      (!chartFilter || String(row[chartFilter[0]] ?? '') === chartFilter[1]) &&
      (!term || definition.columns.some(column => (display(row[column.key], column) + ' ' +
        (column.detail ? display(row[column.detail]) : '')).toLocaleLowerCase('zh-CN').includes(term)))
    ))
    if (!sort) return selected
    const { key, direction } = sort
    return selected.sort((a, b) => {
      const left = a[key], right = b[key]
      if (left == null) return right == null ? 0 : 1
      if (right == null) return -1
      const order = typeof left === 'number' && typeof right === 'number'
        ? left - right : String(left).localeCompare(String(right), 'zh-CN', { numeric: true })
      return direction * order
    })
  }

  function renderGraph(visible: Row[]) {
    const config = definition.chart
    const category = config?.group ?? config?.label
    const points = category ? chartPoints(visible, category, config?.metric) : []
    graph.hidden = !points.length
    graph.replaceChildren()
    if (!config || !category || !points.length) return
    graph.setAttribute('aria-label', config.title)
    graph.append(element('h2', config.title))
    const labelColumn = definition.columns.find(item => item.key === category)
    const metricColumn = definition.columns.find(item => item.key === config.metric)
    const max = Math.max(1, ...points.map(([, value]) => Math.abs(value)))
    for (const [label, value] of points) {
      const button = element('button', '', 'snapshot-graph-bar')
      const meter = element('span', '', 'snapshot-graph-meter')
      const fill = element('span')
      fill.style.width = (Math.abs(value) / max * 100) + '%'
      meter.append(fill)
      button.append(element('span', display(label, labelColumn)), meter, element('span', display(value, metricColumn)))
      button.setAttribute('aria-pressed', String(chartFilter?.[0] === category && chartFilter[1] === label))
      button.addEventListener('click', () => {
        chartFilter = chartFilter?.[0] === category && chartFilter[1] === label ? undefined : [category, label]
        refresh()
      })
      graph.append(button)
    }
  }

  function updateDraft() {
    const pending = panelChanges(data.panel, definition, data.rows, rows)
    changes.hidden = !pending.length
    draft.value = JSON.stringify(pending, null, 2)
  }

  function field(row: Row, column: Column, editable = false) {
    const value = row[column.key]
    if (editable && column.edit) {
      const editor = column.edit === 'select' ? element('select', '', 'workspace-field workspace-select') : element('input', '', 'workspace-field')
      if (editor instanceof HTMLSelectElement) {
        const options = Object.entries(labelsFor(column) ?? {})
        if (!options.some(([key]) => key === value)) editor.add(new Option(display(value, column), String(value ?? '')))
        options.forEach(([key, label]) => editor.add(new Option(label ?? key, key)))
      } else if (typeof column.edit === 'number') editor.maxLength = column.edit
      editor.value = String(value ?? '')
      editor.setAttribute('aria-label', column.label)
      editor.addEventListener('input', () => {
        row[column.key] = editor.value
        updateDraft()
        updateStatistics(visibleRows())
      })
      return editor
    }
    if (column.format === 'time' && typeof value === 'string' && value) {
      const date = parsedTime(value)
      const time = element('time', shortTime(date, undefined, false))
      if (date) time.dateTime = date.toISOString()
      time.title = fullTimeDescription(value)
      return time
    }
    const label = element('span', display(value, column))
    if (column.key === 'status' || column.key === 'state' || column.key === 'last_turn_state') {
      label.className = 'snapshot-state'
      label.dataset.tone = stateTone(value)
    }
    return label
  }

  function cell(column: Column, row: Row) {
    const item = element('td')
    const value = row[column.key]
    if (column.format) item.dataset.format = column.format
    if (column.format === 'market-percent') item.className = returnClass(typeof value === 'number' ? value : null)
    item.append(field(row, column, true))
    if (column.detail && row[column.detail]) item.append(element('small', display(row[column.detail])))
    return item
  }

  if (!records) for (const column of definition.columns) {
    const heading = element('th')
    if (column.format) heading.dataset.format = column.format
    const button = element('button', column.label, 'snapshot-sort workspace-button')
    button.addEventListener('click', () => {
      sort = { key: column.key, direction: sort?.key === column.key ? -sort.direction : 1 }
      for (const other of columns.cells) other.removeAttribute('aria-sort')
      heading.setAttribute('aria-sort', sort.direction === 1 ? 'ascending' : 'descending')
      refresh()
    })
    heading.append(button)
    columns.append(heading)
  }

  function updateStatistics(visible: Row[]) {
    shown.count.textContent = `${visible.length} 条`
    for (const item of statistics) {
      const counts = visible.flatMap(row => {
        const value = row[item.key]
        return typeof value === 'number' ? [value] : []
      })
      item.count.textContent = view.layout === 'strategy'
        ? (counts.length ? String(counts.reduce((sum, value) => sum + value, 0)) : '—')
        : String(visible.filter(row => row.status === item.key).length)
    }
    renderGraph(visible)
  }

  function refresh() {
    const visible = visibleRows()
    clearChart.hidden = !chartFilter
    empty.hidden = visible.length > 0
    empty.textContent = data.unavailable ? '面板数据暂不可用' : rows.length ? '没有匹配的记录' : '当前没有记录'
    results.hidden = !visible.length
    if (records) records.render(visible)
    else body.replaceChildren(...visible.map(row => {
      const line = element('tr')
      line.append(...definition.columns.map(column => cell(column, row)))
      return line
    }))
    updateStatistics(visible)
  }

  updateDraft()
  refresh()
}
