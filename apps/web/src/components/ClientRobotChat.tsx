import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../api'
import { marketTime } from '../clientService'
import { useWorkspaceSession } from '../WorkspaceSession'
import LoadingState from './LoadingState'

type ChatMessage = { id: string; sender: string; sent_at: string; text: string; topic?: string }
type Chat = {
  state: 'unconfigured' | 'unbound' | 'waiting' | 'ready' | 'error'
  message: string
  room_name?: string
  synced_at?: string | null
  total?: number
  people?: number
  analyzed?: number
  topics?: { label: string; count: number }[]
  highlights?: ChatMessage[]
  needs?: ChatMessage[]
  alerts?: ChatMessage[]
}
const headings = { compliance: '群聊合规线索', summary: '聊天总结', needs: '客户需求' }
const empty = {
  compliance: '近 24 小时未发现需复核的确定性收益表述。',
  summary: '近 24 小时暂无已同步的文字消息。',
  needs: '近 24 小时未提取到明确的客户提问或需求。',
}

export function useClientRobotChat(robotId: string) {
  const { active } = useWorkspaceSession()
  const [chat, setChat] = useState<Chat | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      setChecking(true)
      try {
        const value = await api<Chat>(`/client-service/robots/${encodeURIComponent(robotId)}/chat`, { signal: controller.signal })
        if (!controller.signal.aborted) { setChat(value); setError('') }
      } catch (reason) {
        if (!controller.signal.aborted) setError((reason as Error).message)
      }
      if (!controller.signal.aborted) {
        setChecking(false)
        timer = setTimeout(() => void read(), 20000)
      }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [robotId, active, retry])

  return { chat, error, checking, refresh: () => setRetry(value => value + 1) }
}

export function ClientRobotArchiveStatus({ chat, error, checking, refresh }: ReturnType<typeof useClientRobotChat>) {
  return <div className="client-robot-archive-status">
    <div>
      {(error || chat?.state === 'error') && <p role="alert" className="workspace-error client-service-feedback">{error || chat?.message}</p>}
      {!chat && !error && <LoadingState compact label="正在读取群聊存档…" />}
      {(chat?.state === 'unconfigured' || chat?.state === 'unbound') && <p>{chat.message}</p>}
      {chat?.state === 'waiting' && <p>等待后台首次同步此群的文字消息。</p>}
      {chat?.synced_at && <p>群聊存档 · 最近同步 <time dateTime={chat.synced_at}>{marketTime(chat.synced_at)}</time>（北京时间）</p>}
    </div>
    <button type="button" className="secondary-button workspace-button" disabled={checking}
      onClick={refresh}><RefreshCw size={15} aria-hidden="true" />刷新存档显示</button>
  </div>
}

export default function ClientRobotChat({ chat, view }: { chat: Chat | null; view: keyof typeof headings }) {
  const messages = (view === 'summary' ? chat?.highlights : view === 'needs' ? chat?.needs : chat?.alerts) ?? []
  return <div className="robot-chat-content">
    {!chat?.synced_at ? <p className="client-plan-help">暂无已同步的聊天记录。</p> : <>
      {view === 'summary' && <>
        <dl className="robot-risk-counts robot-chat-counts">
          <div><dt>近 24 小时文字消息</dt><dd>{chat.total}</dd></div>
          <div><dt>发言人数</dt><dd>{chat.people}</dd></div>
        </dl>
        {!!chat.topics?.length && <ul className="robot-chat-topics" aria-label="主要话题">
          {chat.topics.map(topic => <li key={topic.label}>{topic.label} <strong>{topic.count}</strong></li>)}
        </ul>}
      </>}
      {chat.analyzed !== chat.total && <p className="robot-chat-meta">按最近 {chat.analyzed} 条文字消息整理。</p>}
      {!messages.length ? <p className="client-plan-help">{empty[view]}</p>
        : <ul className="robot-operation-list robot-chat-messages" aria-label={view === 'summary' ? '讨论摘录' : headings[view]}>
          {messages.map(item => <li key={item.id}>
            <div><strong>{item.topic || '群聊原文'}</strong><time dateTime={item.sent_at}>{marketTime(item.sent_at)}</time></div>
            <p>{item.text}</p>
            <small>发言人 · {item.sender}</small>
          </li>)}
        </ul>}
    </>}
  </div>
}
