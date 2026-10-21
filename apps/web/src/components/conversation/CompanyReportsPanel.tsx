import { useEffect, useState } from 'react'
import { useRemoteResource } from '../../useRemoteResource'
import PdfReader from '../PdfReader'
import Pagination from '../Pagination'

type Report = {
  id: string; title: string; filename: string; stock_code: string | null; stock_code_status: string
  publication_date: string | null; pages: number
}
export default function CompanyReportsPanel({ stockCode }: { stockCode: string }) {
  const resource = useRemoteResource<{ items: Report[] }>('/documents')
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [selectedId, setSelected] = useState('')
  const [page, setPage] = useState(1)
  const needle = query.trim().toLowerCase()
  const reports = (resource.data?.items || []).filter(item => item.stock_code === stockCode
    && (!needle || (item.title + ' ' + item.filename).toLowerCase().includes(needle)))
  const currentOffset = Math.min(offset, Math.max(0, Math.floor((reports.length - 1) / 20) * 20))
  const visible = reports.slice(currentOffset, currentOffset + 20)
  const selected = visible.find(item => item.id === selectedId) || visible[0]
  useEffect(() => setPage(1), [selected?.id])
  function select(id: string) { setSelected(id); setPage(1) }
  return <section className="company-materials" aria-label="公司研报目录">
    <p className="research-secondary">按研报登记的证券代码筛选；公司归属待核对的记录单独提示。未绑定公司的材料可在资料库中核对。</p>
    <label className="workspace-field-label">筛选公司研报<input className="workspace-field" value={query} onChange={event => { setQuery(event.target.value); setOffset(0); select('') }} placeholder="标题或文件名" /></label>
    {resource.loading ? <p role="status">正在读取公司研报…</p> : resource.error ? <p role="alert" className="workspace-error">{resource.error}<button type="button" className="text-button workspace-button" onClick={resource.retry}>重试公司研报</button></p> : <>
      <div className="company-material-list" aria-label="公司研报列表" role="region">
        {visible.map(item => <button key={item.id} type="button" className="company-material-row workspace-button" aria-pressed={selected?.id === item.id} onClick={() => select(item.id)}>
          <strong>{item.title || item.filename}</strong><span>{item.publication_date || '日期待核对'} · {item.pages} 页 · {item.stock_code_status === 'confirmed' ? '公司归属已核对' : '公司归属待核对'}</span>
        </button>)}
        {!reports.length && <p>{needle ? '没有符合筛选条件的公司研报。' : '暂无已登记归属这家公司的本地研报。'}</p>}
      </div>
      <Pagination offset={currentOffset} total={reports.length} pageSize={20} onChange={value => { setOffset(value); select('') }} label="公司研报分页" />
      {selected && <article aria-label="公司研报原文" className="company-material-reader">
        <h3>{selected.title || selected.filename}</h3><p>{stockCode} · {selected.publication_date || '日期待核对'}{selected.stock_code_status !== 'confirmed' ? ' · 公司归属待核对' : ''}</p>
        <PdfReader key={selected.id} url={'/api/v1/documents/' + encodeURIComponent(selected.id) + '/pdf'} page={page} onPageChange={setPage} />
      </article>}
    </>}
  </section>
}
