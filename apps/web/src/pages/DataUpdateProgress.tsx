import { useEffect, useState } from 'react'
import './data-update-progress.css'

type UpdateStage = {
  status: string; message?: string; reason?: string; count?: number
  completed?: number; total?: number; unit?: string; current?: string | null
  requested_start?: string; requested_end?: string; new_watermark?: string | null
  rows_received?: number; rows_rejected?: number; rows_written?: number
  deferred_days?: string[]; deferred_days_count?: number; missing_or_failed_days?: { date: string; reason: string }[]
  import?: { created: number; duplicates: number }; failed_sources?: { source: string; reason: string }[]
  coverage_note?: string; started_at?: string; finished_at?: string
}
export type UpdateJob = {
  id: string; state: string; message: string; progress: number; created_at?: string; updated_at: string
  result?: Partial<Record<'names' | 'market' | 'news', UpdateStage>> & { events?: { at: string; stage: string; message: string }[] }
}
const stages = [['names', '股票名称'], ['market', '日线行情'], ['news', '最近30天资讯']] as const
const labels: Record<string, string> = {
  pending: '待更新', running: '更新中', updated: '已完成', completed: '已完成',
  up_to_date: '已是最新', no_new_rows: '无新增', partial: '部分完成', failed: '更新失败',
}
const states: Record<string, string> = { queued: '排队中', running: '更新中', succeeded: '更新完成', partial: '部分完成', failed: '更新失败', cancelled: '已停止' }
function timestamp(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}
function duration(start: string, end: number) {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export default function DataUpdateProgress({ job }: { job: UpdateJob }) {
  const active = ['queued', 'running'].includes(job.state)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  const percent = Math.round(Math.max(0, Math.min(1, job.progress)) * 100)
  const events = job.result?.events || []
  return <div className="data-update-progress" aria-label="数据更新详情">
    <div className="data-update-heading" role="status"><strong>{states[job.state] || job.state}</strong><span>{percent}%</span></div>
    <progress aria-label="数据更新进度" max={100} value={percent} />
    <p role="status">{job.message}</p>
    <div className="data-update-meta">
      {job.created_at && <span>{active ? '已用时' : '用时'} {duration(job.created_at, active ? now : Date.parse(job.updated_at))}</span>}
      <span>最近更新 {timestamp(job.updated_at)}</span>
    </div>
    <ol className="data-update-stages">
      {stages.map(([key, title]) => {
        const stage = job.result?.[key]
        const status = stage?.status || 'pending'
        const interrupted = !active && ['pending', 'running'].includes(status)
        const deferred = stage?.deferred_days_count ?? stage?.deferred_days?.length ?? 0
        return <li key={key} data-state={interrupted ? 'stopped' : status}>
          <div className="data-update-stage-heading"><strong>{title}</strong><span>{interrupted ? '未完成' : labels[status] || status}</span></div>
          {stage?.message && <p>{stage.message}</p>}
          {stage?.total !== undefined && <p>已处理 {stage.completed ?? 0} / {stage.total} 个{stage.unit}{stage.current && status === 'running' ? ` · 当前 ${stage.current}` : ''}</p>}
          {stage?.count !== undefined && <p>更新 {stage.count.toLocaleString()} 只证券</p>}
          {stage?.requested_start && <p>请求范围 {stage.requested_start} 至 {stage.requested_end}</p>}
          {stage?.rows_received !== undefined && <p>已接收 {stage.rows_received.toLocaleString()} 条 · 已写入 {(stage.rows_written ?? 0).toLocaleString()} 条{stage.rows_rejected ? ` · 无效 ${stage.rows_rejected.toLocaleString()} 条` : ''}</p>}
          {stage?.new_watermark && <p>行情最新日期 {stage.new_watermark}</p>}
          {stage?.import && <p>新增 {stage.import.created.toLocaleString()} 条资讯 · 重复 {stage.import.duplicates.toLocaleString()} 条</p>}
          {stage?.coverage_note && <p>{stage.coverage_note}</p>}
          {stage?.reason && stage.reason !== stage.message && <p className="data-update-issue">{stage.reason}</p>}
          {deferred > 0 && <p className="data-update-issue">另有 {deferred.toLocaleString()} 个历史交易日待后续更新补齐。</p>}
          {!!stage?.missing_or_failed_days?.length && <details><summary>{stage.missing_or_failed_days.length} 个交易日需重试</summary><ul>{stage.missing_or_failed_days.map(item => <li key={item.date}>{item.date}：{item.reason}</li>)}</ul></details>}
          {!!stage?.failed_sources?.length && <details><summary>{stage.failed_sources.length} 个资讯来源更新失败</summary><ul>{stage.failed_sources.map(item => <li key={item.source}>{item.source}：{item.reason}</li>)}</ul></details>}
        </li>
      })}
    </ol>
    {!!events.length && <details className="data-update-log"><summary>查看更新明细（最近 {events.length} 条）</summary><ol aria-label="更新明细">{events.map((event, index) => <li key={`${job.id}-${index}`}><time dateTime={event.at}>{timestamp(event.at)}</time><span>{event.message}</span></li>)}</ol></details>}
    {active && <p className="data-update-hint">进度每秒刷新，按阶段和已处理数量计算。可关闭面板继续工作，重新打开可查看最新进度。</p>}
  </div>
}
