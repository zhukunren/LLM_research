import { useEffect, useRef, useState } from 'react'
import { Check, Circle, ChevronDown } from 'lucide-react'
import { api } from '../../api'
import { appendResearchActivity, type ResearchActivity } from './researchProgress'
import './research-progress.css'

export function ActivityList({ items }: { items: ResearchActivity[] }) {
  return <ol className="research-activity-list" aria-label="研究活动记录">{items.map(item => <li key={item.id}>
    {item.done ? <Check size={13} aria-label="已完成" /> : <Circle size={11} aria-label="处理中" />}<div><span>{item.label}</span>{item.text && <p>{item.text}</p>}</div>
  </li>)}</ol>
}

export default function ResearchActivityHistory({ conversationId, turnId }: { conversationId: string; turnId: string }) {
  const [open, setOpen] = useState(false), [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false)
  const [items, setItems] = useState<ResearchActivity[]>([]), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const loadedRef = useRef(false)
  useEffect(() => {
    if (!open || loadedRef.current) return
    const controller = new AbortController()
    setLoading(true); setError('')
    void (async () => {
      let cursor = -1, activities: ResearchActivity[] = []
      while (!controller.signal.aborted) {
        const result = await api<{ items: { method: string; payload: Record<string, unknown>; sequence: number }[]; next_after: number; has_more?: boolean }>(
          `/conversations/${conversationId}/turns/${turnId}/codex-events?after=${cursor}&limit=500`, { signal: controller.signal })
        for (const event of result.items) activities = appendResearchActivity(activities, event)
        if (!result.has_more || result.next_after <= cursor) break
        cursor = result.next_after
      }
      if (!controller.signal.aborted) { setItems(activities); loadedRef.current = true; setLoaded(true) }
    })().catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [open, conversationId, turnId, retry])
  return <details className="research-activity-history" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>查看研究过程<ChevronDown size={14} /></summary>
    {loading && <p role="status">正在读取研究过程…</p>}
    {error && <p role="alert">{error}<button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {loaded && (items.length ? <ActivityList items={items} /> : <p>这次研究没有保留活动记录。</p>)}
  </details>
}
