import { useState } from 'react'
import Pagination from '../Pagination'
import { useRemoteResource } from '../../useRemoteResource'
import { FeatureNotes, FeatureStatus, FeatureTable, figures, shanghaiToday, type DataNotes } from './FeatureData'

const labels = { unlock: '限售股解禁', disclosure: '预约披露财报', holder_increase: '股东增持披露', holder_decrease: '股东减持披露' }
type Event = {
  kind: keyof typeof labels; code: string; name: string; date: string; ann_date: string
  shares?: number | null; shareholders?: number; period?: string; holder?: string
  start_date?: string | null; end_date?: string | null; ratio?: number | null
}
type EventCalendar = DataNotes & { as_of: string; upcoming_end: string; recent_start: string; stock_count: number; total: number; items: Event[] }
const pageSize = 15

export default function ObservationEvents() {
  const [date, setDate] = useState('')
  const [view, setView] = useState<'upcoming' | 'recent'>('upcoming')
  const [offset, setOffset] = useState(0)
  const resource = useRemoteResource<EventCalendar>('/observation/event-calendar' + (date ? '?as_of=' + date : ''))
  const data = resource.data
  const rows = data?.items.filter(row => view === 'recent' ? row.kind.startsWith('holder_') : !row.kind.startsWith('holder_')) ?? []
  return <section className="tushare-feature tushare-observation" aria-label="观察池事件日历">
    <div className="tushare-section-heading"><h2>观察池事件日历</h2><label className="workspace-field-label">日历基准日<input type="date" className="workspace-field" min="2000-01-01" max={shanghaiToday()} value={date} onChange={event => { setDate(event.target.value); setOffset(0) }} /></label></div>
    <div className="tushare-switch" role="group" aria-label="事件日历范围">
      <button type="button" className="workspace-button" aria-pressed={view === 'upcoming'} onClick={() => { setView('upcoming'); setOffset(0) }}>未来 7 天</button>
      <button type="button" className="workspace-button" aria-pressed={view === 'recent'} onClick={() => { setView('recent'); setOffset(0) }}>近 7 天增减持披露</button>
    </div>
    <FeatureStatus {...resource} label="观察池事件">{data && <>
      <p className="tushare-meta">{view === 'upcoming' ? data.as_of + ' 至 ' + data.upcoming_end : data.recent_start + ' 至 ' + data.as_of} · {data.stock_count} 只观察中或重点关注的股票</p>
      {!data.stock_count ? <p className="tushare-empty">先将股票加入观察池，再查看它们的事件日期。</p>
        : !rows.length ? <p className="tushare-empty">{data.issues.length ? '已读取的资料中暂无事件，部分日期的数据待补齐。' : '所查区间暂无对应事件。'}</p>
          : <><FeatureTable label="观察池事件"><thead><tr><th scope="col">事件日期</th><th scope="col">股票</th><th scope="col">事件</th><th scope="col">公告日期</th><th scope="col">详情</th></tr></thead>
            <tbody>{rows.slice(offset, offset + pageSize).map((row, index) => <tr key={offset + index}><td>{row.date}</td><th scope="row">{row.name}<small>{row.code}</small></th><td>{labels[row.kind]}</td><td>{row.ann_date}</td>
              <td className="tushare-event-detail">{row.period ? '报告期 ' + row.period : row.kind === 'unlock'
                ? (row.shares != null ? figures(row.shares, 0) + ' 股' : '规模待核对') + ' · ' + row.shareholders + ' 条股东记录'
                : <><strong>{row.holder || '股东名称待核对'}</strong>{row.shares != null && <small>{figures(row.shares, 0)} 股{row.ratio == null ? '' : ' · ' + figures(row.ratio) + '%'}</small>}{(row.start_date || row.end_date) && <small>{row.start_date || '—'} 至 {row.end_date || '—'}</small>}</>}</td></tr>)}</tbody>
          </FeatureTable>{rows.length > pageSize && <Pagination label="事件日历分页" offset={offset} total={rows.length} pageSize={pageSize} onChange={setOffset} />}</>}
      <FeatureNotes {...data} />
    </>}</FeatureStatus>
  </section>
}
