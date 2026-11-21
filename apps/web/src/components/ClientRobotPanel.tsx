import { useEffect, useRef, useState } from 'react'
import { Bot, Check, Edit3, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { api } from '../api'
import type { ServiceCard } from '../clientService'
import { marketTime } from '../clientService'
import { useRemoteResource } from '../useRemoteResource'
import { isText, useSessionState } from '../useSessionState'
import { ClientBroadcastPanel, ClientComplianceReview, ClientRobotRiskMonitor } from './ClientRobotOperations'
import ConditionWorkspaceDrawer from './ConditionWorkspaceDrawer'
import LoadingState from './LoadingState'

type Robot = { id: string; name: string; enabled: boolean; revision: number; webhook_hint: string }
type Delivery = { id: string; robot_name: string; kind: 'test' | 'text' | 'image'; state: 'sending' | 'sent' | 'failed' | 'unknown'; message: string; created_at: string }
const deliveryLabels = { sending: '发送中', sent: '已接收', failed: '发送失败', unknown: '结果未确认' }
const isDeliveryRequests = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(id => typeof id === 'string')
const sections = [['settings', '机器人配置'], ['risk', '风险监控'], ['review', '合规审查'], ['broadcast', '内容群发']] as const

export default function ClientRobotPanel({ historyOnly = false }: { historyOnly?: boolean }) {
  const [robots, setRobots] = useState<Robot[]>([])
  const [history, setHistory] = useState<Delivery[]>([])
  const [loaded, setLoaded] = useState(false)
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState<Robot | 'new' | null>(null)
  const [name, setName] = useState(''), [webhook, setWebhook] = useState(''), [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<{ robot: Robot; kind: 'test' | 'archive'; requestId: string } | null>(null)
  const [section, setSection] = useState<typeof sections[number][0]>('settings')
  const [text, setText] = useSessionState('client-service.robot-broadcast.text', '', isText)
  useEffect(() => {
    const controller = new AbortController()
    setLoaded(false)
    Promise.all([historyOnly ? Promise.resolve({ items: [] as Robot[] }) : api<{ items: Robot[] }>('/client-service/robots', { signal: controller.signal }), api<{ items: Delivery[] }>('/client-service/robots/deliveries', { signal: controller.signal })])
      .then(([list, records]) => { if (!controller.signal.aborted) { setRobots(list.items); setHistory(records.items); setLoaded(true) } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [reload, historyOnly])
  function edit(robot: Robot | 'new') {
    setEditing(robot); setName(robot === 'new' ? '' : robot.name); setWebhook(''); setEnabled(robot === 'new' || robot.enabled); setConfirm(null); setNotice(''); setError('')
  }
  async function save() {
    if (!editing) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api('/client-service/robots' + (editing === 'new' ? '' : '/' + editing.id), {
        method: editing === 'new' ? 'POST' : 'PUT', body: JSON.stringify({ name: name.trim(), webhook: webhook.trim() || null, enabled, revision: editing === 'new' ? 0 : editing.revision }),
      })
      setEditing(null); setWebhook(''); setNotice('机器人配置已保存'); setReload(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  async function execute() {
    if (!confirm) return
    const action = confirm
    setBusy(true); setError(''); setNotice('')
    try {
      if (action.kind === 'archive') {
        await api(`/client-service/robots/${action.robot.id}/archive`, { method: 'POST', body: JSON.stringify({ revision: action.robot.revision }) })
        setNotice('机器人已移除，历史发送记录保留')
      } else {
        const result = await api<Delivery>(`/client-service/robots/${action.robot.id}/send`, { method: 'POST', body: JSON.stringify({ request_id: action.requestId, kind: 'test' }) })
        if (result.state === 'sent') setNotice(`已发送到「${action.robot.name}」：${result.message}`)
        else setError(result.message)
      }
      setConfirm(null); setReload(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  function ask(robot: Robot, kind: 'test' | 'archive') { setConfirm({ robot, kind, requestId: crypto.randomUUID() }); setEditing(null); setWebhook(''); setError(''); setNotice('') }
  return <div className="client-robots">
    {!historyOnly && <nav className="client-robot-function-tabs" aria-label="群机器人功能">
      {sections.map(([id, label]) => <button type="button" key={id} className="secondary-button workspace-button"
        aria-pressed={section === id} disabled={busy} onClick={() => setSection(id)}>{label}</button>)}
    </nav>}
    {!historyOnly && section === 'risk' && <ClientRobotRiskMonitor />}
    {!historyOnly && section === 'review' && <ClientComplianceReview text={text} onChange={setText} />}
    {!historyOnly && section === 'broadcast' && <>
      {error && <p role="alert" className="workspace-error">{error}</p>}
      <ClientBroadcastPanel robots={robots} text={text} onTextChange={setText}
        onBusy={setBusy} onSent={() => setReload(value => value + 1)} />
    </>}
    {historyOnly && error && <p role="alert" className="workspace-error">{error}</p>}
    {(historyOnly || section === 'settings') && <div className={historyOnly ? undefined : 'client-robot-configuration'}>
      {!historyOnly && <section aria-label="机器人配置">
        <header className="client-robot-toolbar">
          <h2>企业微信群机器人 <small>{robots.length}</small></h2>
          <button type="button" className="primary-button workspace-button" disabled={busy} onClick={() => edit('new')}><Plus size={15} />新增机器人</button>
        </header>
        {error && <div role="alert" className="workspace-error client-service-feedback">
          <span>{error}</span><button className="text-button workspace-button" disabled={busy} onClick={() => { setError(''); setReload(value => value + 1) }}>重新读取</button>
        </div>}
        {notice && <p role="status" className="workspace-feedback-success client-service-feedback"><Check size={15} />{notice}</p>}
        {editing && <form className="client-robot-form" onSubmit={event => { event.preventDefault(); void save() }}>
          <h3>{editing === 'new' ? '新增群机器人' : '编辑群机器人'}</h3>
          <label>机器人名称<input className="workspace-field" aria-label="机器人名称" value={name} maxLength={40} onChange={event => setName(event.target.value)} placeholder="例如：锦绣成长客户服务群" disabled={busy} required /></label>
          <label>Webhook 地址<input className="workspace-field" aria-label="Webhook 地址" type="password" autoComplete="new-password"
            value={webhook} onChange={event => setWebhook(event.target.value)} placeholder={editing === 'new' ? '粘贴企业微信群机器人的 Webhook 地址' : '留空保留原地址，填写可更换'} disabled={busy} required={editing === 'new'} /></label>
          <small>在企业微信目标群中添加机器人，复制其 Webhook 地址。</small>
          <label className="client-robot-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} />启用机器人</label>
          <div className="client-robot-actions">
            <button type="button" className="secondary-button workspace-button" disabled={busy} onClick={() => { setEditing(null); setWebhook('') }}>取消编辑</button>
            <button className="primary-button workspace-button" type="submit" disabled={busy || !name.trim() || (editing === 'new' && !webhook.trim())}>{busy ? '正在保存…' : '保存机器人'}</button>
          </div>
        </form>}
        {!loaded && !error && <p className="client-empty">正在读取机器人…</p>}
        {loaded && !robots.length && !editing && <div className="client-robot-empty"><Bot size={34} /><h3>尚未配置群机器人</h3><p>先添加一个机器人，再发送测试消息确认目标群。</p></div>}
        <div className="client-robot-list">{robots.map(robot => <article key={robot.id}>
          <div className="client-robot-row">
            <span className="client-robot-avatar"><Bot size={20} /></span>
            <div><h3>{robot.name}<small className={robot.enabled ? 'is-ready' : ''}>{robot.enabled ? '已启用' : '已停用'}</small></h3><p>{robot.webhook_hint}</p></div>
            <button className="text-button workspace-button" aria-label={`编辑${robot.name}`} disabled={busy} onClick={() => edit(robot)}><Edit3 size={15} /></button>
            <button className="text-button workspace-button" aria-label={`移除${robot.name}`} disabled={busy} onClick={() => ask(robot, 'archive')}><Trash2 size={15} /></button>
          </div>
          <div className="client-robot-actions"><button className="secondary-button workspace-button" disabled={busy || !robot.enabled} onClick={() => ask(robot, 'test')}>发送测试消息</button></div>
        </article>)}</div>
        {confirm && <section className="client-send-confirm" aria-label="确认机器人操作">
          <h3>{confirm.kind === 'archive' ? '移除机器人' : `发送至「${confirm.robot.name}」`}</h3>
          <p>{confirm.kind === 'archive' ? `移除「${confirm.robot.name}」的配置，保留发送记录。` : '将向此机器人所在群发送一条连接测试消息。'}</p>
          <div className="client-robot-actions">
            <button type="button" className="secondary-button workspace-button" disabled={busy} onClick={() => setConfirm(null)}>取消操作</button>
            <button type="button" className="primary-button workspace-button" disabled={busy} onClick={() => void execute()}>{busy ? '正在处理…' : confirm.kind === 'archive' ? '确认移除' : `确认发送到 ${confirm.robot.name}`}</button>
          </div>
        </section>}
      </section>}
      <section className="client-deliveries" aria-label="最近发送记录">
        <header><h2>最近发送记录</h2><button className="text-button workspace-button" disabled={busy} onClick={() => setReload(value => value + 1)}>刷新记录</button></header>
        {!loaded && !error ? <p className="client-plan-help">正在读取发送记录…</p> : !history.length && !error ? <p className="client-plan-help">暂无发送记录</p> : history.map(item => <article key={item.id}>
          <div><strong>{item.robot_name}</strong><span className={`client-delivery-state is-${item.state}`}>{deliveryLabels[item.state]}</span></div>
          <p>{item.kind === 'test' ? '连接测试' : item.kind === 'image' ? '图片简报' : '文字简报'} · {marketTime(item.created_at)}</p><small>{item.message}</small>
        </article>)}
      </section>
    </div>}
  </div>
}

export function ClientCardSendDialog({ card, kind, preview, canSend, onClose, onManage }: {
  card: ServiceCard; kind: 'text' | 'image'; preview: string; canSend: boolean; onClose: () => void; onManage: () => void
}) {
  const groups = useRemoteResource<{ items: Robot[] }>('/client-service/robots')
  const [groupId, setGroupId] = useState('')
  const [sending, setSending] = useState(false)
  const sendingLock = useRef(false)
  const doneButton = useRef<HTMLButtonElement>(null)
  const [result, setResult] = useState<Delivery | null>(null)
  const [error, setError] = useState('')
  const [requests, setRequests] = useSessionState<Record<string, string>>('client-service.deliveryRequests', {}, isDeliveryRequests)
  const enabledGroups = groups.data?.items.filter(group => group.enabled) ?? []
  const selected = enabledGroups.find(group => group.id === groupId)
  const title = card.content.headline || card.template.title
  const checking = result?.state === 'sending'
  const finished = !!result && !checking
  useEffect(() => {
    if (finished) doneButton.current?.focus()
  }, [finished])

  function groupName(group: Robot) {
    return enabledGroups.filter(item => item.name === group.name).length > 1 ? `${group.name}（${group.webhook_hint}）` : group.name
  }

  async function confirmSend() {
    if (!selected || !canSend || sendingLock.current || finished) return
    const key = JSON.stringify([card.id, card.revision, kind, selected.id])
    const requestId = requests[key] ?? crypto.randomUUID()
    sendingLock.current = true
    setSending(true)
    setError('')
    setRequests(current => ({ ...current, [key]: requestId }))
    try {
      const delivery = await api<Delivery>(`/client-service/robots/${encodeURIComponent(selected.id)}/send`, {
        method: 'POST',
        body: JSON.stringify({ request_id: requestId, kind, card_id: card.id, revision: card.revision }),
      })
      setResult(delivery)
      if (delivery.state !== 'sending') setRequests(current => {
        const next = { ...current }
        delete next[key]
        return next
      })
    } catch (reason) { setError((reason as Error).message) }
    finally { sendingLock.current = false; setSending(false) }
  }

  const actionLabel = selected ? `确认发送到 ${groupName(selected)}` : '确认发送'
  return <ConditionWorkspaceDrawer
    title="发送到群"
    description={`${title} · ${card.service_date} ${card.template.time}（北京时间） · ${kind === 'image' ? '图片' : '文案'}`}
    closeLabel="关闭发送到群"
    className="client-service-drawer client-send-drawer"
    closeDisabled={sending}
    onClose={onClose}
    footer={<div className="client-robot-actions">
      <button ref={doneButton} type="button" className="secondary-button workspace-button" disabled={sending} onClick={onClose}>{finished ? '完成' : '取消'}</button>
      {!finished && <button type="button" className="primary-button workspace-button" disabled={!selected || !canSend || sending} onClick={() => void confirmSend()}>
        {sending ? <><LoaderCircle size={15} className="spin" aria-hidden="true" />正在发送…</> : checking ? '查询发送结果' : actionLabel}
      </button>}
    </div>}
  >
    <div className="client-send-content">
      {groups.loading ? <LoadingState compact label="正在读取群机器人…" />
        : groups.error ? <div role="alert" className="workspace-error client-service-feedback"><span>{groups.error}</span><button type="button" className="text-button workspace-button" onClick={groups.retry}>重试读取群机器人</button></div>
          : enabledGroups.length === 0 ? <div className="client-send-empty"><p>当前没有已启用的群机器人。</p><button type="button" className="secondary-button workspace-button" onClick={onManage}>前往群机器人</button></div>
            : <label className="workspace-field-label">选择目标群
              <select className="workspace-field" value={groupId} disabled={sending || !!result} onChange={event => { setGroupId(event.target.value); setError('') }}>
                <option value="" disabled>请选择企业微信群</option>
                {enabledGroups.map(group => <option key={group.id} value={group.id}>{groupName(group)}</option>)}
              </select>
            </label>}
      {!canSend && !finished && <p className="client-plan-help" role="status">卡片已有变化，请关闭并重新核对成品。</p>}
      {error && <p role="alert" className="workspace-error client-service-feedback">{error}</p>}
      {result && <p role={result.state === 'failed' ? 'alert' : 'status'} className={`client-service-feedback ${result.state === 'sent' ? 'workspace-feedback-success' : 'workspace-feedback'}`}>
        {result.state === 'sent' && <Check size={15} aria-hidden="true" />}
        {result.state === 'sent' ? `已发送到「${selected?.name || result.robot_name}」 · ${result.message}` : result.message}
      </p>}
      {kind === 'image' && <figure className="client-send-card"><img src={preview} alt="待发送卡片" /></figure>}
    </div>
  </ConditionWorkspaceDrawer>
}
