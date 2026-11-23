import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ExternalLink, Search } from 'lucide-react'
import { ApiRequestError, apiResponse } from '../api'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import { FeatureStatus, shanghaiToday } from '../components/tushare/FeatureData'
import { useRemoteResource } from '../useRemoteResource'
import TushareDownloadResult, { readTushareResult, type TushareResult } from './TushareDownloadResult'
import './tushare-download.css'

const endpoint = '/tushare-download'
type Dataset = {
  id: string; category: string; label: string; description: string; doc_url: string; points: number
  mode: 'range' | 'listing' | 'period' | 'month' | 'months' | 'quarters' | 'snapshot'
  code_label: string; code_example: string | null; market_wide: boolean; market_day_limit: boolean; date_label: string | null
  always_day_limit?: boolean; future_dates?: boolean; choice?: { label: string; options: [string, string][] } | null
}
type Catalog = { configured: boolean; earliest_date: string; market_days: number; datasets: Dataset[] }
type Notice = { kind: 'empty' | 'error'; message: string }

function previousWeekday(today: string) {
  const day = new Date(`${today}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() === 1 ? 3 : day.getUTCDay() === 0 ? 2 : 1))
  return day.toISOString().slice(0, 10)
}

const quarterId = (index: number) => `${Math.floor(index / 4)}Q${index % 4 + 1}`

export default function TushareDownloadPage({ onSettings }: { onSettings: () => void }) {
  const catalog = useRemoteResource<Catalog>(`${endpoint}/catalog`)
  const today = shanghaiToday()
  const year = Number(today.slice(0, 4))
  const quarter = year * 4 + Math.floor((Number(today.slice(5, 7)) - 1) / 3)
  const [datasetId, setDatasetId] = useState('daily')
  const [code, setCode] = useState('')
  const [start, setStart] = useState(() => previousWeekday(today))
  const [end, setEnd] = useState(start)
  const [period, setPeriod] = useState(`${year - 1}-12-31`)
  const [month, setMonth] = useState(today.slice(0, 7))
  const [startMonth, setStartMonth] = useState(`${year - 1}-${today.slice(5, 7)}`)
  const [endMonth, setEndMonth] = useState(today.slice(0, 7))
  const [startQuarter, setStartQuarter] = useState(() => quarterId(quarter - 3))
  const [endQuarter, setEndQuarter] = useState(() => quarterId(quarter))
  const [listStatus, setListStatus] = useState('L')
  const [choice, setChoice] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TushareResult | null>(null)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  const data = catalog.data
  const datasets = data?.datasets ?? []
  const dataset = datasets.find(item => item.id === datasetId) ?? datasets[0]
  const categories = Array.from(new Set(datasets.map(item => item.category)))
  const codeRequired = !!dataset?.code_label && !dataset.market_wide && dataset.mode !== 'listing'
  const selectedChoice = choice || dataset?.choice?.options[0]?.[0] || ''
  const earliestYear = Number(data?.earliest_date.slice(0, 4) || year)
  const quarters = dataset?.mode === 'quarters'
    ? Array.from({ length: quarter - earliestYear * 4 + 1 }, (_, offset) => quarterId(quarter - offset)) : []

  async function query(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dataset || !data?.configured || pending.current) return
    const params = new URLSearchParams()
    const symbol = code.trim().toUpperCase()
    if (dataset.code_label && symbol) params.set('code', symbol)
    if (dataset.mode === 'range') {
      params.set('start_date', start)
      params.set('end_date', end)
    }
    if (dataset.mode === 'period') params.set('period', period)
    if (dataset.mode === 'month') params.set('month', month)
    if (dataset.mode === 'months') {
      params.set('start_month', startMonth)
      params.set('end_month', endMonth)
    }
    if (dataset.mode === 'quarters') {
      params.set('start_quarter', startQuarter)
      params.set('end_quarter', endQuarter)
    }
    if (dataset.mode === 'listing') params.set('list_status', listStatus)
    if (dataset.choice) params.set('option', selectedChoice)
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setNotice(null)
    setResult(null)
    try {
      const response = await apiResponse(`${endpoint}/${dataset.id}?${params}`, { signal: controller.signal, cache: 'no-store' })
      const preview = await readTushareResult(response, dataset)
      if (!controller.signal.aborted) setResult(preview)
    } catch (error) {
      if (!controller.signal.aborted) setNotice({
        kind: error instanceof ApiRequestError && error.code === 'tushare_empty' ? 'empty' : 'error',
        message: (error as Error).message,
      })
    } finally {
      pending.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return <div className="page-content workspace-tool-page tushare-download-page">
    <WorkspacePageHeading actions={null}>
      <h1>Tushare 数据下载</h1>
    </WorkspacePageHeading>
    <FeatureStatus {...catalog} label="数据目录">{data && dataset && <div className="tushare-download-panel">
      <form className="tushare-download-form" aria-label="查询条件" aria-busy={busy} onSubmit={query} onChange={() => { setNotice(null); setResult(null) }}>
        {!data.configured && <div className="tushare-download-connection" role="status">
          <span>尚未配置 Tushare 数据连接。</span>
          <button className="text-button workspace-button" type="button" onClick={onSettings}>打开数据与连接</button>
          <button className="text-button workspace-button" type="button" onClick={catalog.retry}>重新检查</button>
        </div>}
        <fieldset className="tushare-download-fields" disabled={busy}>
          <label className="workspace-field-label tushare-download-wide-field tushare-download-dataset">数据类型
            <select className="workspace-field workspace-select" value={dataset.id} onChange={event => {
              const next = datasets.find(item => item.id === event.target.value)!
              if (next.code_label !== dataset.code_label || next.code_example !== dataset.code_example) setCode('')
              setDatasetId(next.id)
              setListStatus('L')
              setChoice('')
            }}>
              {categories.map(category => <optgroup key={category} label={category}>
                {datasets.filter(item => item.category === category).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </optgroup>)}
            </select>
          </label>
          {dataset.code_label && <label className="workspace-field-label tushare-download-wide-field">{dataset.code_label}{!codeRequired && '（选填）'}
            <input className="workspace-field" placeholder={`如 ${dataset.code_example}`} value={code} maxLength={20}
              autoComplete="off" autoCapitalize="characters" spellCheck={false} required={codeRequired} onChange={event => setCode(event.target.value)} />
          </label>}
          {dataset.mode === 'range' && <>
            <label className="workspace-field-label">开始{dataset.date_label}
              <input className="workspace-field" type="date" min={data.earliest_date} max={dataset.future_dates ? undefined : today} required value={start} onChange={event => setStart(event.target.value)} />
            </label>
            <label className="workspace-field-label">结束{dataset.date_label}
              <input className="workspace-field" type="date" min={start || data.earliest_date} max={dataset.future_dates ? undefined : today} required value={end} onChange={event => setEnd(event.target.value)} />
            </label>
          </>}
          {dataset.mode === 'period' && <label className="workspace-field-label tushare-download-wide-field">报告期末
            <input className="workspace-field" type="date" min={data.earliest_date} max={today} required value={period} onChange={event => setPeriod(event.target.value)} />
          </label>}
          {dataset.mode === 'month' && <label className="workspace-field-label tushare-download-wide-field">月份
            <input className="workspace-field" type="month" min={data.earliest_date.slice(0, 7)} max={today.slice(0, 7)} required value={month} onChange={event => setMonth(event.target.value)} />
          </label>}
          {dataset.mode === 'months' && <>
            <label className="workspace-field-label">开始月份
              <input className="workspace-field" type="month" min={data.earliest_date.slice(0, 7)} max={today.slice(0, 7)} required value={startMonth} onChange={event => setStartMonth(event.target.value)} />
            </label>
            <label className="workspace-field-label">结束月份
              <input className="workspace-field" type="month" min={startMonth || data.earliest_date.slice(0, 7)} max={today.slice(0, 7)} required value={endMonth} onChange={event => setEndMonth(event.target.value)} />
            </label>
          </>}
          {dataset.mode === 'quarters' && <>
            <label className="workspace-field-label">开始季度
              <select className="workspace-field workspace-select" value={startQuarter} onChange={event => setStartQuarter(event.target.value)}>
                {quarters.map(value => <option key={value} value={value}>{value.slice(0, 4)} 年第 {value.slice(-1)} 季度</option>)}
              </select>
            </label>
            <label className="workspace-field-label">结束季度
              <select className="workspace-field workspace-select" value={endQuarter} onChange={event => setEndQuarter(event.target.value)}>
                {quarters.map(value => <option key={value} value={value}>{value.slice(0, 4)} 年第 {value.slice(-1)} 季度</option>)}
              </select>
            </label>
          </>}
          {dataset.mode === 'listing' && <label className="workspace-field-label tushare-download-wide-field">上市状态
            <select className="workspace-field workspace-select" value={listStatus} onChange={event => setListStatus(event.target.value)}>
              <option value="L">已上市</option><option value="D">已退市</option>
              <option value="P">{dataset.code_label === 'ETF 代码' ? '待上市' : '暂停上市'}</option>
            </select>
          </label>}
          {dataset.choice && <label className="workspace-field-label tushare-download-wide-field">{dataset.choice.label}
            <select className="workspace-field workspace-select" value={selectedChoice} onChange={event => setChoice(event.target.value)}>
              {dataset.choice.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>}
        </fieldset>
        <div className="tushare-download-form-footer">
          <div className="tushare-download-metadata">
            <p className="tushare-download-description">
              <span>{dataset.description}</span>
              <a href={dataset.doc_url} target="_blank" rel="noreferrer">接口文档 <ExternalLink size={13} aria-hidden="true" /></a>
              <span>官方门槛 {dataset.points.toLocaleString('zh-CN')} 积分起</span>
            </p>
            {dataset.mode === 'period' && <p className="tushare-download-hint">
              报告期填季度最后一天。{dataset.market_wide && '留空股票代码可查询全市场财务，需 5,000 积分。'}
            </p>}
            {dataset.mode === 'range' && (dataset.market_wide || dataset.always_day_limit) && <p className="tushare-download-hint">
              {dataset.market_wide && '留空代码查询全部证券。'}
              {dataset.market_day_limit && (dataset.always_day_limit || !code.trim()) && `按日查询每次最多 ${data.market_days} 天。`}
            </p>}
          </div>
          <button className="primary-button workspace-button" type="submit" disabled={busy || !data.configured}>
            <Search size={16} aria-hidden="true" />{busy ? '正在查询…' : '查询数据'}
          </button>
        </div>
        <div aria-live="polite">
          {notice && <p className={`tushare-download-notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.message}</p>}
        </div>
      </form>
      {result && <TushareDownloadResult result={result} />}
    </div>}
    </FeatureStatus>
  </div>
}
