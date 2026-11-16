import { useEffect, useState } from 'react'
import { Bot, Check, Edit3, Plus, Send, Trash2 } from 'lucide-react'
import { api } from '../api'
import type { ServiceCard } from '../clientService'
import { marketTime } from '../clientService'

type Robot = { id: string; name: string; enabled: boolean; revision: number; webhook_hint: string }
type Delivery = { id: string; robot_name: string; kind: 'test' | 'text' | 'image'; state: 'sending' | 'sent' | 'failed' | 'unknown'; message: string; created_at: string }
const deliveryLabels = { sending: '发送中', sent: '已接收', failed: '发送失败', unknown: '结果未确认' }

export default function ClientRobotPanel({ card, canSend, preview }: { card?: ServiceCard; canSend: boolean; preview?: string }) {
  const [robots, setRobots] = useState<Robot[]>([])
  const [history, setHistory] = useState<Delivery[]>([])
  const [loaded, setLoaded] = useState(false)
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState<Robot | 'new' | null>(null)
  const [name, setName] = useState(''), [webhook, setWebhook] = useState(''), [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<{ robot: Robot; kind: 'test' | 'text' | 'image' | 'archive'; requestId: string } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoaded(false)
    Promise.all([api<{ items: Robot[] }>('/client-service/robots', { signal: controller.signal }), api<{ items: Delivery[] }>('/client-service/robots/deliveries', { signal: controller.signal })])
      .then(([list, records]) => { if (!controller.signal.aborted) { setRobots(list.items); setHistory(records.items); setLoaded(true) } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [reload])
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
        const result = await api<Delivery>(`/client-service/robots/${action.robot.id}/send`, { method: 'POST', body: JSON.stringify({ request_id: action.requestId, kind: action.kind, ...(action.kind !== 'test' && card ? { card_id: card.id, revision: card.revision } : {}) }) })
        if (result.state === 'sent') setNotice(`已发送到「${action.robot.name}」：${result.message}`)
        else setError(result.message)
      }
      setConfirm(null); setReload(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  function ask(robot: Robot, kind: 'test' | 'text' | 'image' | 'archive') { setConfirm({ robot, kind, requestId: crypto.randomUUID() }); setEditing(null); setWebhook(''); setError(''); setNotice('') }
  return <div className="client-robots">
    <div className="client-robot-intro"><Bot size={24} /><div><h3>让简报抵达客户群</h3><p>添加企业微信群机器人，核对卡片后发送。Webhook 只保存在服务端，不在页面回显。</p></div></div>
    {error && <div role="alert" className="workspace-error client-service-feedback"><span>{error}</span><button className="text-button workspace-button" disabled={busy} onClick={() => { setError(''); setReload(value => value + 1) }}>重新读取</button></div>}
    {notice && <p role="status" className="workspace-feedback-success client-service-feedback"><Check size={15} />{notice}</p>}
    <div className="client-robot-toolbar"><h3>群机器人 <small>{robots.length}</small></h3><button className="primary-button workspace-button" disabled={busy} onClick={() => edit('new')}><Plus size={15} />新增机器人</button></div>
    {editing && <form className="client-robot-form" onSubmit={event => { event.preventDefault(); void save() }}><h4>{editing === 'new' ? '新增群机器人' : '编辑群机器人'}</h4><label>机器人名称<input className="workspace-field" aria-label="机器人名称" value={name} maxLength={40} onChange={event => setName(event.target.value)} placeholder="例如：锦绣成长客户服务群" disabled={busy} required /></label><label>Webhook 地址<input className="workspace-field" aria-label="Webhook 地址" type="password" autoComplete="new-password" value={webhook} onChange={event => setWebhook(event.target.value)} placeholder={editing === 'new' ? '粘贴企业微信群机器人的 Webhook 地址' : '留空保留原地址；填写可更换'} disabled={busy} required={editing === 'new'} /></label><small>在企业微信目标群中添加机器人，复制其 Webhook 地址。</small><label className="client-robot-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} />启用机器人</label><div className="client-robot-actions"><button type="button" className="secondary-button workspace-button" disabled={busy} onClick={() => { setEditing(null); setWebhook('') }}>取消编辑</button><button className="primary-button workspace-button" type="submit" disabled={busy || !name.trim() || (editing === 'new' && !webhook.trim())}>{busy ? '正在保存…' : '保存机器人'}</button></div></form>}
    {!loaded && !error && <p className="client-empty">正在读取机器人…</p>}
    {loaded && !robots.length && !editing && <div className="client-robot-empty"><Bot size={34} /><h4>尚未配置群机器人</h4><p>先添加一个机器人，再发送测试消息确认目标群。</p></div>}
    <div className="client-robot-list">{robots.map(robot => <article key={robot.id}><div className="client-robot-row"><span className="client-robot-avatar"><Bot size={20} /></span><div><h4>{robot.name}<small className={robot.enabled ? 'is-ready' : ''}>{robot.enabled ? '已启用' : '已停用'}</small></h4><p>{robot.webhook_hint}</p></div><button className="text-button workspace-button" aria-label={`编辑${robot.name}`} disabled={busy} onClick={() => edit(robot)}><Edit3 size={15} /></button><button className="text-button workspace-button" aria-label={`移除${robot.name}`} disabled={busy} onClick={() => ask(robot, 'archive')}><Trash2 size={15} /></button></div><div className="client-robot-actions"><button className="secondary-button workspace-button" disabled={busy || !robot.enabled} onClick={() => ask(robot, 'test')}>发送测试消息</button><button className="secondary-button workspace-button" disabled={busy || !robot.enabled || !canSend} onClick={() => ask(robot, 'text')}>发送文案</button><button className="primary-button workspace-button" disabled={busy || !robot.enabled || !canSend} onClick={() => ask(robot, 'image')}><Send size={13} />发送图片</button></div></article>)}</div>
    {!canSend && <p className="client-plan-help">发送卡片前，请完成市场采集、核对内容，并保存本次修改。</p>}
    {confirm && <section className="client-send-confirm" aria-label="确认机器人操作"><h4>{confirm.kind === 'archive' ? '移除机器人' : `发送至「${confirm.robot.name}」`}</h4><p>{confirm.kind === 'archive' ? `移除「${confirm.robot.name}」的配置，保留发送记录。` : confirm.kind === 'test' ? '将向此机器人所在群发送一条连接测试消息。' : `将发送已保存的${confirm.kind === 'image' ? '图片' : '文案'}：${card?.content.headline || card?.template.title} · ${card?.service_date} ${card?.template.time}`}</p>{confirm.kind === 'image' && preview && <img src={preview} alt="待发送卡片" />}<div className="client-robot-actions"><button className="secondary-button workspace-button" disabled={busy} onClick={() => setConfirm(null)}>取消操作</button><button className="primary-button workspace-button" disabled={busy || (!['test', 'archive'].includes(confirm.kind) && !canSend)} onClick={() => void execute()}>{busy ? '正在处理…' : confirm.kind === 'archive' ? '确认移除' : `确认发送到 ${confirm.robot.name}`}</button></div></section>}
    <section className="client-deliveries"><header><h3>最近发送记录</h3><button className="text-button workspace-button" disabled={busy} onClick={() => setReload(value => value + 1)}>刷新记录</button></header>{!history.length ? <p className="client-plan-help">暂无发送记录</p> : history.map(item => <article key={item.id}><div><strong>{item.robot_name}</strong><span className={`client-delivery-state is-${item.state}`}>{deliveryLabels[item.state]}</span></div><p>{item.kind === 'test' ? '连接测试' : item.kind === 'image' ? '图片简报' : '文字简报'} · {marketTime(item.created_at)}</p><small>{item.message}</small></article>)}</section>
  </div>
}
