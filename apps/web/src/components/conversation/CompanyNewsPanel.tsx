import { useState } from 'react'
import { useRemoteResource } from '../../useRemoteResource'
import Pagination from '../Pagination'

type News = { id: string; title: string; snippet?: string; body?: string; source: string; stock_codes: string[]; version: number; published_at: string | null; available_at: string | null }
function time(value: string | null) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '时间待核对'
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
export default function CompanyNewsPanel({ stockCode }: { stockCode: string }) {
  const [queryInput, setQueryInput] = useState(''), [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [selectedId, setSelected] = useState('')
  const params = new URLSearchParams({ stock_code: stockCode, offset: String(offset), limit: '20' })
  if (query) params.set('query', query)
  const list = useRemoteResource<{ items: News[]; total: number; next_offset: number | null }>('/news?' + params)
  const items = (list.data?.items || []).filter(item => item.stock_codes.includes(stockCode))
  const activeId = (items.find(item => item.id === selectedId) || items[0])?.id
  const detail = useRemoteResource<News>(activeId ? '/news/' + encodeURIComponent(activeId) : null)
  const selected = detail.data && detail.data.id === activeId && detail.data.stock_codes.includes(stockCode) ? detail.data : null
  return <section className="company-materials" aria-label="公司资讯目录">
    <p className="research-secondary">仅显示已关联这家公司、保存在工作空间中的资讯，正文按保存版本读取。</p>
    <form className="company-material-search" onSubmit={event => { event.preventDefault(); setQuery(queryInput.trim()); setOffset(0); setSelected('') }}>
      <label className="workspace-field-label">查找公司资讯<input className="workspace-field" maxLength={300} value={queryInput} onChange={event => setQueryInput(event.target.value)} placeholder="标题或正文关键词" /></label>
      <button type="submit" className="secondary-button workspace-button">查找资讯</button>
    </form>
    {list.loading ? <p role="status">正在读取公司资讯…</p> : list.error ? <p role="alert" className="workspace-error">{list.error}<button type="button" className="text-button workspace-button" onClick={list.retry}>重试公司资讯</button></p> : <>
      <div className="company-material-list" role="region" aria-label="公司资讯列表">
        {items.map(item => <button type="button" key={item.id} className="company-material-row workspace-button" aria-pressed={item.id === activeId} onClick={() => setSelected(item.id)}>
          <strong>{item.title}</strong><span>{time(item.published_at || item.available_at)} · {item.source}</span>{item.snippet && <span>{item.snippet}</span>}
        </button>)}
        {!items.length && <p>{query ? '没有符合关键词的已关联公司资讯。' : '暂无已关联这家公司的本地资讯。'}</p>}
      </div>
      <Pagination offset={offset} total={list.data?.total || 0} pageSize={20} nextOffset={list.data?.next_offset} label="公司资讯分页" onChange={value => { setOffset(value); setSelected('') }} />
      {activeId && <article className="company-material-reader" aria-label="公司资讯正文">
        {detail.loading ? <p role="status">正在读取资讯正文…</p> : detail.error ? <p role="alert" className="workspace-error">{detail.error}<button type="button" className="text-button workspace-button" onClick={detail.retry}>重试资讯正文</button></p> : selected ? <>
          <h3>{selected.title}</h3><p>{selected.source} · 发布时间 {time(selected.published_at)} · 第 {selected.version} 版</p>
          <p>首次可得时间 {time(selected.available_at)}</p><div className="company-news-body">{selected.body}</div>
        </> : <p role="alert">资讯的公司归属已变化，请重新读取列表。<button type="button" className="text-button workspace-button" onClick={list.retry}>重新读取列表</button></p>}
      </article>}
    </>}
  </section>
}
