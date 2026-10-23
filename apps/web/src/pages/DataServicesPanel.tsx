import { useEffect, useRef, useState } from 'react'
import { Database, Globe, Sparkles } from 'lucide-react'
import { api, type DataStatus } from '../api'
import { useSecurities } from '../components/StockSearch'
import { trapDialogTab } from '../keyboard'
import DataUpdateProgress, { type UpdateJob } from './DataUpdateProgress'
import FinancialProbePanel from './FinancialProbePanel'
import CompanyFinancialsPanel from '../components/CompanyFinancialsPanel'

type Settings = {
  text_model: { configured: boolean; model: string | null; api_mode?: string | null }
  tushare: { configured: boolean }
  codex_runtime?: {
    available: boolean; reason?: string
    web_search?: { enabled: boolean; mode: 'live' | 'cached' | 'disabled' | null; state: string; verification?: string }
  }
}

function webSearchLabel(runtime: Settings['codex_runtime']) {
  const search = runtime?.web_search
  if (!search) return '状态不可用'
  if (search.state === 'invalid_configuration') return '配置无效'
  if (search.state === 'provider_unsupported') return '模型服务未声明支持'
  if (search.state === 'configuration_unavailable') return '模型服务能力未知'
  if (search.state === 'disabled') return '已关闭'
  if (search.enabled && runtime?.available === false) return '已配置，但 Codex 运行时不可用'
  if (search.enabled) return search.mode === 'cached' ? '缓存搜索已配置' : '实时搜索已配置'
  return '当前不可用'
}

