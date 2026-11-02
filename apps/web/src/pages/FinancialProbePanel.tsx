import { useEffect, useState } from 'react'
import { ClipboardCheck } from 'lucide-react'
import { api } from '../api'
import './financial-probe.css'

type Check = { key: string; endpoint: string; stock_code: string; status: string; message: string; received?: number; attempted: boolean }
type ProbeRun = {
  id: string; job_id: string; state: string; message: string; credential_matches: boolean
  summary: { planned: number; checked: number; attempted: number; companies_with_rows: number; source_versions: number; equivalent_groups?: number; conflict_groups?: number }
  input: { parameters: { as_of: string; period: string } }; checks: Check[]; note: string
}
export type FinancialStatus = {
  configured: boolean; can_probe: boolean; contract_version: string
  companies: { code: string; name: string; category: string }[]
  capabilities: { endpoint: string; label: string; status: string; checked_at: string | null }[]
  latest: ProbeRun | null
}
const labels: Record<string, string> = {
  available: '样本可用', denied: '权限受限', rate_limited: '调用受限', transient_error: '暂时连接失败',
  unknown: '尚未证实', empty: '样本为空', contract_error: '数据待核对', not_configured: '尚未配置',
  skipped: '未重复请求', configuration_error: '配置需处理', invalid_response: '响应无效',
}

export default function FinancialProbePanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<FinancialStatus | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [generation, setGeneration] = useState(0)
  const run = data?.latest
  const active = !!run && ['queued', 'running'].includes(run.state)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      try {
        const value = await api<FinancialStatus>('/financial-data/status', { signal: controller.signal })
        if (controller.signal.aborted) return
        if (!value || !Array.isArray(value.capabilities)) throw new Error('无法识别财务接口状态')
        setData(value); setError('')
        if (value.latest && ['queued', 'running'].includes(value.latest.state)) timer = setTimeout(() => void load(), 1500)
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError((reason as Error).message)
          timer = setTimeout(() => void load(), 5000)
        }
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [generation, refreshKey])
  async function start() {
    setSubmitting(true); setError('')
    try {
      await api('/maintenance/financial-probe', { method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID() }) })
      setGeneration(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setSubmitting(false) }
  }
  async function stop() {
    if (!run) return
    setSubmitting(true)
    try {
      await api(`/jobs/${run.job_id}/cancel`, { method: 'POST' })
      setGeneration(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setSubmitting(false) }
  }
  function download() {
    if (!data) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = '财务接口与十家公司试点.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const available = data?.capabilities.filter(item => item.status === 'available').length || 0
  const restricted = data?.capabilities.some(item => ['denied', 'rate_limited', 'configuration_error', 'invalid_response', 'contract_error', 'transient_error'].includes(item.status))
  return <section className="service-status-row financial-probe-panel" aria-label="财务与披露接口">
    <div className="service-status-main"><ClipboardCheck size={17} aria-hidden="true" /><div><h3>财务与披露接口</h3><p>{!data ? error ? '状态读取失败' : '正在读取状态…' : !data.configured ? 'Tushare 凭据待配置' : active ? '正在检查' : run && !run.credential_matches ? '凭据已变化，需重新检查' : restricted ? '部分接口受限或待处理' : available ? `${available} 项接口样本可用` : '样本可用性尚未证实'}</p></div>
      {data && <div className="service-status-actions">{data.can_probe && <button className="secondary-button workspace-button" aria-label={active ? '正在检查财务接口…' : submitting ? '正在提交…' : '检查接口与十家公司样本'} disabled={!data.configured || submitting || active} onClick={() => void start()}>{active ? '正在检查…' : submitting ? '正在提交…' : '检查接口'}</button>}{active && data.can_probe && <button className="text-button workspace-button" disabled={submitting} onClick={() => void stop()}>停止财务检查</button>}</div>}
    </div>
    {error && <p role="alert" className="workspace-error">财务接口状态：{error}<button className="text-button workspace-button" onClick={() => setGeneration(v => v + 1)}>重试财务状态</button></p>}
    {!data ? <p>正在读取财务接口状态…</p> : <>
      {!data.configured && <p>Tushare 凭据尚未配置，完成配置后可以检查。</p>}
      {!data.can_probe && <p>请由平台维护者运行接口检查。</p>}
      {active && run && <p className="service-status-message" role="status">{run.message} · 已处理 {run.summary.checked}/{run.summary.planned} 项</p>}
      <details className="service-status-details"><summary>接口检查详情</summary><p>检查 10 家公司的财务样本与公告索引，分别确认普通财务、VIP 和公告权限。</p>
      {run && <div>
        <p>{run.message}</p>
        {!run.credential_matches && <p>凭据已变化，下方历史试点不能证明当前权限；请重新检查。</p>}
        <p>已处理 {run.summary.checked}/{run.summary.planned} 项 · 实际请求 {run.summary.attempted} 次 · {run.summary.companies_with_rows}/10 家取得样本</p>
        <p>报告期 {run.input.parameters.period} · 研究截至 {run.input.parameters.as_of}</p>
        {!!run.summary.equivalent_groups && <p>{run.summary.equivalent_groups} 组来源仅更新标志不同，内容等价，已保留全部版本。</p>}
        {!!run.summary.conflict_groups && <p>{run.summary.conflict_groups} 组来源存在差异，需要核对后选用。</p>}
        <p>{run.note}</p>
      </div>}
      <details><summary>各接口权限与检查时间</summary><ul className="financial-probe-capabilities">
        {data.capabilities.map(item => <li key={item.endpoint}><span>{item.label}</span><span>{labels[item.status] || item.status}</span>{item.checked_at && <small>{new Date(item.checked_at).toLocaleString('zh-CN')}</small>}</li>)}
      </ul></details>
      <details><summary>试点公司与每项结果</summary><p>{data.companies.map(item => `${item.name}（${item.category}）`).join('、')}</p>
        {run?.checks.map(check => <div key={check.key} className="financial-probe-check"><strong>{check.stock_code} · {check.endpoint} · {labels[check.status] || check.status}</strong><p>{check.message}{check.received !== undefined ? ` 返回 ${check.received} 条。` : ''}</p></div>)}
      </details>
      {run && <button className="text-button workspace-button" onClick={download}>下载试点结果</button>}
      </details>
    </>}
  </section>
}
