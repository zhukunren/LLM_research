import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Check, Copy, FileText, Sparkles } from 'lucide-react'
import { api, ApiRequestError } from '../api'
import { disclosureLines, withoutWebLinks } from '../clientService'
import LoadingState from '../components/LoadingState'
import { useSecurities } from '../components/StockSearch'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import { useSessionState } from '../useSessionState'
import { useWorkspaceSession } from '../WorkspaceSession'
import './rebalance-suggestion.css'

const endpoint = '/client-service/rebalance-suggestions'
const codePattern = /^[0-9]{6}(?:\.(SH|SZ|BJ))?$/
const initialDraft = {
  product: '丰收成长尊享（全账户）', code: '', name: '', direction: '',
  before: '', after: '', price: '', reason: '', basis: '', appliedRequest: '',
}
const directions = ['开仓买入', '加仓', '减仓', '止盈调出', '止损调出', '调出']
type Draft = typeof initialDraft
type Request = { id: string; code: string; direction: string; accepted: boolean }
type Report = { document_id?: string; url?: string; title: string; broker: string; authors: string; publication_date: string }
type Collected = { state: 'succeeded'; reason: string; basis: string; report: Report }
type Status = {
  request_id: string; code: string; stock_name: string; direction: string; cutoff: string; message: string
} & (Collected | { state: 'awaiting_agent' | 'running' | 'no_evidence' | 'failed' | 'cancelled' })
type SuccessfulStatus = Extract<Status, Collected>

const normalizeCode = (code: string) => code.trim().toUpperCase()
const pending = (status: Status) => status.state === 'awaiting_agent' || status.state === 'running'
const statusPath = (id: string) => endpoint + '/' + encodeURIComponent(id)
const clean = (value: string) => withoutWebLinks(value).trim()

function validDraft(value: unknown): value is Draft {
  return !!value && typeof value === 'object' && Object.keys(initialDraft).every(key => typeof (value as Record<string, unknown>)[key] === 'string')
}

function validRequest(value: unknown): value is Request | null {
  if (value === null) return true
  const item = value as Partial<Request> | undefined
  return typeof item?.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(item.id)
    && typeof item.code === 'string' && codePattern.test(item.code) && typeof item.direction === 'string' && typeof item.accepted === 'boolean'
}

function percentage(input: string) {
  const value = input.trim().replace(/[％%]$/, '').trim()
  return /^[0-9]{1,3}(?:\.[0-9]+)?$/.test(value) && Number(value) <= 100 ? value + '%' : ''
}

function matchesDraft(status: Status, draft: Draft) {
  const code = normalizeCode(draft.code)
  return status.direction === clean(draft.direction) && (status.code === code || status.code.slice(0, 6) === code)
}

function applyCollection(draft: Draft, result: SuccessfulStatus) {
  return { ...draft, name: draft.name || result.stock_name, reason: result.reason, basis: result.basis, appliedRequest: result.request_id }
}

