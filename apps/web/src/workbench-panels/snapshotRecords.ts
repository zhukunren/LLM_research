import { element } from './workspaceDeck'
import { stateTone, type PanelView } from './panelViews'
import { display, type Column, type Definition, type Row } from './snapshotPresentation'

export type FieldValue = (row: Row, column: Column, editable?: boolean) => HTMLElement

export function metric(label: string, value = '') {
  const field = element('div', '', 'observation-summary-value')
  const count = element('strong', value)
  field.append(element('span', label), count)
  return { field, count }
}

function detailsList(columns: Column[], row: Row, value: FieldValue, editable = false) {
  const list = element('dl', '', 'snapshot-record-fields')
  for (const column of columns) {
    const field = element('div')
    const content = element('dd')
    content.append(value(row, column, editable))
    field.append(element('dt', column.label), content)
    list.append(field)
  }
  return list
}

function patternPreview(row: Row) {
  const points = row.preview_points
  if (!Array.isArray(points) || points.length < 2 || !points.every(value => Number.isFinite(value))) return
  const figure = element('figure', '', 'snapshot-pattern-preview')
  const canvas = element('canvas')
  canvas.width = 480
  canvas.height = 92
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', '模板收盘路径')
  const context = canvas.getContext('2d')
  if (!context) return
  const styles = getComputedStyle(document.documentElement)
  const inset = 9
  const low = Math.min(...points)
  const span = Math.max(...points) - low || 1
  const plotHeight = canvas.height - inset * 2
  context.strokeStyle = styles.getPropertyValue('--ui-border')
  for (const factor of [0.25, 0.5, 0.75]) {
    const y = inset + plotHeight * factor
    context.beginPath()
    context.moveTo(inset, y)
    context.lineTo(canvas.width - inset, y)
    context.stroke()
  }
  context.beginPath()
  points.forEach((point, index) => {
    const x = inset + index / (points.length - 1) * (canvas.width - inset * 2)
    const y = inset + plotHeight * (1 - (point - low) / span)
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  })
  context.strokeStyle = styles.getPropertyValue('--ui-primary')
  context.lineWidth = 2
  context.stroke()
  figure.append(canvas, element('figcaption', '模板收盘路径'))
  return figure
}

function mountLibrary(view: PanelView, definition: Definition, value: FieldValue) {
  const container = element('div', '', 'snapshot-library')
  const rail = element('nav', '', 'snapshot-library-rail')
  rail.setAttribute('aria-label', '资料目录')
  const reader = element('article', '', 'snapshot-library-reader')
  reader.setAttribute('aria-label', '所选资料')
  container.append(rail, reader)
  const buttons = new Map<Row, HTMLButtonElement>()
  const facts = definition.columns.filter(column => view.facts?.includes(column.key))
  let selected: Row | undefined

  function choose(row: Row) {
    if (selected) buttons.get(selected)?.removeAttribute('aria-current')
    selected = row
    buttons.get(row)?.setAttribute('aria-current', 'true')
    const title = element('h2', display(row[view.title ?? '']))
    reader.replaceChildren(title, detailsList(facts, row, value))
    if (view.summary && row[view.summary]) reader.append(element('p', display(row[view.summary]), 'snapshot-library-excerpt'))
  }

  return {
    container,
    render(rows: Row[]) {
      buttons.clear()
      rail.replaceChildren(...rows.map(row => {
        const button = element('button', '', 'snapshot-library-link')
        button.type = 'button'
        button.append(element('strong', display(row[view.title ?? ''])))
        const context = facts.filter(column => row[column.key] != null && row[column.key] !== '')
          .map(column => display(row[column.key], column)).join(' · ')
        if (context) button.append(element('small', context))
        button.addEventListener('click', () => choose(row))
        buttons.set(row, button)
        return button
      }))
      if (rows.length) choose(selected && buttons.has(selected) ? selected : rows[0])
    },
  }
}

export function mountRecords(view: PanelView, definition: Definition, value: FieldValue) {
  if (view.layout === 'library') return mountLibrary(view, definition, value)
  const container = element('div', '', `snapshot-records snapshot-${view.layout}`)
  const loaded = new WeakMap<Row, HTMLElement>()
  const shownFields = view.facts?.flatMap(key => definition.columns.filter(column => column.key === key)) ?? []

  function createRecord(row: Row) {
    if (view.layout === 'coverage') {
      const coverage = element('section', '', 'snapshot-coverage-card')
      coverage.append(element('h2', '行情与资讯'), element('p', row.last_date ? `行情更新至 ${row.last_date}` : '暂无行情覆盖日期'),
        detailsList(definition.columns, row, value))
      return coverage
    }
    const record = element('article', '', 'snapshot-record')
    const title = definition.columns.find(column => column.key === view.title)
    const badge = definition.columns.find(column => column.key === view.badge)
    const heading = element('span', '', 'snapshot-record-heading')
    const name = element('strong', display(title ? row[title.key] : undefined, title))
    heading.append(name)
    if (badge && row[badge.key] != null && row[badge.key] !== '') {
      const status = element('span', display(row[badge.key], badge), 'snapshot-state')
      status.dataset.tone = stateTone(row[badge.key])
      heading.append(status)
    }
    if (view.layout === 'timeline') {
      const time = element('time', display(row['template.time']), 'snapshot-timeline-time')
      record.append(time)
    }
    const body = element('div', '', 'snapshot-record-body')
    record.append(body)
    if (view.layout === 'pattern' || view.layout === 'strategy' || view.layout === 'timeline') {
      body.append(heading)
      if (view.layout === 'pattern') {
        const preview = patternPreview(row)
        if (preview) body.append(preview)
      }
      if (shownFields.length) body.append(detailsList(shownFields, row, value))
      return record
    }
    const details = element('details')
    const summary = element('summary')
    summary.append(heading)
    const excerpt = view.summary && row[view.summary] ? element('span', display(row[view.summary]), 'snapshot-record-excerpt') : null
    if (excerpt) summary.append(excerpt)
    details.append(summary)
    const fields = definition.columns.filter(column => column.edit || (column.key !== title?.key && !shownFields.includes(column)))
    if (fields.length) details.append(detailsList(fields, row, value, true))
    body.append(details)
    if (shownFields.length) body.append(detailsList(shownFields, row, value))
    record.addEventListener('input', () => {
      if (title) name.textContent = display(row[title.key], title)
      if (excerpt && view.summary) excerpt.textContent = display(row[view.summary])
    })
    return record
  }

  return {
    container,
    render(rows: Row[]) {
      const records = rows.map(row => {
        let record = loaded.get(row)
        if (!record) {
          record = createRecord(row)
          loaded.set(row, record)
        }
        return record
      })
      container.replaceChildren(...records)
    },
  }
}
