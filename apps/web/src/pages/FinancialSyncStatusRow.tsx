import { useEffect, useState } from 'react'
import { Database } from 'lucide-react'
import { api } from '../api'
import { researchToday } from '../companyResearch'

type FinancialSync = { id: string; job_id: string; state: string; message: string; credential_matches: boolean; summary: { planned: number; finished: number; source_versions: number } }
type SeriesStatus = { can_sync: boolean; latest: FinancialSync | null; coverage: { stock_code: string; periods: number; source_versions: number; facts: number }[] }
const states: Record<string, string> = { queued: '等待采集', running: '采集中', succeeded: '采集完成', partial: '部分完成', failed: '采集失败', cancelled: '已停止' }

export default function FinancialSyncStatusRow({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<SeriesStatus | null>(null), [error, setError] = useState('')
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false)
  const run = data?.latest, active = !!run && ['queued', 'running'].includes(run.state)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function read() {
      try {
        const value = await api<SeriesStatus>('/financial-data/series-status', { signal: controller.signal })
        if (controller.signal.aborted) return
        if (!value || typeof value.can_sync !== 'boolean' || !Array.isArray(value.coverage)) throw new Error('无法识别财务采集状态')
        setData(value); setError('')
        if (value.latest && ['queued', 'running'].includes(value.latest.state)) timer = setTimeout(() => void read(), 2000)
      } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [revision, refreshKey])
  async function act(action: 'start' | 'retry' | 'cancel') {
    if (busy || !data?.can_sync || (action !== 'start' && !run)) return
    setBusy(true); setError('')
    try {
      await api(action === 'cancel' ? `/jobs/${run!.job_id}/cancel` : action === 'retry' ? `/maintenance/financial-sync/${run!.id}/retry` : '/maintenance/financial-sync', {
        method: 'POST', ...(action === 'start' ? { body: JSON.stringify({ request_id: crypto.randomUUID(), as_of: researchToday() }) } : {}),
      })
      setRevision(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="service-status-row" aria-label="财务数据采集">
    <div className="service-status-main"><Database size={17} aria-hidden="true" /><div><h3>财务数据采集</h3><p>{!data ? error ? '状态读取失败' : '正在读取状态…' : run ? states[run.state] || run.state : '尚无采集记录'}</p></div><div className="service-status-actions">
      {data?.can_sync && <><button className="secondary-button workspace-button" aria-label="更新十家公司财务" disabled={busy || active} onClick={() => void act('start')}>更新财务</button>{active && <button className="text-button workspace-button" disabled={busy} onClick={() => void act('cancel')}>停止财务采集</button>}{run && ['partial', 'failed', 'cancelled'].includes(run.state) && <button className="text-button workspace-button" disabled={busy} onClick={() => void act('retry')}>继续未完成分片</button>}</>}
    </div></div>
    {run && <p className="service-status-message" role="status">{run.message} · 已处理 {run.summary.finished}/{run.summary.planned} 个分片</p>}
    {run && !run.credential_matches && <p className="service-status-message workspace-feedback-warning">凭据已变化，历史采集不证明当前权限。</p>}
    {error && <p role="alert" className="workspace-error service-status-message">{error}<button className="text-button workspace-button" onClick={() => setRevision(value => value + 1)}>重试读取采集状态</button></p>}
    <details className="service-status-details"><summary>采集范围与覆盖</summary><p>采集 10 家试点公司的最近五个完整年度及当年数据，并补取比较基期。</p>{data && !data.can_sync && <p>请由平台维护者更新财务数据。</p>}{data?.coverage.map(item => <p key={item.stock_code}>{item.stock_code} · {item.periods} 个报告期 · {item.source_versions} 个来源版本 · {item.facts} 条数据</p>)}</details>
  </section>
}
