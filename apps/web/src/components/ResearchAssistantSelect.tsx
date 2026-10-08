import { useEffect, useState } from 'react'
import { api, type AssistantSelection, type ResearchAssistant } from '../api'

export default function ResearchAssistantSelect({ value, snapshot, disabled, onChange }: {
  value: string; snapshot?: AssistantSelection; disabled: boolean; onChange: (id: string) => void
}) {
  const [items, setItems] = useState<ResearchAssistant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(false)
    api<{ items: ResearchAssistant[] }>('/research-assistants', { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items)) throw new Error('助手列表暂不可用')
      if (!controller.signal.aborted) setItems(result.items)
    }).catch(() => { if (!controller.signal.aborted) setError(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [retry])
  const selected = items.find(item => item.id === value)
  const changed = snapshot && selected && (selected.skill_hash !== snapshot.skill_hash || selected.revision !== snapshot.revision || selected.name !== snapshot.name || selected.description !== snapshot.description)
  return <div className="research-assistant-control">
    <label><span>研究助手</span><select aria-label="研究助手" title={snapshot?.description || selected?.description} value={value} disabled={disabled || loading || error} onChange={event => onChange(event.target.value)}>
      {!items.some(item => item.id === value) && <option value={value}>{snapshot?.name || (value === 'general' ? '通用投研' : '已选助手')}{!loading && !error && value !== 'general' ? '（已停用）' : ''}</option>}
      {items.map(item => <option key={item.id} value={item.id}>{item.id === value && snapshot ? snapshot.name : item.name}</option>)}
    </select></label>
    {changed && <button type="button" className="text-button assistant-update" disabled={disabled} onClick={() => onChange(value)}>更新版本</button>}
    {error && <button type="button" className="text-button assistant-update" disabled={disabled} onClick={() => setRetry(value => value + 1)}>重试助手列表</button>}
  </div>
}
