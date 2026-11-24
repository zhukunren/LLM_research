import { useEffect, useState } from 'react'
import { Check, Copy, RefreshCw } from 'lucide-react'
import { api, ApiRequestError } from '../api'
import { sessionStorage } from '../authStorage'
import type { ModelMode } from '../modelSelection'
import ModelModeSwitch from './ModelModeSwitch'

type Result = { request_id: string; state: string; message: string; client_copy?: string; analysis?: string; sources?: { title: string; url: string; published_at?: string | null }[]; limitations?: string[] }
const activeStates = new Set(['awaiting_agent', 'running'])

function ExplanationDraft({ code, date, side, onBusy }: { code: string; date: string; side: 'buy' | 'sell'; onBusy: (busy: boolean) => void }) {
  const key = `trade-explanation:${code}:${date}:${side}`
  const [job, setJob] = useState<{ id: string; start: boolean; modelMode?: ModelMode } | null>(() => {
    try { const id = sessionStorage.getItem(key); return id ? { id, start: false } : null } catch { return null }
  })
  const [modelMode, setModelMode] = useState<ModelMode>('instant')
  const [result, setResult] = useState<Result | null>(null)
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [networkError, setNetworkError] = useState(false)
  const [actionError, setActionError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  useEffect(() => {
    if (!job) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setBusy(true); setNetworkError(false); setCopied(false)
    async function read(start: boolean) {
      try {
        const value = start ? await api<Result>('/daily-signals/reason', {
          method: 'POST', signal: controller.signal, body: JSON.stringify({ request_id: job!.id, code, date, side, model_mode: job!.modelMode }),
        }) : await api<Result>(`/daily-signals/reason/${encodeURIComponent(job!.id)}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setResult(value)
        if (activeStates.has(value.state)) timer = setTimeout(() => void read(false), 2500)
        else { setBusy(false); if (value.state === 'succeeded') setText(value.client_copy || '') }
      } catch (error) {
        if (!controller.signal.aborted) {
          setNetworkError(!(error instanceof ApiRequestError && [409, 422].includes(error.status))); setBusy(false)
          setResult({ request_id: job!.id, state: 'connection_error', message: error instanceof Error ? error.message : '暂时无法读取说明。' })
        }
      }
    }
    void read(job.start)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [job, attempt, code, date, side])
  function generate() {
    const retry = networkError && job
    const id = retry ? retry.id : crypto.randomUUID()
    try { sessionStorage.setItem(key, id) } catch { /* Server still retains the request. */ }
    setResult(null); setText(''); setActionError(''); setJob({ id, start: true, modelMode: retry ? retry.modelMode : modelMode }); setAttempt(value => value + 1)
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setActionError('') }
    catch { setActionError('复制失败，请选中文案手动复制。') }
  }
  async function cancel() {
    if (!job) return
    try {
      const value = await api<Result>(`/daily-signals/reason/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' })
      setResult(value); setBusy(false)
    } catch { setActionError('停止请求未成功，请稍后重试。') }
  }
  return <div className="trade-explanation-draft">
    <div className="trade-explanation-actions"><ModelModeSwitch value={modelMode} disabled={busy || networkError} onChange={setModelMode} />
      <button className="secondary-button workspace-button" disabled={busy} onClick={generate}><RefreshCw size={14} />{networkError ? '重试' : result?.state === 'succeeded' ? '重新生成' : 'Codex 生成说明'}</button>
      {busy && <><span role="status">{result?.message || '正在准备公开信息研究…'}</span><button className="text-button workspace-button" onClick={() => void cancel()}>停止</button></>}
    </div>
    {result && !busy && result.state !== 'succeeded' && <p role="alert" className="workspace-error">{result.message}</p>}
    {actionError && <p role="alert" className="workspace-error">{actionError}</p>}
    {result?.state === 'succeeded' && <>
      <textarea className="workspace-field trade-explanation-editor" aria-label="客户操作说明" value={text} rows={6} onChange={event => { setText(event.target.value); setCopied(false) }} />
      <div className="trade-explanation-copy"><span role="status">{copied ? '已复制当前文案' : '可编辑后复制'}</span><button className="primary-button workspace-button" disabled={!text.trim()} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制说明'}</button></div>
      {!!result.sources?.length && <ul className="trade-explanation-sources">{result.sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>{source.published_at && <time>{source.published_at}</time>}</li>)}</ul>}
      {!!result.limitations?.length && <p className="trade-explanation-limitations">{result.limitations.join('；')}</p>}
    </>}
  </div>
}

export default function TradeExplanation({ code, date, initialSide }: { code: string; date: string; initialSide: 'buy' | 'sell' }) {
  const [side, setSide] = useState(initialSide)
  const [busy, setBusy] = useState(false)
  return <section className="trade-explanation" aria-label="客户操作说明">
    <header><h3>客户操作说明</h3><div role="group" aria-label="操作方向"><button className="workspace-button" aria-pressed={side === 'buy'} disabled={busy} onClick={() => setSide('buy')}>买入</button><button className="workspace-button" aria-pressed={side === 'sell'} disabled={busy} onClick={() => setSide('sell')}>卖出</button></div></header>
    <p className="trade-explanation-intro">Codex 检索公开信息并结合技术面，解释操作考虑。</p>
    <ExplanationDraft key={side} code={code} date={date} side={side} onBusy={setBusy} />
  </section>
}
