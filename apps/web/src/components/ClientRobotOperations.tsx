import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, ApiRequestError } from '../api'
import { marketTime, type RebalanceCardContent } from '../clientService'
import { useWorkspaceSession } from '../WorkspaceSession'
import LoadingState from './LoadingState'
import './client-robot-operations.css'

const endpoint = '/client-service/robots'
type Robot = { id: string; name: string; enabled: boolean; revision?: number }
type Delivery = { id: string; robot_name: string; state: 'sending' | 'sent' | 'failed' | 'unknown'; message: string; created_at: string }
type Review = { passed: boolean; issues: { code: string; message: string }[]; bytes: number }
type Risks = { items: Delivery[]; paused: Pick<Robot, 'name' | 'id'>[] }
type BroadcastBody = { kind: 'text'; content_text: string } | { kind: 'image'; suggestion: RebalanceCardContent }
type Batch = { id: string; targets: Robot[]; body: BroadcastBody }
type Receipt = { id: string; group: string; state: Delivery['state']; message: string }
const deliveryNames = { sending: '发送中', sent: '已接收', failed: '发送失败', unknown: '结果未确认' }

export function ClientRobotRiskMonitor({ robotId }: { robotId: string }) {
  const { active } = useWorkspaceSession()
  const [risks, setRisks] = useState<Risks | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const result = await api<Risks>(endpoint + '/risks?robot_id=' + encodeURIComponent(robotId), { signal: controller.signal })
        if (!controller.signal.aborted) { setRisks(result); setError('') }
      } catch (reason) {
        if (!controller.signal.aborted) setError((reason as Error).message)
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void read(), 20000)
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, robotId, revision])

  return <section className="robot-operation" aria-label="推送状态">
    <header className="client-panel-heading"><h3>推送状态</h3><button type="button" className="secondary-button workspace-button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />刷新</button></header>
    {error && <p role="alert" className="workspace-error">{error}</p>}
    {!error && !risks && <LoadingState compact label="正在读取群发状态…" />}
    {risks && <>
      <dl className="robot-risk-counts">
        <div><dt>发送失败</dt><dd>{risks.items.filter(item => item.state === 'failed').length}</dd></div>
        <div><dt>结果未确认</dt><dd>{risks.items.filter(item => item.state === 'unknown').length}</dd></div>
        <div><dt>发送中</dt><dd>{risks.items.filter(item => item.state === 'sending').length}</dd></div>
        <div><dt>已停用机器人</dt><dd>{risks.paused.length}</dd></div>
      </dl>
      {risks.paused.length > 0 && <p>已停用 {risks.paused.map(item => item.name).join('、')}</p>}
      {risks.items.length === 0 ? <p>目前没有失败或待确认的发送。</p> :
        <ul className="robot-operation-list">{risks.items.map(item => <li key={item.id}>
          <strong>{item.robot_name}</strong> <span className={`client-delivery-state is-${item.state}`}>{deliveryNames[item.state]}</span>
          <small>{marketTime(item.created_at)} · {item.message}</small>
        </li>)}</ul>}
    </>}
  </section>
}

function ReviewResult({ value }: { value: Review }) {
  return <section className="robot-review-result" aria-label="文案检查结果" data-passed={value.passed}>
    <strong role="status">{value.passed ? '已通过基础规则检查' : '以下内容需复核'}</strong>
    <span> · {value.bytes} 字节</span>
    {!value.passed && <ul>{value.issues.map(issue => <li key={issue.code}>{issue.message}</li>)}</ul>}
  </section>
}

const reviewText = (text: string, kind: 'text' | 'image') => api<Review>(endpoint + '/review', {
  method: 'POST', body: JSON.stringify({ text: text.trim(), kind }),
})

