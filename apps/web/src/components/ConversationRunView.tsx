import { StockText } from './StockMentions'
import { useEffect, useState } from 'react'
import { api, type ScreeningTaskDecision, type ScreeningTaskRevision } from '../api'
import ScreeningResultView from './ScreeningResultView'
import StockChartDialog from './StockChartDialog'
import { TaskLogic } from './conversation/TaskBrief'

type Run = { id: string; as_of: string; status: string; task_revision: number; task: ScreeningTaskRevision; job: { progress: number; message: string }; result: { coverage?: { target_total: number; true_count: number; false_count: number; unknown_count: number } } }
export default function ConversationRunView({ conversationId, runId, onContinue }: { conversationId: string; runId: string; onContinue: () => void }) {
  const [run, setRun] = useState<Run | null>(null)
  const [items, setItems] = useState<ScreeningTaskDecision[]>([])
  const [state, setState] = useState('true')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [chart, setChart] = useState('')
  const base = `/conversations/${conversationId}/screening-runs/${runId}`
  useEffect(() => {
    let active = true, pending = false
    setRun(null); setError('')
    async function load() {
      if (pending) return
      pending = true
      try { const next = await api<Run>(base); if (active) { setRun(next); if (!['queued', 'running'].includes(next.status)) clearInterval(timer) } }
      catch (reason) { if (active) setError((reason as Error).message) }
      finally { pending = false }
    }
    const timer = setInterval(() => void load(), 1500)
    void load()
    return () => { active = false; clearInterval(timer) }
  }, [base, reload])
  useEffect(() => {
    let active = true
    setLoading(true); setItems([]); setError('')
    const timer = setTimeout(() => {
      api<{ items: ScreeningTaskDecision[]; total: number }>(`${base}/decisions?state=${state}&query=${encodeURIComponent(query)}&offset=${offset}&limit=20`)
        .then(result => { if (active) { setItems(result.items); setTotal(result.total) } })
        .catch(reason => { if (active) setError(reason.message) }).finally(() => { if (active) setLoading(false) })
    }, 180)
    return () => { active = false; clearTimeout(timer) }
  }, [base, run?.status, state, query, offset, reload])
  if (!run) return <StockText><div><p role={error ? 'alert' : 'status'}>{error || '正在读取历史筛选…'}</p>{error && <button onClick={() => setReload(i => i + 1)}>重试</button>}</div></StockText>
  return <StockText><div className="conversation-history-result"><div className="section-title-row"><h2>选股记录</h2><button className="primary-button" onClick={onContinue}>打开原对话与方案</button></div>
    <div className="history-run-context"><p className="history-date-notice">截止日期：{run.as_of}</p>
    <details><summary>本次采用的筛选规则</summary><TaskLogic task={run.task} /></details></div>
    <ScreeningResultView asOf={run.as_of} revision={run.task_revision} status={run.status} isCurrent={false}
      coverage={run.result.coverage} progress={{ message: run.job.message, percent: run.job.progress }}
      decisions={items.map(item => ({ stock_code: item.stock_code, state: item.state, as_of: run.as_of, conditions: item.condition_decisions.map(condition => ({ name: run.task.conditions.find(c => c.condition_id === condition.condition_id)?.description || '筛选条件', state: condition.state, explanation: condition.explanation })) }))}
      loading={loading} error={error} total={total} offset={offset} pageSize={20} stateFilter={state} query={query}
      onStateFilterChange={value => { setState(value); setOffset(0) }} onQueryChange={value => { setQuery(value); setOffset(0) }} onPageChange={setOffset}
      onReload={() => setReload(i => i + 1)} onExportUrl={`/api/v1${base}/export?state=${state}&query=${encodeURIComponent(query)}`}
      onViewChart={setChart} onAskStock={onContinue} />
    {chart && <StockChartDialog code={chart} asOf={run.as_of} onClose={() => setChart('')} />}
  </div></StockText>
}