export default function DataServicesPanel({ data, onClose, onRefresh }: { data: DataStatus | null; onClose: () => void; onRefresh: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsRetry, setSettingsRetry] = useState(0)
  const [financialOpen, setFinancialOpen] = useState(false)
  const [job, setJob] = useState<UpdateJob | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [statusError, setStatusError] = useState('')
  const [modelResult, setModelResult] = useState('尚未检查')
  const [webSearchResult, setWebSearchResult] = useState('')
  const [poll, setPoll] = useState(0)
  const completedJob = useRef('')
  const replacedJob = useRef('')
  const closeButton = useRef<HTMLButtonElement>(null)
  const catalog = useSecurities()
  const updating = !!job && ['queued', 'running'].includes(job.state)
  const webSearchReady = Boolean(settings?.codex_runtime?.available && settings?.codex_runtime?.web_search?.enabled)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    api<Settings>('/settings/status', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setSettings(value) }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => { controller.abort() }
  }, [settingsRetry])
  useEffect(() => {
    let active = true, pending = false
    const controller = new AbortController()
    async function load() {
      if (pending) return
      pending = true
      try {
        const result = await api<{ job: UpdateJob | null }>('/maintenance/status', { signal: controller.signal })
        if (!active) return
        if (replacedJob.current && (!result.job || result.job.id === replacedJob.current)) return
        replacedJob.current = ''
        setJob(result.job)
        setStatusError(''); setLoadingStatus(false)
        if (result.job && !['queued', 'running'].includes(result.job.state) && completedJob.current !== result.job.id) {
          completedJob.current = result.job.id
          onRefresh(); catalog.refresh()
        }
      } catch (reason) {
        if (active) {
          setStatusError(`更新进度暂时无法刷新：${(reason as Error).message}`)
          setLoadingStatus(false)
        }
      }
      finally { pending = false }
    }
    void load()
    const timer = setInterval(() => void load(), 1000)
    return () => { active = false; controller.abort(); clearInterval(timer) }
  }, [poll])
  async function updateData() {
    setSubmitting(true); setError('')
    try {
      const result = await api<{ job_id: string }>('/maintenance/refresh', { method: 'POST' })
      // Replace the previous run immediately, including its result and completion state.
      replacedJob.current = job && job.id !== result.job_id ? job.id : ''
      setJob({ id: result.job_id, state: 'queued', message: '正在等待更新股票名称、行情和资讯', progress: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      setPoll(value => value + 1)
    }
    catch (reason) { setError((reason as Error).message) }
    finally { setSubmitting(false) }
  }
  async function checkConnection() {
    setChecking(true); setError('')
    try {
      const current = await api<Settings>('/settings/status'); setSettings(current)
      if (!current.text_model.configured) { setModelResult('智能助手尚未配置，请联系维护者完成首次设置。'); return }
      const result = await api<{ connected: boolean }>('/settings/model-test', { method: 'POST' })
      setModelResult(result.connected
        ? current.codex_runtime?.available === false
          ? '模型接口已连通，Codex 研究运行时尚未就绪。请保存诊断信息交给维护者。'
          : current.codex_runtime?.web_search?.enabled
            ? '模型接口与 Codex 运行时可用；网页搜索为配置状态，本次检查未发起实时检索。'
            : `模型接口与 Codex 运行时可用；网页搜索状态：${webSearchLabel(current.codex_runtime)}。`
        : '模型接口暂时无法连接，请稍后重试，或保存诊断信息交给维护者。')
    } catch (reason) { setModelResult((reason as Error).message || '连接检查失败，请稍后重试。') }
    finally { setChecking(false) }
  }
  async function checkWebSearch() {
    setChecking(true); setError(''); setWebSearchResult('')
    try {
      const result = await api<{ connected: boolean; verified: boolean; search_results: number; opened_page: boolean; latency_ms: number; message: string }>('/settings/web-search-test', { method: 'POST' })
      setWebSearchResult(`${result.message} · ${result.search_results} 条搜索结果 · ${result.latency_ms} ms`)
    } catch (reason) { setWebSearchResult((reason as Error).message || '网页搜索检查失败，请稍后重试。') }
    finally { setChecking(false) }
  }
  function downloadDiagnostics() {
    const report = { checked_at: new Date().toISOString(), market_date: data?.last_date ?? null, market_available: !!data?.available,
      quality_status: data?.quality_status, model_configured: !!settings?.text_model.configured, research_runtime_available: settings?.codex_runtime?.available ?? null, research_runtime_reason: settings?.codex_runtime?.reason ?? null, connection: modelResult,
      web_search: settings?.codex_runtime?.web_search ?? null, web_search_test: webSearchResult || null,
      update: job }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = '投研工作台-诊断信息.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <aside className="system-drawer workspace-tool-dialog workspace-drawer data-services-dialog" role="dialog" aria-modal="true" aria-label="数据与服务" onKeyDown={event => {
      if (event.key === 'Escape') onClose()
      trapDialogTab(event)
    }}>
      <div className="drawer-header"><h2>数据与服务</h2><button ref={closeButton} className="secondary-button compact workspace-button" onClick={onClose}>关闭</button></div>
      <div className="drawer-body">
      {error && <p role="alert" className="library-error workspace-error">{error}<button className="text-button workspace-button" onClick={() => { setError(''); setSettingsRetry(value => value + 1); setPoll(i => i + 1); onRefresh() }}>重新检查</button></p>}
      <section className="drawer-section service-summary"><h3><Database size={18} aria-hidden="true" />我的数据</h3><strong>{data?.available ? data.last_date ? `行情更新至 ${data.last_date}` : '行情可用，日期待确认' : '暂时没有可用行情'}</strong>
        <p>{data?.quality_status === 'issues_found' ? '部分行情有异常，涉及这些行情的条件会显示“数据不足”。' : data?.available ? '本地行情可供查询，价格为未复权日线。' : '尚无可用行情。'}{data?.formal_blockers?.length ? '成交量、成交额单位及证券基础资料和历史交易日历仍需核实。' : ''}</p>
        {settings && <p>{settings.tushare.configured ? 'Tushare 官方 token 已配置，数据权限以官方账户为准。' : 'Tushare 官方 token 待配置，完成配置后可更新外部数据。'}</p>}
        <button className="primary-button workspace-button" disabled={loadingStatus || !!statusError || updating || submitting} onClick={() => void updateData()}>{loadingStatus ? '正在读取更新状态…' : statusError ? '无法确认更新状态' : updating || submitting ? '正在更新…' : '更新股票名称、行情和资讯'}</button>
        {statusError && <p role="alert" className="workspace-error">{statusError}<button className="text-button workspace-button" onClick={() => setPoll(i => i + 1)}>重试读取进度</button></p>}
        {job && <DataUpdateProgress job={job} />}
        {job && ['failed', 'partial'].includes(job.state) && <p>本次更新未全部完成，请查看各阶段详情；原有资料仍可使用。</p>}
      </section>
      <FinancialProbePanel />
      <details className="drawer-section" open={financialOpen} onToggle={event => setFinancialOpen(event.currentTarget.open)}><summary>标准财务与指标计算</summary>{financialOpen && <CompanyFinancialsPanel allowSync />}</details>
      <section className="drawer-section service-summary"><h3><Sparkles size={18} aria-hidden="true" />智能助手</h3><p>{!settings ? (error ? '暂时无法读取连接设置。' : '正在读取助手设置…') : settings.text_model.configured ? '已完成连接设置。' : '尚未配置智能助手。'}</p>
        {settings && <><p>Codex 研究运行时：{settings.codex_runtime?.available ? '可用' : '不可用'}{settings.codex_runtime?.reason ? ` · ${settings.codex_runtime.reason}` : ''}</p><p>原生网页搜索：{webSearchLabel(settings.codex_runtime)}。配置状态不代表实时搜索已成功。</p></>}
        <button className="secondary-button workspace-button" disabled={checking} onClick={() => void checkConnection()}>{checking ? '正在检查…' : '检查助手连接'}</button>{modelResult && <p role="status">{modelResult}</p>}
        <button className="secondary-button workspace-button" data-tooltip="发起一次 Codex 网页搜索请求" disabled={checking || !webSearchReady} onClick={() => void checkWebSearch()}><Globe size={15} />{checking ? '正在搜索…' : '测试原生网页搜索'}</button>{webSearchResult && <p role="status">{webSearchResult}</p>}
      </section>

      <details className="drawer-section support-details"><summary>诊断与维护信息</summary><button className="secondary-button compact workspace-button" onClick={downloadDiagnostics}>保存诊断信息</button><p>模型：{settings?.text_model.model || '未配置'} · {settings?.text_model.api_mode || '未配置'}</p><p>行情记录 {data?.rows?.toLocaleString() || '—'} 条，证券 {data?.securities?.toLocaleString() || '—'} 只。</p>{data?.formal_blockers?.map(item => <p key={item}>{item}</p>)}</details>
      </div>
      <div className="drawer-footer"><button className="secondary-button workspace-button" onClick={() => { onRefresh(); setPoll(i => i + 1) }}>重新检查状态</button></div>
    </aside>
  </div>
}