export default function RebalanceSuggestionPage() {
  const { active } = useWorkspaceSession()
  const { items } = useSecurities()
  const [draft, setDraft] = useSessionState('client-service.rebalance.draft', initialDraft, validDraft)
  const [request, setRequest] = useSessionState<Request | null>('client-service.rebalance.request', null, validRequest)
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null)
  const [retry, setRetry] = useState(0)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [stopping, setStopping] = useState(false)
  const polling = useRef<AbortController | null>(null)
  const current = status?.request_id === request?.id ? status : null
  const collection = current?.state === 'succeeded' && matchesDraft(current, draft) ? current : null
  const busy = !!request && !error && (!current || pending(current))
  const code = normalizeCode(draft.code)
  const direction = clean(draft.direction)
  const matchingStocks = useMemo(() => codePattern.test(code) ? items.filter(item =>
    item.market !== '指数' && (item.stock_code === code || item.stock_code.slice(0, 6) === code),
  ) : [], [code, items])
  const name = clean(draft.name) || (matchingStocks.length === 1 ? clean(matchingStocks[0].name) : '')
  const codeReady = codePattern.test(code) && matchingStocks.length <= 1
  const before = percentage(draft.before)
  const after = percentage(draft.after)
  const price = draft.price.trim()
  const priceReady = /^\d+(?:\.\d+)?$/.test(price) && Number(price) > 0
  const ready = !!(clean(draft.product) && codeReady && name && direction && before && after && priceReady)
  const paragraphs = [
    [
      `投顾产品：${clean(draft.product)}`,
      `股票名称：${[name, codeReady ? code.slice(0, 6) : ''].filter(Boolean).join(' ')}`,
      `调仓方向：${direction}`,
      `仓位变化：${before || after ? before + '—' + after : ''}`,
      `参考价格：${priceReady ? price : ''}`,
    ].join('\n'),
    clean(draft.reason) && `调仓理由：${clean(draft.reason)}`,
    clean(draft.basis) && `调仓依据：${clean(draft.basis)}`,
    disclosureLines.join('\n'),
  ]
  const text = paragraphs.filter(Boolean).join('\n\n')

  useEffect(() => {
    if (!active || !request) return
    const { id, code: submittedCode, direction: submittedDirection, accepted } = request
    const controller = new AbortController()
    polling.current = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    setError(null)

    async function read() {
      if (controller.signal.aborted) return
      try {
        const value = accepted
          ? await api<Status>(statusPath(id), { signal: controller.signal })
          : await api<Status>(endpoint, { method: 'POST', signal: controller.signal,
            body: JSON.stringify({ request_id: id, code: submittedCode, direction: submittedDirection }) })
        if (controller.signal.aborted) return
        setStatus(value)
        if (value.state === 'succeeded') {
          setDraft(current => {
            if (!matchesDraft(value, current) || current.appliedRequest === id) return current
            // A result cannot replace or attach sources to a separately edited paragraph.
            return current.reason.trim() || current.basis.trim()
              ? { ...current, name: current.name || value.stock_name }
              : applyCollection(current, value)
          })
        }
        if (!accepted) setRequest(current => current?.id === id ? { ...current, accepted: true } : current)
        else if (pending(value)) timer = setTimeout(() => void read(), 2000)
      } catch (reason) {
        if (!controller.signal.aborted) setError({
          message: reason instanceof Error ? reason.message : '暂时无法读取采集结果。',
          retry: !(reason instanceof ApiRequestError) || reason.status >= 500,
        })
      }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, request, retry, setRequest, setDraft])

  function change(field: keyof Draft, value: string) {
    setNotice('')
    setDraft(current => ({
      ...current,
      ...(field === 'code' && normalizeCode(current.code).slice(0, 6) !== normalizeCode(value).slice(0, 6) ? { name: '' } : {}),
      [field]: value,
    }))
  }

  function collect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!codeReady || !direction || busy || stopping) return
    setStatus(null)
    setError(null)
    setActionError('')
    setNotice('')
    setRequest({ id: crypto.randomUUID(), code, direction, accepted: false })
  }

  async function stop() {
    if (!request?.accepted || stopping) return
    setStopping(true)
    setActionError('')
    try {
      const value = await api<Status>(statusPath(request.id) + '/cancel', { method: 'POST' })
      polling.current?.abort()
      setStatus(value)
      setError(null)
    } catch {
      setActionError('暂时无法停止采集，请稍后重试。')
    } finally {
      setStopping(false)
    }
  }

  async function copy() {
    if (!ready) return
    try {
      await navigator.clipboard.writeText(text)
      setActionError('')
      setNotice('文案已复制，含风险提示和投顾落款')
    } catch {
      setActionError('复制失败，请在预览中选中文案后手动复制。')
    }
  }

  return <div className="page-content workspace-tool-page rebalance-suggestion-page">
    <WorkspacePageHeading actions={null}><h1>生成建议</h1></WorkspacePageHeading>
    <div className="rebalance-suggestion-studio">
      <form className="rebalance-suggestion-panel" onSubmit={collect}>
        <h2>编辑调仓文案</h2>
        <div className="rebalance-suggestion-fields">
          <label className="rebalance-suggestion-wide">投顾产品<input className="workspace-field" maxLength={80} value={draft.product} onChange={event => change('product', event.target.value)} /></label>
          <label>股票代码<input className="workspace-field" placeholder="如 603650" maxLength={15} autoComplete="off" value={draft.code} onChange={event => change('code', event.target.value)} /></label>
          <label>股票名称<input className="workspace-field" value={draft.name || name} maxLength={50} onChange={event => change('name', event.target.value)} /></label>
          {code && !codeReady && <p className="rebalance-suggestion-wide rebalance-suggestion-feedback">请输入六位 A 股代码，可带 .SH、.SZ 或 .BJ。</p>}
          <label>调仓方向<input className="workspace-field" list="rebalance-directions" placeholder="选择或输入" maxLength={30} value={draft.direction} onChange={event => change('direction', event.target.value)} /><datalist id="rebalance-directions">{directions.map(item => <option key={item} value={item} />)}</datalist></label>
          <label>参考价格<input className="workspace-field" inputMode="decimal" placeholder="如 46.70" maxLength={18} value={draft.price} onChange={event => change('price', event.target.value)} aria-invalid={!!draft.price && !priceReady} /></label>
          <fieldset className="rebalance-suggestion-wide">
            <legend>仓位变化</legend>
            <div className="rebalance-suggestion-percentages">
              <label>调仓前（%）<input className="workspace-field" inputMode="decimal" maxLength={12} value={draft.before} onChange={event => change('before', event.target.value)} aria-invalid={!!draft.before && !before} /></label>
              <label>调仓后（%）<input className="workspace-field" inputMode="decimal" maxLength={12} value={draft.after} onChange={event => change('after', event.target.value)} aria-invalid={!!draft.after && !after} /></label>
            </div>
          </fieldset>
        </div>
        <div className="rebalance-suggestion-collection">
          <button type="submit" className="secondary-button workspace-button" disabled={!codeReady || !direction || busy || stopping}><Sparkles size={16} />AI 采集研报</button>
          {busy && <LoadingState compact label={current?.state === 'running' ? '正在查找研报并整理文案…' : '等待开始采集…'} />}
          {busy && request?.accepted && <button type="button" className="text-button workspace-button" disabled={stopping} onClick={() => void stop()}>{stopping ? '正在停止…' : '停止采集'}</button>}
        </div>
        {error && <div role="alert" className="workspace-error rebalance-suggestion-feedback">{error.message} {error.retry && <button type="button" className="text-button workspace-button" onClick={() => setRetry(value => value + 1)}>重试连接</button>}</div>}
        {current && ['failed', 'cancelled', 'no_evidence'].includes(current.state) && <p role="status" className="rebalance-suggestion-feedback">{current.message}</p>}
        {collection && <details className="rebalance-suggestion-evidence">
          <summary>已采集研报</summary>
          <p>{collection.basis}</p>
          <p>{collection.reason}</p>
          <div className="rebalance-suggestion-collection">
            <a href={collection.report.document_id ? '/api/v1/documents/' + encodeURIComponent(collection.report.document_id) + '/pdf' : collection.report.url} target="_blank" rel="noreferrer">打开研报原文</a>
            {(draft.reason !== collection.reason || draft.basis !== collection.basis) && <button type="button" className="secondary-button workspace-button" onClick={() => { setDraft(current => matchesDraft(collection, current) ? applyCollection(current, collection) : current); setNotice('AI 文案已填入，可继续编辑') }}>填入理由和依据</button>}
          </div>
        </details>}
        <div className="rebalance-suggestion-fields">
          <label className="rebalance-suggestion-wide">调仓理由 <small>选填</small><textarea className="workspace-field" rows={6} maxLength={1600} value={draft.reason} onChange={event => change('reason', event.target.value)} /></label>
          <label className="rebalance-suggestion-wide">调仓依据 <small>选填</small><textarea className="workspace-field" rows={3} maxLength={650} value={draft.basis} onChange={event => change('basis', event.target.value)} /></label>
        </div>
      </form>
      <section className="rebalance-suggestion-panel" aria-label="调仓文案预览">
        <header className="rebalance-suggestion-preview-heading"><h2><FileText size={17} />文案预览</h2><button type="button" className="primary-button workspace-button" onClick={() => void copy()} disabled={!ready}><Copy size={16} />复制文案</button></header>
        {!ready && <p className="rebalance-suggestion-feedback">填齐产品、股票、方向、前后仓位和参考价格后即可复制。</p>}
        {actionError && <p role="alert" className="workspace-error rebalance-suggestion-feedback">{actionError}</p>}
        {notice && <p role="status" className="workspace-feedback-success rebalance-suggestion-feedback"><Check size={15} />{notice}</p>}
        <pre aria-label="可复制文案预览">{text}</pre>
      </section>
    </div>
  </div>
}
