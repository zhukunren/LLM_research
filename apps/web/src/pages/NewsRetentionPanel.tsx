import { useEffect, useState } from 'react'
import { api } from '../api'

type RetentionStatus = {
  enabled: boolean
  days: number
  cutoff_day: string
  eligible_count: number
  protected_count: number
  preview_token: string
  last_run: {
    run_day: string
    finished_at: string | null
    deleted_count: number
    protected_count: number
  } | null
}

export default function NewsRetentionPanel() {
  const [open, setOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [status, setStatus] = useState<RetentionStatus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setStatus(null)
    setConfirming(false)
    setError('')
    void api<RetentionStatus>('/maintenance/news-retention', { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setStatus(value) })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
    return () => controller.abort()
  }, [open, refresh])

  async function update(enabled: boolean) {
    if (!status || saving) return
    setSaving(true)
    setError('')
    try {
      setStatus(await api<RetentionStatus>('/maintenance/news-retention', {
        method: 'PUT',
        body: JSON.stringify({ enabled, preview_token: enabled ? status.preview_token : null }),
      }))
      setConfirming(false)
    } catch (reason) {
      setConfirming(false)
      setStatus(null)
      setError((reason as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return <details className="service-status-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>资讯保留与自动清理</summary>
    {open && <>
      {error && <p className="workspace-error" role="alert">{error}</p>}
      {!status && !error && <p role="status">正在计算清理预览…</p>}
      {status && <>
        <p>保留最近 {status.days} 天 · 从 {status.cutoff_day} 起 · 自动清理{status.enabled ? '已开启' : '已暂停'}</p>
        <p>可清理 {status.eligible_count.toLocaleString()} 条 · 因引用保留 {status.protected_count.toLocaleString()} 条</p>
        {status.last_run && <p>{status.last_run.run_day} {status.last_run.finished_at ? '已清理' : '正在分批清理'} {status.last_run.deleted_count.toLocaleString()} 条</p>}
        {confirming && <p>开启后，后台每天在空闲时删除过期且无引用的同步资讯。</p>}
        <div className="news-retention-actions">
          {status.enabled ? <button type="button" className="secondary-button workspace-button" disabled={saving} onClick={() => void update(false)}>暂停自动清理</button>
            : confirming ? <>
              <button type="button" className="primary-button workspace-button" disabled={saving} onClick={() => void update(true)}>确认开启</button>
              <button type="button" className="secondary-button workspace-button" disabled={saving} onClick={() => setConfirming(false)}>取消</button>
            </> : <button type="button" className="secondary-button workspace-button" onClick={() => setConfirming(true)}>开启自动清理</button>}
          <button type="button" className="text-button workspace-button" disabled={saving} onClick={() => setRefresh(value => value + 1)}>重新预览</button>
        </div>
      </>}
      {!status && error && <button type="button" className="text-button workspace-button" onClick={() => setRefresh(value => value + 1)}>重新预览</button>}
    </>}
  </details>
}
