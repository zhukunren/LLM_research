import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useRemoteResource } from '../../useRemoteResource'
import { Change, FeatureNotes, FeatureStatus, FeatureTable, type RotationSnapshot } from './FeatureData'

const windows = ['1', '5', '20'] as const
const boards = [{ id: 'U', label: '涨停' }, { id: 'D', label: '跌停' }, { id: 'Z', label: '炸板' }, { id: 'streak', label: '连板' }] as const

export function RotationData({ data }: { data: RotationSnapshot }) {
  const [window, setWindow] = useState<typeof windows[number]>('1')
  const [board, setBoard] = useState<typeof boards[number]['id']>('U')
  const rows = [...data.industries].sort((a, b) =>
    Number(a.returns[window] == null) - Number(b.returns[window] == null)
    || (b.returns[window] ?? 0) - (a.returns[window] ?? 0) || a.code.localeCompare(b.code))
  const boardRows = board === 'streak'
    ? data.streaks.map(row => ({ code: row.code, name: row.name, detail: row.days + ' 板' }))
    : data.limits[board]?.map(row => ({ code: row.code, name: row.name, detail: row.open_times == null ? '—' : row.open_times + ' 次' }))
  return <section className="tushare-feature" aria-label="盘面复盘数据">
    <p className="tushare-meta">{data.trade_date ? data.trade_date + ' 收盘 · 申万一级行业' : data.as_of + ' · 暂无可用收盘数据'}</p>
    {data.breadth && <div className="tushare-metrics">
      <div><span>上涨家数</span><strong className="tushare-change is-up">{data.breadth.up.toLocaleString('zh-CN')}</strong></div>
      <div><span>下跌家数</span><strong className="tushare-change is-down">{data.breadth.down.toLocaleString('zh-CN')}</strong></div>
      <div><span>平盘家数</span><strong>{data.breadth.flat.toLocaleString('zh-CN')}</strong><small>有涨跌幅 {data.breadth.covered} 家</small></div>
    </div>}
    {!!rows.length && <>
      <div className="tushare-section-heading"><h3>行业涨跌</h3><label className="workspace-field-label">按涨跌幅排序<select className="workspace-field workspace-select" value={window} onChange={event => setWindow(event.target.value as typeof window)}>
        {windows.map(value => <option key={value} value={value}>近 {value} 个交易日</option>)}
      </select></label></div>
      <FeatureTable label="申万行业涨跌"><thead><tr><th scope="col">行业</th>
        {windows.map(value => <th key={value} scope="col" className="is-number" aria-sort={window === value ? 'descending' : 'none'}>{value} 日涨跌</th>)}
        <th scope="col" className="is-number">上涨 / 有行情成分</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.code}><th scope="row">{row.name}</th>{windows.map(value => <td key={value} className="is-number"><Change value={row.returns[value]} /></td>)}
          <td className="is-number">{row.breadth?.covered ? row.breadth.up + ' / ' + row.breadth.covered : '—'}</td></tr>)}</tbody>
      </FeatureTable>
    </>}
    {!!data.trade_date && <section className="tushare-board">
      <div className="tushare-section-heading"><h3>涨跌停与连板名单</h3>
        <p className="tushare-meta">涨跌停和炸板统计排除 ST。炸板指触及涨停后打开。</p></div>
      <div className="tushare-switch" role="group" aria-label="盘面名单类型">{boards.map(item => {
        const count = item.id === 'streak' ? data.streaks.length : data.limits[item.id]?.length
        return <button key={item.id} type="button" className="workspace-button" aria-pressed={board === item.id} onClick={() => setBoard(item.id)}>{item.label} {count ?? '—'}</button>
      })}</div>
      {boardRows?.length ? <FeatureTable label={boards.find(item => item.id === board)!.label + '名单'}><thead><tr><th scope="col">股票</th><th scope="col">代码</th><th scope="col" className="is-number">{board === 'streak' ? '连续涨停' : '打开次数'}</th></tr></thead>
        <tbody>{boardRows.map(row => <tr key={row.code}><th scope="row">{row.name}</th><td>{row.code}</td><td className="is-number">{row.detail}</td></tr>)}</tbody></FeatureTable>
        : <p className="tushare-empty">{boardRows ? '该日暂无对应名单记录。' : '该日名单数据待补齐。'}</p>}
    </section>}
    <FeatureNotes {...data} />
  </section>
}

export default function RotationPanel({ asOf, snapshot }: { asOf?: string | null; snapshot?: RotationSnapshot }) {
  const [open, setOpen] = useState(false)
  const resource = useRemoteResource<RotationSnapshot>(open && !snapshot ? '/tushare-features/rotation' + (asOf ? '?as_of=' + asOf : '') : null)
  const data = snapshot || resource.data
  return <details className="tushare-disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><ChevronDown size={16} aria-hidden="true" />{snapshot ? '本版盘面复盘数据' : '查看盘面复盘数据'}</summary>
    {open && <FeatureStatus {...resource} label="盘面复盘">{data && <RotationData data={data} />}</FeatureStatus>}
  </details>
}
