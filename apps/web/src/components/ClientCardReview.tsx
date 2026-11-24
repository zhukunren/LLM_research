import { useEffect, useState } from 'react'
import { Eye, RefreshCw } from 'lucide-react'
import { api } from '../api'
import type { ServiceCard } from '../clientService'
import type { ModelMode } from '../modelSelection'
import ModelModeSwitch from './ModelModeSwitch'

const focusOptions = [
  { id: 'metrics', label: '指标区' },
  { id: 'disclosure', label: '风险提示与落款' },
  { id: 'legibility', label: '小字与可读性' },
] as const
type ReviewFocus = typeof focusOptions[number]['id']
type Review = {
  id: string; card_revision: number; image_hash: string; state: string; message: string; review_focus?: ReviewFocus[]
  result: { verdict: string; summary: string; issues: { area: string; severity: string; message: string; suggestion: string }[] } | null
}
const pendingStates = ['preparing', 'queued', 'running']

export default function ClientCardReview({ card, dirty, imageHash }: { card?: ServiceCard; dirty: boolean; imageHash?: string }) {
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0)
  const [modelMode, setModelMode] = useState<ModelMode>('instant')
  const [focus, setFocus] = useState<ReviewFocus[]>([])
  const cardId = card?.id

  useEffect(() => { setFocus([]) }, [cardId])
  useEffect(() => {
    setReview(null)
    if (!cardId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      try {
        const { review } = await api<{ review: Review | null }>(`/client-service/cards/${cardId}/review`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setReview(review)
        if (review && pendingStates.includes(review.state)) timer = setTimeout(load, 4000)
      } catch { /* A read failure still allows editing and downloading. */ }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [cardId, card?.revision, imageHash, reload])

  const pending = !!review && pendingStates.includes(review.state)
  const current = !!review && review.card_revision === card?.revision && review.image_hash === imageHash && !dirty
  const canStart = !!card && card.state === 'ready' && !busy && !pending && !dirty && !!imageHash
  const submitted = focusOptions.filter(option => review?.review_focus?.includes(option.id)).map(option => option.label)

  async function start() {
    if (!card || !canStart) return
    setBusy(true); setError('')
    try {
      const value = await api<Review>(`/client-service/cards/${card.id}/review`, {
        method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID(), expected_revision: card.revision,
          model_mode: modelMode, review_focus: focus.length ? focus : undefined }),
      })
      setReview(value)
      setFocus([])
      setReload(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }

  return <details className="client-review-panel">
    <summary><Eye size={14} />成品视觉复核<span>{pending ? '复核中' : review && !current ? '图片已变化' : current && review?.state === 'complete' ? (review.result?.verdict === 'passed' ? '已通过' : '需调整') : '检查图片密度与排版'}</span></summary>
    <div>
      <p>每次按完整清单检查成品图片。可勾选这次想重点核对的地方。</p>
      <fieldset className="client-review-focus" disabled={!canStart}>
        <legend>检查重点（选填）</legend>
        {focusOptions.map(({ id, label }) => <label key={id}>
          <input type="checkbox" checked={focus.includes(id)} onChange={event => setFocus(current =>
            event.target.checked ? [...current, id] : current.filter(value => value !== id))} />{label}
        </label>)}
      </fieldset>
      <div className="client-review-actions">
        <ModelModeSwitch value={modelMode} disabled={busy || pending} onChange={setModelMode} />
        <button type="button" className="secondary-button workspace-button" disabled={!canStart} onClick={() => void start()}>
          <RefreshCw size={14} />{pending ? '正在视觉复核…' : 'Codex 视觉复核'}
        </button>
      </div>
      {(!card || dirty) && <small>请先完成采集并保存本次卡片。</small>}
      {error && <p role="alert">{error}</p>}
      {review && <p>{current || pending ? review.message : '当前图片与上次复核版本不同，请重新复核。'}</p>}
      {(current || pending) && submitted.length > 0 && <p>已提交检查重点 · {submitted.join('、')}</p>}
      {current && review?.result && <>
        <p>{review.result.summary}</p>
        <ul>{review.result.issues.map((issue, index) => <li key={index}><strong>{issue.area}：</strong>{issue.message}<small>{issue.suggestion}</small></li>)}</ul>
      </>}
    </div>
  </details>
}
