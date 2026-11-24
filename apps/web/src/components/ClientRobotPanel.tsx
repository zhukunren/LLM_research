import { useEffect, useRef, useState } from 'react'
import { Bot, Check, Edit3, History, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../api'
import type { ServiceCard } from '../clientService'
import { marketTime } from '../clientService'
import { useRemoteResource } from '../useRemoteResource'
import { isText, useSessionState } from '../useSessionState'
import { ClientBroadcastPanel, ClientComplianceReview, ClientRobotRiskMonitor } from './ClientRobotOperations'
import ClientRobotChat, { ClientRobotArchiveStatus, useClientRobotChat } from './ClientRobotChat'
import ConditionWorkspaceDrawer from './ConditionWorkspaceDrawer'
import LoadingState from './LoadingState'

type Robot = { id: string; name: string; enabled: boolean; revision: number; webhook_hint: string; archive_room_id?: string | null }
type RobotCatalog = { items: Robot[]; archive_rooms?: { id: string; name: string }[] }
type Delivery = { id: string; robot_name: string; kind: 'test' | 'text' | 'image'; state: 'sending' | 'sent' | 'failed' | 'unknown'; message: string; created_at: string }
const deliveryLabels = { sending: '发送中', sent: '已接收', failed: '发送失败', unknown: '结果未确认' }
const isDeliveryRequests = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(id => typeof id === 'string')
const endpoint = '/client-service/robots'

export default function ClientRobotPanel({ historyOnly = false }: { historyOnly?: boolean }) {
  return historyOnly ? <ClientDeliveryHistory /> : <ClientRobotWorkspace />
}

function ClientDeliveryHistory() {
  const history = useRemoteResource<{ items: Delivery[] }>(endpoint + '/deliveries')
  const items = history.data?.items ?? []
  return <section className="client-management-panel client-deliveries" aria-label="最近发送记录">
    <header className="client-panel-heading"><h2>最近发送记录</h2><button type="button" className="secondary-button workspace-button"
      disabled={history.loading} onClick={history.retry}><RefreshCw size={15} aria-hidden="true" />刷新记录</button></header>
    {history.error ? <p role="alert" className="workspace-error client-service-feedback">{history.error}</p>
      : history.loading ? <LoadingState compact label="正在读取发送记录…" />
      : !items.length ? <div className="client-management-empty"><History size={24} aria-hidden="true" /><p>暂无发送记录</p></div>
      : <ul className="client-delivery-list">{items.map(item => <li key={item.id}>
        <div><strong>{item.robot_name}</strong><span className={`client-delivery-state is-${item.state}`}>{deliveryLabels[item.state]}</span></div>
        <p>{item.kind === 'test' ? '连接测试' : item.kind === 'image' ? '图片简报' : '文字简报'} · <time dateTime={item.created_at}>{marketTime(item.created_at)}</time></p>
        <small>{item.message}</small>
      </li>)}</ul>}
  </section>
}

function ClientRobotWorkspace() {
  const catalog = useRemoteResource<RobotCatalog>(endpoint)
  const robots = catalog.data?.items ?? []
  const rooms = catalog.data?.archive_rooms ?? []
  const [selected, setSelected] = useSessionState('client-service.robot.selected', '', isText)
  const robot = robots.find(item => item.id === selected) || robots[0]
  const [editing, setEditing] = useState<Robot | 'new' | null>(null)
  const [name, setName] = useState(''), [webhook, setWebhook] = useState(''), [enabled, setEnabled] = useState(true)
  const [room, setRoom] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<{ robot: Robot; kind: 'test' | 'archive'; requestId: string } | null>(null)
  const archiveRoom = rooms.find(item => item.id === robot?.archive_room_id)

  function edit(value: Robot | 'new') {
    setEditing(value)
    setName(value === 'new' ? '' : value.name)
    setWebhook('')
    setEnabled(value === 'new' || value.enabled)
    setRoom(value === 'new' ? '' : value.archive_room_id || '')
    setConfirm(null)
    setNotice('')
    setError('')
  }
  async function save() {
    if (!editing) return
    setBusy(true); setError(''); setNotice('')
    try {
      const saved = await api<Robot>(endpoint + (editing === 'new' ? '' : '/' + editing.id), {
        method: editing === 'new' ? 'POST' : 'PUT',
        body: JSON.stringify({ name: name.trim(), webhook: webhook.trim() || null, enabled,
          archive_room_id: room || null, revision: editing === 'new' ? 0 : editing.revision }),
      })
      setSelected(saved.id)
      setEditing(null); setWebhook(''); setNotice('机器人配置已保存'); catalog.retry()
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  async function execute() {
    if (!confirm) return
    const action = confirm
    setBusy(true); setError(''); setNotice('')
    try {
      if (action.kind === 'archive') {
        await api(`${endpoint}/${action.robot.id}/archive`, { method: 'POST', body: JSON.stringify({ revision: action.robot.revision }) })
        setNotice('机器人已移除，历史发送记录保留')
        setSelected('')
        catalog.retry()
      } else {
        const result = await api<Delivery>(`${endpoint}/${action.robot.id}/send`, {
          method: 'POST', body: JSON.stringify({ request_id: action.requestId, robot_revision: action.robot.revision, kind: 'test' }),
        })
        if (result.state === 'sent') setNotice(`已发送到「${action.robot.name}」：${result.message}`)
        else setError(result.message)
      }
      setConfirm(null)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  function ask(robot: Robot, kind: 'test' | 'archive') { setConfirm({ robot, kind, requestId: crypto.randomUUID() }); setEditing(null); setWebhook(''); setError(''); setNotice('') }
  return <div className="client-robots">
    <aside className="client-management-panel client-robot-directory" aria-label="企业微信群">
      <header className="client-panel-heading">
        <h2>企业微信群</h2>
        <button type="button" className="secondary-button workspace-button" disabled={busy || catalog.loading}
          onClick={() => edit('new')}><Plus size={15} aria-hidden="true" />新增机器人</button>
      </header>
      {catalog.error && <div role="alert" className="workspace-error client-service-feedback">
        <span>{catalog.error}</span><button type="button" className="text-button workspace-button" onClick={catalog.retry}>重新读取</button>
      </div>}
      {catalog.loading && <LoadingState compact label="正在读取机器人…" />}
      {!!robots.length && <nav className="client-robot-groups" aria-label="群机器人列表">
        {robots.map(item => <button key={item.id} type="button" className="workspace-button" aria-current={item.id === robot?.id ? 'true' : undefined}
          aria-label={item.name} disabled={busy} onClick={() => {
            setSelected(item.id)
            setEditing(null); setWebhook(''); setConfirm(null); setError(''); setNotice('')
          }}>
          <Bot size={18} aria-hidden="true" /><span><strong>{item.name}</strong><small>{item.enabled ? '推送已启用' : '推送已停用'}</small></span>
        </button>)}
      </nav>}
    </aside>
    <div className="client-robot-detail">
      <section className="client-management-panel client-robot-context" aria-label="机器人配置">
        <header className="client-panel-heading client-robot-toolbar">
          <h2>{editing === 'new' ? '新增群机器人' : robot?.name || '群机器人配置'}</h2>
          {robot && editing !== 'new' && <div className="client-robot-actions">
            <button type="button" className="secondary-button workspace-button" aria-label={`编辑${robot.name}`} disabled={busy}
              onClick={() => edit(robot)}><Edit3 size={15} aria-hidden="true" />编辑</button>
            <button type="button" className="secondary-button workspace-button" disabled={busy || !robot.enabled}
              onClick={() => ask(robot, 'test')}>发送测试消息</button>
            <button type="button" className="text-button workspace-button" aria-label={`移除${robot.name}`} disabled={busy}
              onClick={() => ask(robot, 'archive')}><Trash2 size={16} aria-hidden="true" /></button>
          </div>}
        </header>
        {error && <p role="alert" className="workspace-error client-service-feedback">{error}</p>}
        {notice && <p role="status" className="workspace-feedback-success client-service-feedback"><Check size={15} />{notice}</p>}
        {robot && editing !== 'new' && <p className="client-robot-context-meta">{archiveRoom ? `存档群聊 · ${archiveRoom.name}` : '尚未绑定存档群聊'}</p>}
        {editing && <form className="client-robot-form" onSubmit={event => { event.preventDefault(); void save() }}>
          {editing !== 'new' && <h3>编辑群机器人</h3>}
          <label>群名称<input className="workspace-field" aria-label="群名称" value={name} maxLength={40} onChange={event => setName(event.target.value)} placeholder="例如：锦绣成长客户服务群" disabled={busy} required /></label>
          <label>Webhook 地址<input className="workspace-field" aria-label="Webhook 地址" type="password" autoComplete="new-password"
            value={webhook} onChange={event => setWebhook(event.target.value)} placeholder={editing === 'new' ? '粘贴企业微信群机器人的 Webhook 地址' : '留空保留原地址，填写可更换'} disabled={busy} required={editing === 'new'} /></label>
          <small>在该群的机器人设置中复制 Webhook 地址。</small>
          {(rooms.length > 0 || room) && <label>存档群聊
            <select className="workspace-field" value={room} disabled={busy} onChange={event => setRoom(event.target.value)}>
              <option value="">暂不绑定</option>
              {room && !rooms.some(item => item.id === room) && <option value={room}>原存档群聊（当前不可用）</option>}
              {rooms.filter(item => item.id === room || !robots.some(group => group.archive_room_id === item.id))
                .map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>}
          <label className="client-robot-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} />启用信息推送</label>
          <div className="client-robot-actions">
            <button type="button" className="secondary-button workspace-button" disabled={busy} onClick={() => { setEditing(null); setWebhook('') }}>取消编辑</button>
            <button className="primary-button workspace-button" type="submit" disabled={busy || !name.trim() || (editing === 'new' && !webhook.trim())}>{busy ? '正在保存…' : '保存机器人'}</button>
          </div>
        </form>}
        {catalog.data && !robot && !editing && <div className="client-management-empty"><Bot size={24} aria-hidden="true" /><h3>尚未配置群机器人</h3><p>为需要服务的群添加各自的机器人。</p></div>}
        {confirm && <section className="client-send-confirm" aria-label="确认机器人操作">
          <h3>{confirm.kind === 'archive' ? '移除机器人' : `发送至「${confirm.robot.name}」`}</h3>
          <p>{confirm.kind === 'archive' ? `移除「${confirm.robot.name}」的配置，保留发送记录。` : '将向此机器人所在群发送一条连接测试消息。'}</p>
          <div className="client-robot-actions">
            <button type="button" className="secondary-button workspace-button" disabled={busy} onClick={() => setConfirm(null)}>取消操作</button>
            <button type="button" className="primary-button workspace-button" disabled={busy} onClick={() => void execute()}>{busy ? '正在处理…' : confirm.kind === 'archive' ? '确认移除' : `确认发送到 ${confirm.robot.name}`}</button>
          </div>
        </section>}
      </section>
      {robot && editing !== 'new' && <ClientRobotWorkflows key={robot.id} robot={robot} onBusy={setBusy} />}
    </div>
  </div>
}

function ClientRobotWorkflows({ robot, onBusy }: { robot: Robot; onBusy: (busy: boolean) => void }) {
  const [text, setText] = useSessionState(`client-service.robot.message.${robot.id}`, '', isText)
  const [previousDraft] = useSessionState('client-service.robot-broadcast.text', '', isText)
  const archive = useClientRobotChat(robot.id)
  return <>
    <ClientRobotArchiveStatus {...archive} />
    <div className="client-management-grid client-robot-features">
      <section className="client-management-panel client-robot-feature" aria-label="合规监控">
        <header className="client-panel-heading"><h2>合规监控</h2></header>
        <ClientRobotChat chat={archive.chat} view="compliance" />
        <details className="client-robot-tools">
          <summary>检查外发文案</summary>
          <ClientComplianceReview text={text} onChange={setText} />
        </details>
      </section>
      <section className="client-management-panel client-robot-feature" aria-label="信息推送">
        <header className="client-panel-heading"><h2>信息推送</h2></header>
        {previousDraft && !text && <button type="button" className="text-button workspace-button"
          onClick={() => setText(previousDraft)}>载入之前的群发草稿</button>}
        <ClientBroadcastPanel robots={[robot]} text={text} onTextChange={setText} onBusy={onBusy} />
        <details className="client-robot-tools">
          <summary>查看推送状态</summary>
          <ClientRobotRiskMonitor robotId={robot.id} />
        </details>
      </section>
      <section className="client-management-panel client-robot-feature" aria-label="聊天总结">
        <header className="client-panel-heading"><h2>聊天总结</h2></header>
        <ClientRobotChat chat={archive.chat} view="summary" />
      </section>
      <section className="client-management-panel client-robot-feature" aria-label="客户需求">
        <header className="client-panel-heading"><h2>客户需求</h2></header>
        <ClientRobotChat chat={archive.chat} view="needs" />
      </section>
    </div>
  </>
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
