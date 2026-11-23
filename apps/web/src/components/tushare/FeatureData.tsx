import type { ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import LoadingState from '../LoadingState'
import './tushare-features.css'

export type Source = { name: string; label: string; url: string; observed_at: string | null }
export type Issue = { label: string; message: string; date?: string }
export type DataNotes = { sources: Source[]; issues: Issue[] }
export type Breadth = { up: number; down: number; flat: number; covered: number; total: number }
export type RotationSnapshot = DataNotes & {
  as_of: string; trade_date: string | null; breadth: Breadth | null
  industries: { code: string; name: string; returns: Record<'1' | '5' | '20', number | null>; breadth: Breadth | null }[]
  limits: Partial<Record<'U' | 'D' | 'Z', { code: string; name: string; open_times: number | null }[]>>
  streaks: { code: string; name: string; days: number }[]
}

const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })
const datetimeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
export const shanghaiToday = () => dateFormat.format(new Date())
export const figures = (value: number | null | undefined, decimals = 2) =>
  value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: decimals })

export function Change({ value, unit = '%', decimals = 2 }: { value: number | null | undefined; unit?: string; decimals?: number }) {
  if (value == null) return <span aria-label="数据不足">—</span>
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  const tone = value > 0 ? 'is-up' : value < 0 ? 'is-down' : 'is-flat'
  return <span className={'tushare-change ' + tone}>{sign}{Math.abs(value).toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{unit}</span>
}

export function FeatureStatus({ loading, error, retry, label, children }: {
  loading: boolean; error: string; retry: () => void; label: string; children: ReactNode
}) {
  if (loading) return <div className="tushare-loading"><LoadingState label={'正在读取' + label + '…'} skeleton /></div>
  if (error) return <div className="workspace-error tushare-error" role="alert"><span>{error}</span><button type="button" className="text-button workspace-button" onClick={retry}><RefreshCw size={15} />重试</button></div>
  return children
}

export function FeatureNotes({ sources, issues }: DataNotes) {
  return <>
    {!!issues.length && <details className="tushare-notes tushare-issues" open>
      <summary>有 {issues.length} 项数据待补齐</summary>
      <ul>{issues.map((issue, index) => <li key={index}>{issue.label}{issue.date ? ' · ' + issue.date : ''} · {issue.message}</li>)}</ul>
    </details>}
    {!!sources.length && <details className="tushare-notes">
      <summary>数据来源与取数时间</summary>
      <ul>{sources.map(source => <li key={source.name}><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>{source.observed_at && <time dateTime={source.observed_at}> · {datetimeFormat.format(new Date(source.observed_at))} 北京时间</time>}</li>)}</ul>
    </details>}
  </>
}

export function FeatureTable({ label, children }: { label: string; children: ReactNode }) {
  return <div className="workspace-table-scroll tushare-table-scroll" role="region" aria-label={label} tabIndex={0}>
    <table className="workspace-data-table tushare-table" aria-label={label}>{children}</table>
  </div>
}
