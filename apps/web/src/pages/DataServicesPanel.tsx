import { useEffect, useRef, useState } from 'react'
import { api, type DataStatus } from '../api'
import { useSecurities } from '../components/StockSearch'
import { trapDialogTab } from '../keyboard'

type Settings = { text_model: { configured: boolean; model: string | null; api_mode?: string | null }; tushare: { configured: boolean }; codex_runtime?: { available: boolean; reason?: string } }
type UpdateJob = { id: string; state: string; message: string; progress: number; updated_at: string }
export default function DataServicesPanel({ data, onClose, onRefresh }: { data: DataStatus | null; onClose: () => void; onRefresh: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [job, setJob] = useState<UpdateJob | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [modelResult, setModelResult] = useState('尚未检查')
  const [poll, setPoll] = useState(0)
  const completedJob = useRef('')
  const closeButton = useRef<HTMLButtonElement>(null)
  const catalog = useSecurities()
  const updating = !!job && ['queued', 'running'].includes(job.state)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    const controller = new AbortController()
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    api<Settings>('/settings/status', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setSettings(value) }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => { controller.abort(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    let active = true, pending = false
    async function load() {
      if (pending) return
      pending = true
      try {
        const result = await api<{ job: UpdateJob | null }>('/maintenance/status')
        if (!active) return
        setJob(result.job)
        if (result.job && !['queued', 'running'].includes(result.job.state) && completedJob.current !== result.job.id) {
          completedJob.current = result.job.id
          onRefresh(); catalog.refresh()
        }
      } catch (reason) { if (active) setError((reason as Error).message) }
      finally { pending = false }
    }
    void load()
    const timer = setInterval(() => void load(), 2500)
    return () => { active = false; clearInterval(timer) }
  }, [poll])
  async function updateData() {
    setSubmitting(true); setError(''); setNotice('')
    try { await api('/maintenance/refresh', { method: 'POST' }); setNotice('更新已开始。'); setPoll(value => value + 1) }
    catch (reason) { setError((reason as Error).message) }
    finally { setSubmitting(false) }
  }
  async function checkConnection() {
    setChecking(true); setError('')
    try {
      const current = await api<Settings>('/settings/status'); setSettings(current)
      if (!current.text_model.configured) { setModelResult('智能助手尚未配置，请联系维护者完成首次设置。'); return }
      const result = await api<{ connected: boolean }>('/settings/model-test', { method: 'POST' })
      setModelResult(result.connected ? current.codex_runtime?.available === false ? '模型接口已连通，研究环境尚未就绪。请保存诊断信息交给维护者。' : current.codex_runtime?.available ? '模型接口连接正常，研究环境已就绪。' : '模型接口已连通，研究环境状态尚待确认。' : '模型接口暂时无法连接，请稍后重试，或保存诊断信息交给维护者。')
    } catch (reason) { setModelResult((reason as Error).message || '连接检查失败，请稍后重试。') }
    finally { setChecking(false) }
  }
  function downloadDiagnostics() {
    const report = { checked_at: new Date().toISOString(), market_date: data?.last_date ?? null, market_available: !!data?.available,
      quality_status: data?.quality_status, model_configured: !!settings?.text_model.configured, research_runtime_available: settings?.codex_runtime?.available ?? null, research_runtime_reason: settings?.codex_runtime?.reason ?? null, connection: modelResult,
      update: job ? { state: job.state, message: job.message, updated_at: job.updated_at } : null }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = '投研工作台-诊断信息.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <aside className="system-drawer" role="dialog" aria-modal="true" aria-label="数据与服务" onKeyDown={event => {
      if (event.key === 'Escape') onClose()
      trapDialogTab(event)
    }}>
      <div className="drawer-header"><h2>数据与服务</h2><button ref={closeButton} className="secondary-button compact" onClick={onClose}>关闭</button></div>
      {error && <p role="alert" className="library-error">{error}<button className="text-button" onClick={() => { setError(''); setPoll(i => i + 1); onRefresh() }}>重新检查</button></p>}
      <section className="drawer-section service-summary"><h3>我的数据</h3><strong>{data?.available ? data.last_date ? `行情更新至 ${data.last_date}` : '行情可用，日期待确认' : '暂时没有可用行情'}</strong>
        <p>{data?.quality_status === 'issues_found' ? '部分行情有异常，涉及这些行情的条件会显示“数据不足”。' : data?.available ? '本地行情可供查询。' : '尚无可用行情。'}{data?.formal_blockers?.length ? '价格复权及量额口径仍需维护者核实。' : ''}</p>
        <button className="primary-button" disabled={updating || submitting} onClick={() => void updateData()}>{updating || submitting ? '正在更新…' : '更新股票名称、行情和资讯'}</button>
        {updating && <progress aria-label="数据更新进度" max={1} value={job!.progress} />}
        {(job || notice) && <p role="status">{job?.message || notice}</p>}
        {job && ['failed', 'partial'].includes(job.state) && <p>更新未成功，原资料已保留。</p>}
      </section>
      <section className="drawer-section service-summary"><h3>智能助手</h3><p>{!settings ? (error ? '暂时无法读取连接设置。' : '正在读取助手设置…') : settings.text_model.configured ? '已完成连接设置。' : '尚未配置智能助手。'}</p>
        <button className="secondary-button" disabled={checking} onClick={() => void checkConnection()}>{checking ? '正在检查…' : '检查助手连接'}</button>{modelResult && <p role="status">{modelResult}</p>}
      </section>

      <details className="drawer-section support-details"><summary>诊断与维护信息</summary><button className="secondary-button compact" onClick={downloadDiagnostics}>保存诊断信息</button><p>模型：{settings?.text_model.model || '未配置'} · {settings?.text_model.api_mode || '未配置'}</p><p>行情记录 {data?.rows?.toLocaleString() || '—'} 条，证券 {data?.securities?.toLocaleString() || '—'} 只。</p>{data?.formal_blockers?.map(item => <p key={item}>{item}</p>)}</details>
      <div className="drawer-footer"><button className="secondary-button" onClick={() => { onRefresh(); setPoll(i => i + 1) }}>重新检查状态</button></div>
    </aside>
  </div>
}
