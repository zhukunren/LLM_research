import { useId, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import Pagination from '../components/Pagination'
import { FeatureTable } from '../components/tushare/FeatureData'
import { tushareColumns, type TushareColumn } from '../components/tushare/tushareColumnNames'

const pageSize = 30

export type TushareResult = {
  label: string; filename: string; file: Blob; columns: TushareColumn[]; count: number
  readRows: (offset: number) => string[][]
}

function readRecord(text: string, from: number, to: number) {
  const record = text.slice(from, to).replace(/\r\n$|[\r\n]$/, '')
  const cells: string[] = []
  let start = 0, quoted = false
  for (let index = 0; index <= record.length; index += 1) {
    const character = record[index]
    if (character === '"') quoted = !quoted
    if (index === record.length || (character === ',' && !quoted)) {
      const value = record.slice(start, index)
      cells.push(value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value)
      start = index + 1
    }
  }
  return cells
}

export async function readTushareResult(response: Response, dataset: { id: string; label: string }): Promise<TushareResult> {
  const filename = response.headers.get('Content-Disposition')?.match(/filename="([a-z0-9._-]+\.csv)"/i)?.[1]
  if (!filename || !response.headers.get('Content-Type')?.startsWith('text/csv')) {
    throw new Error('服务没有返回可显示的数据，请重试。')
  }
  const original = await response.blob()
  const [text, prefix] = await Promise.all([original.text(), original.slice(0, 3).arrayBuffer()])
  const starts = [text.charCodeAt(0) === 0xFEFF ? 1 : 0]
  let quoted = false
  // Keep offsets for every record and decode cells only for the displayed page.
  for (let index = starts[0]; index < text.length; index += 1) {
    const character = text.charCodeAt(index)
    if (character === 34) quoted = !quoted
    if (!quoted && (character === 10 || character === 13)) {
      if (character === 13 && text.charCodeAt(index + 1) === 10) index += 1
      starts.push(index + 1)
    }
  }
  if (starts.at(-1) !== text.length) starts.push(text.length)
  const count = starts.length - 2
  const declared = response.headers.get('X-Row-Count')
  if (quoted || count < 1 || (declared !== null && Number(declared) !== count)) {
    throw new Error('查询结果格式异常，请重试。')
  }
  const columns = tushareColumns(dataset.id, readRecord(text, starts[0], starts[1]))
  const header = columns.map(({ label }) => /[",\r\n]/.test(label) ? `"${label.replace(/"/g, '""')}"` : label).join(',')
  const leading = new Uint8Array(prefix)
  const bomBytes = leading[0] === 0xef && leading[1] === 0xbb && leading[2] === 0xbf ? 3 : 0
  const bodyStart = bomBytes + new TextEncoder().encode(text.slice(starts[0], starts[1])).byteLength
  // Replace the header while preserving the queried rows in their original CSV encoding.
  const file = new Blob(['\uFEFF', header, '\r\n', original.slice(bodyStart)], { type: original.type })
  return {
    label: dataset.label, filename, file, count, columns,
    readRows: offset => Array.from({ length: Math.min(pageSize, count - offset) }, (_, index) => {
      const row = offset + index + 1
      return readRecord(text, starts[row], starts[row + 1])
    }),
  }
}

export default function TushareDownloadResult({ result }: { result: TushareResult }) {
  const id = useId()
  const [offset, setOffset] = useState(0)
  const rows = useMemo(() => result.readRows(offset), [offset, result])

  function save() {
    const url = URL.createObjectURL(result.file)
    const link = document.createElement('a')
    link.href = url
    link.download = result.filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <section className="tushare-download-results" aria-labelledby={id}>
    <header className="tushare-download-results-heading">
      <div className="tushare-download-results-title">
        <h2 id={id}>{result.label}</h2>
        <p role="status">共 {result.count.toLocaleString('zh-CN')} 条记录</p>
      </div>
      <button type="button" className="secondary-button workspace-button" onClick={save}>
        <Download size={16} aria-hidden="true" />下载 CSV
      </button>
    </header>
    <FeatureTable label="查询结果">
      <thead><tr>{result.columns.map(({ field, label }) =>
        <th key={field} scope="col" title={field}>{label}</th>,
      )}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={offset + index}>
        {result.columns.map(({ field }, columnIndex) => {
          const value = row[columnIndex] ?? ''
          return <td key={field} className={value.length > 36 || /[\r\n]/.test(value) ? 'tushare-download-long-cell' : undefined}>
            {value || <span className="tushare-download-empty-cell" aria-label="空值">—</span>}
          </td>
        })}
      </tr>)}</tbody>
    </FeatureTable>
    {result.count > pageSize && <Pagination label="查询结果分页" offset={offset} total={result.count} pageSize={pageSize} onChange={setOffset}
      summary={`${(offset + 1).toLocaleString('zh-CN')}–${Math.min(offset + pageSize, result.count).toLocaleString('zh-CN')} 条`} />}
  </section>
}
