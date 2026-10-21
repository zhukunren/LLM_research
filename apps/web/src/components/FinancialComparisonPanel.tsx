import { useRef, useState } from 'react'
import { api } from '../api'
import { useRemoteResource } from '../useRemoteResource'
import './company-financials.css'

type Point = { value: string | null; unit: string; reason: string; actual_basis?: string }
type Calculation = { calculation_id: string; request: { stock_code: string }; rows: { period: string; values: Record<string, Point> }[] }
type Result = { id: string; saved?: boolean; request: { as_of: string; basis: string; mode: string }; companies: { stock_code: string; name: string }[]; metrics: { code: string; label: string; unit: string }[]; calculations: Calculation[]; note: string }

export default function FinancialComparisonPanel({ projectId, companies, asOf, writable = true, onDateChange }: {
  projectId?: string; companies: { stock_code: string; name?: string }[]; asOf: string; writable?: boolean; onDateChange?: (value: string) => void
}) {
  const [codes, setCodes] = useState(companies.slice(0, 3).map(item => item.stock_code)), [metric, setMetric] = useState('revenue')
  const [basis, setBasis] = useState('annual'), [mode, setMode] = useState('as_of')
  const [selected, setSelected] = useState<{ key: string; id: string } | null>(null), [savedId, setSavedId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [citation, setCitation] = useState<{ key: string; id: string; citation_url: string } | null>(null)
  const request = { stock_codes: codes, as_of: asOf, start_year: Number(asOf.slice(0, 4)) - 5, basis, mode, metrics: [metric], project_id: projectId || null }
  const controlKey = JSON.stringify(request)
  const valid = codes.length >= 3 && codes.length <= 5 && !!asOf
  const params = new URLSearchParams({ stock_codes: codes.join(','), as_of: asOf, start_year: String(request.start_year), basis, mode, metrics: metric })
  if (projectId) params.set('project_id', projectId)
  const preview = useRemoteResource<Result>(valid ? '/financial-data/compare?' + params : null)
  const selectedId = selected?.key === controlKey ? selected.id : ''
  const old = useRemoteResource<Result>(selectedId ? '/financial-data/comparisons/' + selectedId : null)
  const history = useRemoteResource<{ items: { id: string; created_at: string; request: { as_of: string; basis: string } }[] }>('/financial-data/comparisons' + (projectId ? '?project_id=' + projectId : ''))
  const catalog = useRemoteResource<{ items: Result['metrics']; can_save?: boolean }>('/financial-data/metrics')
  const canSave = writable && catalog.data?.can_save === true
  const resource = selectedId ? old : preview, result = resource.data
  const isSaved = result?.saved || savedId === result?.id
  const owner = useRef('')
  owner.current = JSON.stringify([controlKey, selectedId, result?.id])
  function change() { setSelected(null); setSavedId(''); setCitation(null); setError('') }
  async function save() {
    if (!result) return null
    if (isSaved) return result
    if (!canSave) return null
    const identity = result.id, key = owner.current
    setBusy(true); setError('')
    try {
      const value = await api<Result>('/financial-data/comparisons?expected_id=' + identity, { method: 'POST', body: JSON.stringify(request) })
      history.retry()
      if (key !== owner.current) return null
      setSavedId(value.id)
      return value
    } catch (reason) { setError((reason as Error).message); return null }
    finally { setBusy(false) }
  }
  async function cite(calculation: Calculation, period: string) {
    if (!result) return
    const key = owner.current
    const value = await save()
    if (!value) return
    setBusy(true); setError('')
    try {
      const proof = await api<{ id: string; citation_url: string }>('/financial-data/calculations/' + calculation.calculation_id + '/evidence', { method: 'POST', body: JSON.stringify({ metric: result.metrics[0].code, period }) })
      if (key === owner.current) setCitation({ ...proof, key })
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  const label = result?.metrics[0]?.label || '', unit = result?.metrics[0]?.unit === '元' ? '亿元' : result?.metrics[0]?.unit
  function display(point?: Point) { return point?.value == null ? '—' : (Number(point.value) / (point.unit === '元' ? 1e8 : 1)).toLocaleString('zh-CN', { maximumFractionDigits: 4 }) }
  return <section className="company-financials" aria-label="标准财务同业对比">
    <h3>标准财务同业对比</h3><p>选择 3–5 家公司；所有列使用相同报告期、单位、截止日和版本口径，缺口保留原因。</p>
    <fieldset disabled={busy}><legend>财务对比公司</legend><div className="financial-comparison-companies">{companies.map(item => <label key={item.stock_code}><input type="checkbox" checked={codes.includes(item.stock_code)} onChange={event => { change(); setCodes(values => event.target.checked ? [...values, item.stock_code] : values.filter(code => code !== item.stock_code)) }} />{item.name || item.stock_code}</label>)}</div></fieldset>
    <div className="financial-series-controls">
      {onDateChange && <label>财务对比截止日<input aria-label="财务对比截止日" type="date" value={asOf} disabled={busy} onChange={event => { if (event.target.value) onDateChange(event.target.value) }} /></label>}
      <label>比较指标<select aria-label="比较指标" value={metric} disabled={busy} onChange={event => { change(); setMetric(event.target.value) }}>{(catalog.data?.items || [{ code: 'revenue', label: '营业收入', unit: '元' }]).map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
      <label>比较期间口径<select aria-label="比较期间口径" value={basis} disabled={busy} onChange={event => { change(); setBasis(event.target.value) }}><option value="annual">年度</option><option value="cumulative">本年累计</option><option value="quarter">单季</option><option value="ttm">TTM</option></select></label>
      <label>比较版本口径<select aria-label="比较版本口径" value={mode} disabled={busy} onChange={event => { change(); setMode(event.target.value) }}><option value="as_of">当时可验证口径</option><option value="latest">最新修订口径</option></select></label>
      <label>保存的比较<select aria-label="保存的财务比较" value={selectedId} disabled={busy} onChange={event => { setSelected(event.target.value ? { key: controlKey, id: event.target.value } : null); setCitation(null) }}><option value="">当前资料预览</option>{history.data?.items.map(item => <option key={item.id} value={item.id}>{item.request.as_of} · {item.request.basis} · {item.id.slice(0, 8)}</option>)}</select></label>
    </div>
    {!valid && !selectedId && <p role="status">请选择 3 至 5 家公司。</p>}
    {resource.loading && <p role="status">正在对齐财务期间与单位…</p>}
    {(resource.error || error) && <p role="alert" className="workspace-error">{error || resource.error}<button type="button" className="text-button workspace-button" onClick={() => { setError(''); resource.retry() }}>重新读取对比</button></p>}
    {result && <><p>数据截至 {result.request.as_of} · {result.request.basis} · {result.request.mode}{selectedId ? ' · 保存的历史版本' : ''}</p>
      <div className="financial-series-actions"><strong>{label} · {unit}</strong>{canSave && <button type="button" className="secondary-button workspace-button" disabled={busy || !!isSaved} onClick={() => void save()}>{isSaved ? '本次比较已保存' : '保存本次比较'}</button>}</div>
      <div className="financial-series-table financial-comparison-table"><table><thead><tr><th>报告期</th>{result.companies.map(company => <th key={company.stock_code}>{company.name || company.stock_code}</th>)}</tr></thead><tbody>{[...(result.calculations[0]?.rows || [])].reverse().map(row => <tr key={row.period}><td>{row.period}</td>{result.calculations.map(calculation => {
        const point = calculation.rows.find(item => item.period === row.period)?.values[result.metrics[0].code]
        return <td key={calculation.request.stock_code}><strong title={point?.value || point?.reason}>{display(point)}</strong><small className="financial-comparison-reason">{point?.reason || '缺少该期记录'}{point?.actual_basis && point.actual_basis !== result.request.basis ? ' · 实际口径 ' + (({ period_end: '期末时点', period_start: '期初时点' } as Record<string, string>)[point.actual_basis] || point.actual_basis) : ''}</small>
          <div className="financial-comparison-cell-actions">{canSave && <button type="button" className="text-button workspace-button" disabled={busy} onClick={() => void cite(calculation, row.period)}>数字依据</button>}
          {isSaved && <a href={'/api/v1/financial-data/calculations/' + calculation.calculation_id} target="_blank" rel="noopener noreferrer">保存的计算</a>}</div>
        </td>
      })}</tr>)}</tbody></table></div><p>{result.note}</p></>}
    {citation && citation.key === owner.current && <p><a href={citation.citation_url} target="_blank" rel="noopener noreferrer">打开独立数字依据</a> · 标识 {citation.id}</p>}
  </section>
}