export function ClientComplianceReview({ text, onChange }: { text: string; onChange: (value: string) => void }) {
  const [kind, setKind] = useState<'text' | 'image'>('text')
  const [result, setResult] = useState<{ text: string; kind: 'text' | 'image'; value: Review } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function check() {
    setBusy(true); setError(''); setResult(null)
    try {
      const value = await reviewText(text, kind)
      setResult({ text, kind, value })
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="robot-operation" aria-label="合规审查文案">
    <header className="client-panel-heading"><h3>外发文案检查</h3></header>
    <label>待审查文案<textarea aria-label="待审查文案" className="workspace-field" rows={4} maxLength={6000} value={text} disabled={busy}
      onChange={event => onChange(event.target.value)} /></label>
    <div className="robot-operation-actions">
      <label>外发格式<select className="workspace-field" value={kind} disabled={busy} onChange={event => setKind(event.target.value === 'image' ? 'image' : 'text')}>
        <option value="text">文本</option><option value="image">图片</option>
      </select></label>
      <button type="button" className="primary-button workspace-button" disabled={busy || !text.trim()} onClick={() => void check()}>{busy ? '检查中…' : '检查文案'}</button>
    </div>
    {error && <p role="alert" className="workspace-error">{error}</p>}
    {result?.text === text && result.kind === kind && <ReviewResult value={result.value} />}
  </section>
}

export function ClientBroadcastPanel({ robots, text, onTextChange, card, image, onBusy, onSent }: {
  robots: Robot[]; text: string; onTextChange?: (value: string) => void; card?: RebalanceCardContent
  image?: string; onBusy?: (busy: boolean) => void; onSent?: () => void
}) {
  const [kind, setKind] = useState<'text' | 'image'>(card ? 'image' : 'text')
  const [selected, setSelected] = useState<string[]>([])
  const [review, setReview] = useState<Review | null>(null)
  const [confirmation, setConfirmation] = useState<Batch | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'review' | 'send' | null>(null)
  const enabled = robots.filter(robot => robot.enabled)
  const single = robots.length === 1
  const targets = single ? enabled : enabled.filter(robot => selected.includes(robot.id))
  const frozen = !!confirmation || !!busy

  async function prepare() {
    if (frozen || !text.trim() || !targets.length) return
    const body: BroadcastBody = kind === 'image' && card ? { kind: 'image', suggestion: card } : { kind: 'text', content_text: text.trim() }
    setBusy('review'); setError(''); setReceipts([]); setReview(null)
    try {
      const result = await reviewText(text, body.kind)
      setReview(result)
      if (result.passed) setConfirmation({ id: crypto.randomUUID(), targets, body })
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(null) }
  }

  async function send() {
    if (!confirmation || busy) return
    const batch = confirmation
    setBusy('send'); onBusy?.(true)
    const results: Receipt[] = []
    try {
      for (let index = 0; index < batch.targets.length; index += 4) {
        const groupResults = await Promise.all(batch.targets.slice(index, index + 4).map(async (robot) => {
          try {
            const value = await api<Delivery>(endpoint + '/' + encodeURIComponent(robot.id) + '/send', {
              method: 'POST', body: JSON.stringify({ request_id: batch.id + ':' + robot.id, robot_revision: robot.revision, ...batch.body }),
            })
            return { id: robot.id, group: robot.name, state: value.state, message: value.message }
          } catch (reason) {
            const state: Delivery['state'] = reason instanceof ApiRequestError && reason.status < 500 ? 'failed' : 'unknown'
            return { id: robot.id, group: robot.name, state, message: (reason as Error).message }
          }
        }))
        results.push(...groupResults)
        setReceipts([...results])
      }
      onSent?.()
    } finally {
      setConfirmation(null); setBusy(null); onBusy?.(false)
    }
  }

  return <section className="robot-operation" aria-label="待推送内容">
    {!onTextChange && <header className="client-panel-heading"><h3>发送到群</h3></header>}
    {card && <div role="group" aria-label="群发格式" className="robot-operation-actions">
      <button type="button" className="secondary-button workspace-button" aria-pressed={kind === 'image'} disabled={frozen}
        onClick={() => { setKind('image'); setReview(null) }}>卡片图片</button>
      <button type="button" className="secondary-button workspace-button" aria-pressed={kind === 'text'} disabled={frozen}
        onClick={() => { setKind('text'); setReview(null) }}>纯文案</button>
    </div>}
    {onTextChange ? <label>推送文案<textarea aria-label="推送文案" className="workspace-field" rows={4} maxLength={6000} value={text}
      disabled={frozen} onChange={event => { onTextChange(event.target.value); setReview(null) }} /></label>
      : kind === 'image' && image ? <img src={image} alt="待群发调仓卡片" className="robot-broadcast-image" />
        : <pre className="robot-broadcast-text">{text}</pre>}
    <fieldset disabled={frozen} className="robot-broadcast-targets">
      <legend>接收群</legend>
      {!enabled.length ? <p>请先启用接收群的机器人。</p> : single ? <strong>{enabled[0].name}</strong> : enabled.map(robot => <label key={robot.id}>
        <input type="checkbox" checked={selected.includes(robot.id)} onChange={event => {
          setSelected(current => event.target.checked ? [...current, robot.id] : current.filter(id => id !== robot.id))
        }} />{robot.name}
      </label>)}
    </fieldset>
    {review && <ReviewResult value={review} />}
    {error && <p role="alert" className="workspace-error">{error}</p>}
    {confirmation ? <div className="client-send-confirm">
      <p>将把{confirmation.body.kind === 'image' ? '卡片图片' : '文案'}发到 {confirmation.targets.map(robot => robot.name).join('、')}。</p>
      <div className="robot-operation-actions">
        <button type="button" className="secondary-button workspace-button" disabled={!!busy} onClick={() => setConfirmation(null)}>返回编辑</button>
        <button type="button" className="primary-button workspace-button" disabled={!!busy} onClick={() => void send()}>
          {busy === 'send' ? '正在推送…' : `确认发送到 ${single ? confirmation.targets[0].name : confirmation.targets.length + ' 个群'}`}
        </button>
      </div>
    </div> : <button type="button" className="primary-button workspace-button" disabled={!!busy || !text.trim() || !targets.length}
      onClick={() => void prepare()}>{busy === 'review' ? '正在检查…' : '检查并准备推送'}</button>}
    {receipts.length > 0 && <ul aria-label="推送结果" className="robot-operation-list">{receipts.map(item => <li key={item.id}>
      <strong>{item.group}</strong> <span className={`client-delivery-state is-${item.state}`}>{deliveryNames[item.state]}</span><small>{item.message}</small>
    </li>)}</ul>}
  </section>
}
