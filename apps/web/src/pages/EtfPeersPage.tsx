import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import Pagination from '../components/Pagination'
import { Change, FeatureNotes, FeatureStatus, FeatureTable, figures, shanghaiToday, type DataNotes } from '../components/tushare/FeatureData'
import { useRemoteResource } from '../useRemoteResource'

type Etf = {
  code: string; name: string; index_code: string | null; index_name: string | null
  shares_wan: number | null; share_change_wan: number | null; share_change_pct: number | null
  size_yi: number | null; size_change_yi: number | null; amount_yi: number | null
}
type EtfDataset = DataNotes & { as_of: string; trade_date: string | null; previous_date: string | null; items: Etf[] }
const columns = [
  { key: 'share_change_pct', label: '份额变化' }, { key: 'share_change_wan', label: '份额增减（万份）' },
  { key: 'shares_wan', label: '份额（万份）' }, { key: 'size_yi', label: '规模（亿元）' },
  { key: 'size_change_yi', label: '规模增减（亿元）' }, { key: 'amount_yi', label: '成交额（亿元）' },
] as const
const pageSize = 30

export default function EtfPeersPage() {
  const [date, setDate] = useState('')
  const [search, setSearch] = useState('')
  const [index, setIndex] = useState('')
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<{ key: typeof columns[number]['key']; ascending: boolean }>({ key: 'share_change_pct', ascending: false })
  const resource = useRemoteResource<EtfDataset>('/tushare-features/etf' + (date ? '?as_of=' + date : ''))
  const data = resource.data
  const indexOptions = useMemo(() => {
    const entries = new Map<string, string>()
    for (const item of data?.items ?? []) if (item.index_code) entries.set(item.index_code, item.index_name || item.index_code)
    return Array.from(entries).sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))
  }, [data])
  const rows = useMemo(() => {
    const query = search.toLowerCase().trim()
    return (data?.items ?? []).filter(item => (!index || item.index_code === index)
      && (!query || [item.code, item.name, item.index_code, item.index_name].some(value => value?.toLowerCase().includes(query))))
      .sort((a, b) => Number(a[sort.key] == null) - Number(b[sort.key] == null)
        || ((a[sort.key] ?? 0) - (b[sort.key] ?? 0)) * (sort.ascending ? 1 : -1) || a.code.localeCompare(b.code))
  }, [data, search, index, sort])

  return <div className="page-content workspace-tool-page tushare-page">
    <WorkspacePageHeading actions={null}><h1>ETF 同类比较</h1><p className="page-description">按跟踪指数查看 ETF 份额、规模和成交额</p></WorkspacePageHeading>
    <section className="tushare-feature" aria-label="ETF 份额比较">
      <div className="tushare-filter-row">
        <label className="workspace-field-label">份额日期<input className="workspace-field" type="date" min="2000-01-01" max={shanghaiToday()} value={date} onChange={event => { setDate(event.target.value); setOffset(0); setIndex('') }} /></label>
        <label className="workspace-field-label">跟踪指数<select className="workspace-field workspace-select" value={index} onChange={event => { setIndex(event.target.value); setOffset(0) }}>
          <option value="">全部指数</option>{indexOptions.map(([code, name]) => <option key={code} value={code}>{name} · {code}</option>)}
        </select></label>
        <label className="workspace-field-label">查找 ETF<span className="tushare-search"><Search size={16} aria-hidden="true" /><input className="workspace-field" type="search" value={search} onChange={event => { setSearch(event.target.value); setOffset(0) }} placeholder="名称、代码或指数" /></span></label>
      </div>
      <FeatureStatus {...resource} label="ETF 份额">{data && <>
        <p className="tushare-meta">{data.trade_date ? '份额日期 ' + data.trade_date : data.as_of + ' · 暂无份额'}{data.previous_date && ' · 与 ' + data.previous_date + ' 比较'} · 份额通常次日更新</p>
        {!!rows.length ? <>
          <FeatureTable label="ETF 份额、成交额与规模"><thead><tr><th scope="col" className="tushare-etf-fixed">ETF</th><th scope="col" className="tushare-etf-index">跟踪指数</th>
            {columns.map(({ key, label }) => <th key={key} scope="col" className="is-number" aria-sort={sort.key === key ? sort.ascending ? 'ascending' : 'descending' : 'none'}>
              <button className="workspace-button tushare-sort" type="button" onClick={() => { setSort({ key, ascending: key === sort.key && !sort.ascending }); setOffset(0) }}>
                {label}{sort.key === key ? sort.ascending ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" /> : <ArrowUpDown size={13} aria-hidden="true" />}
              </button></th>)}</tr></thead>
            <tbody>{rows.slice(offset, offset + pageSize).map(row => <tr key={row.code}>
              <th scope="row" className="tushare-etf-fixed"><span className="tushare-etf-name" title={row.name}>{row.name}</span><small>{row.code}</small></th>
              <td className="tushare-etf-index"><span className="tushare-etf-name" title={row.index_name ?? undefined}>{row.index_name || row.index_code || '待核对'}</span></td>
              <td className="is-number"><Change value={row.share_change_pct} /></td><td className="is-number"><Change value={row.share_change_wan} unit="" /></td>
              <td className="is-number">{figures(row.shares_wan)}</td><td className="is-number">{figures(row.size_yi)}</td>
              <td className="is-number"><Change value={row.size_change_yi} unit="" /></td><td className="is-number">{figures(row.amount_yi)}</td>
            </tr>)}</tbody></FeatureTable>
          <Pagination label="ETF 列表分页" offset={offset} total={rows.length} pageSize={pageSize} onChange={setOffset} unit="只 ETF" />
          <p className="tushare-meta">缺少同一只 ETF 的前一交易日份额时，变化显示为 —。</p>
        </> : <p className="tushare-empty">{data.items.length ? '当前条件下没有匹配的 ETF。' : '所选日期暂无已入库的份额，可以换一个交易日查看。'}</p>}
        <FeatureNotes {...data} />
      </>}</FeatureStatus>
    </section>
  </div>
}
