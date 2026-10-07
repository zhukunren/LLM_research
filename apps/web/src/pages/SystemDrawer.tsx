import { useEffect, useState } from 'react'
import { Database, ExternalLink, KeyRound, Network, RefreshCw, X, Zap } from 'lucide-react'
import { api, type DataStatus } from '../api'

type Settings = {
  text_model: { configured: boolean; model: string | null; api_mode?: string | null; credential_source: string | null }
  tushare: { configured: boolean; credential_source: string; uses_adapter_default: boolean; news_access: boolean; market_access: boolean }
  runtime: { data_root_configured: boolean; report_directory_configured: boolean }
  notice: string
}

export default function SystemDrawer({ data, onClose, onRefresh }: { data: DataStatus | null; onClose: () => void; onRefresh: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [health, setHealth] = useState('读取中')
  const [modelCheck, setModelCheck] = useState('')
  const [toolCheck, setToolCheck] = useState('')
  const [checkingModel, setCheckingModel] = useState(false)
  useEffect(() => {
    api<Settings>('/settings/status').then(setSettings).catch(() => undefined)
    api<{ status: string }>('/health').then((result) => setHealth(result.status === 'ok' ? '运行正常' : '状态异常')).catch(() => setHealth('服务不可用'))
  }, [])

  async function testModel() {
    setCheckingModel(true); setModelCheck('')
    try {
      const result = await api<{
        connected: boolean; model?: string; api_mode: string; latency_ms?: number
        endpoint_reachable?: boolean; authenticated?: boolean; models_endpoint_supported?: boolean
        model_listed?: boolean | null; message?: string
      }>('/settings/model-test', { method: 'POST' })
      if (result.connected) setModelCheck(`连接成功 · ${result.model} · ${result.api_mode} · ${result.latency_ms} ms`)
      else {
        const listed = result.model_listed === true ? '模型已列出' : result.model_listed === false ? '模型未列出' : '未验证模型列表'
        setModelCheck(`${result.endpoint_reachable ? '端点可达' : '端点不可达'} · ${result.authenticated === false ? '认证失败' : result.authenticated ? '认证通过' : '认证状态未知'} · ${listed}${result.message ? ` · ${result.message}` : ''}`)
      }
    } catch (error) { setModelCheck((error as Error).message) }
    finally { setCheckingModel(false) }
  }
  async function testModelTools() {
    setCheckingModel(true); setToolCheck('')
    try {
      const result = await api<{
        connected: boolean; tool_calling_supported: boolean; round_trip_completed: boolean
        echo_confirmed?: boolean; model?: string; api_mode?: string; latency_ms?: number; reason?: string
      }>('/settings/model-tool-test', { method: 'POST' })
      if (result.round_trip_completed) {
        setToolCheck('工具调用往返成功 · ' + result.model + ' · ' + result.api_mode + ' · ' + result.latency_ms + ' ms')
      } else if (!result.connected) {
        setToolCheck(result.reason === 'model_not_configured' ? '未配置文本模型' : '端点或模型请求失败' + (result.reason ? ' · ' + result.reason : ''))
      } else {
        setToolCheck(result.reason || (result.tool_calling_supported ? '工具结果回传未完成' : '模型未返回有效工具调用'))
      }
    } catch (error) { setToolCheck((error as Error).message) }
    finally { setCheckingModel(false) }
  }
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="system-drawer" aria-label="系统设置">
        <div className="drawer-header"><div><p className="eyebrow">本地服务与数据</p><h2>系统设置</h2></div><button className="icon-button" aria-label="关闭设置" onClick={onClose}><X size={18} /></button></div>
        <div className="drawer-section"><div className="section-title-row"><h3><Database size={16} />数据状态</h3><button className="table-action" title="刷新数据状态" onClick={onRefresh}><RefreshCw size={14} /></button></div>
          <div className="status-grid"><StatusLine label="本地行情文件" ok={Boolean(data?.available)} value={data?.available ? '已挂载' : '不可用'} /><StatusLine label="行数" value={data?.rows?.toLocaleString() ?? '—'} /><StatusLine label="证券代码" value={data?.securities?.toLocaleString() ?? '—'} /><StatusLine label="行情水位" value={data?.last_date ?? '—'} /><StatusLine label="基础质量检查" ok={data?.quality_status === 'basic_checks_passed'} value={data?.quality_status === 'basic_checks_passed' ? '通过' : data?.quality_status === 'issues_found' ? '发现问题' : '待检查'} /></div>
          <div className="market-counts">{Object.entries(data?.markets ?? {}).map(([market, count]) => <span key={market}>{market} <b>{count.toLocaleString()}</b></span>)}</div>
          <div className="unknown-grid"><div><span>价格复权</span><b>未知</b></div><div><span>成交量单位</span><b>未知</b></div><div><span>成交额单位</span><b>未知</b></div></div>
          {!!data?.formal_blockers?.length && <div className="drawer-blockers">{data.formal_blockers.map((item) => <p key={item}><span className="status-dot warning" />{item}</p>)}</div>}
        </div>

        <div className="drawer-section"><div className="section-title-row"><h3>服务能力</h3><span className="drawer-health">{health}</span></div>
          <div className="service-row"><div><b>文本模型</b><small>{settings?.text_model?.configured ? `${settings.text_model.model} · ${settings.text_model.api_mode}` : '未配置'}</small></div><span className={`status-pill ${settings?.text_model?.configured ? 'partial' : 'blocked_dependency'}`}>{settings?.text_model?.configured ? '已配置' : '待配置'}</span></div>
          <div className="model-test-row"><button className="secondary-button compact" disabled={checkingModel || !settings?.text_model?.configured} onClick={testModel}><Zap size={14} />{checkingModel ? '测试中…' : '测试连接'}</button>{modelCheck && <span role="status">{modelCheck}</span>}</div>
          <div className="model-test-row"><button className="secondary-button compact" disabled={checkingModel || !settings?.text_model?.configured} onClick={testModelTools}><Network size={14} />{checkingModel ? '测试中…' : '测试工具调用'}</button>{toolCheck && <span role="status">{toolCheck}</span>}</div>
          <div className="service-row"><div><b>Tushare 中转</b><small>{settings?.tushare?.uses_adapter_default ? '适配器默认配置' : '本地配置'}</small></div><span className={`status-pill ${settings?.tushare?.configured ? 'partial' : 'blocked_dependency'}`}>{settings?.tushare?.configured ? '可同步' : '不可用'}</span></div>
          <div className="service-row"><div><b>资讯数据</b><small>本地资讯</small></div><span className={`status-pill ${settings?.tushare?.news_access ? 'partial' : 'blocked_dependency'}`}>{settings?.tushare?.news_access ? '已接入' : '未接入'}</span></div>
          <div className="credential-note"><KeyRound size={15} /><p>模型配置：<code>config.ini</code></p></div>
        </div>

        <div className="drawer-section drawer-footer-section"><h3>本地运行</h3><a href="/docs" target="_blank" rel="noreferrer">打开 API 文档 <ExternalLink size={13} /></a></div>
        <div className="drawer-footer"><button className="secondary-button" onClick={onRefresh}><RefreshCw size={14} />刷新数据检查</button><button className="primary-button" onClick={onClose}>完成</button></div>
      </aside>
    </div>
  )
}

function StatusLine({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return <div className="status-line"><span>{label}</span><b className={ok === false ? 'unknown-value' : ''}>{value}</b></div>
}
