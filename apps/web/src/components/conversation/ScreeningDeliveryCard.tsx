import { useEffect, useRef, useState } from 'react'
import { Check, FileSearch, LoaderCircle } from 'lucide-react'
import { api, type ScreeningTaskRevision, type ScreeningTaskRunSummary } from '../../api'
import ScreeningClarifications from './ScreeningClarifications'
import { taskUniverseLabel } from './TaskBrief'
import './screening-delivery.css'

export type DeliveryRun = {
  id: string; task_revision: number; as_of: string; status: string
  result: { coverage?: { target_total: number; true_count: number; false_count: number; unknown_count: number; failed_count?: number; not_evaluated_count?: number } }
  job?: { progress: number; message: string; state: string } | null
}
type Props = {
  conversationId: string; task: ScreeningTaskRevision | null
  currentRun?: ScreeningTaskRunSummary; viewedRun: DeliveryRun | null; viewedRunId: string
  readError: string; refreshKey: number; active: boolean; processing: boolean; failed: boolean; cancelled?: boolean
  pending: boolean; paused: boolean; canStart: boolean; disabled: boolean; stopping: boolean
  onPlan: () => void; onResults: () => void; onEdit: () => void; onStart: () => void
  onReload: () => void; onRetryStart?: () => void; onStop?: () => void
  onClarify: (text: string) => void
  onRunStatus: (id: string, status: string) => void
  onContentChange: () => void
}

/** A stable delivery surface. Loading a saved result never opens a dialog. */
export default function ScreeningDeliveryCard(props: Props) {
  const { task, currentRun, viewedRun, conversationId } = props
  const [cached, setCached] = useState<DeliveryRun | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (viewedRun?.id === currentRun?.id && viewedRun) setCached(viewedRun)
  }, [viewedRun, currentRun?.id])
  // Reading history in the side panel must not freeze or replace current results.
  useEffect(() => {
    setError('')
    if (!currentRun || props.viewedRunId === currentRun.id) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      try {
        const next = await api<DeliveryRun>(`/conversations/${conversationId}/screening-runs/${currentRun!.id}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setCached(next); setError(''); props.onRunStatus(next.id, next.status)
        if (['queued', 'running'].includes(next.status)) timer = setTimeout(() => void load(), props.active ? 1500 : 12000)
      } catch (reason) {
        if (!controller.signal.aborted) { setError((reason as Error).message); timer = setTimeout(() => void load(), 10000) }
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [conversationId, currentRun?.id, props.viewedRunId, props.refreshKey, props.active])
  const detail = viewedRun?.id === currentRun?.id ? viewedRun : cached?.id === currentRun?.id ? cached : null
  const status = detail?.status || currentRun?.status
  const running = !props.processing && !!status && ['queued', 'running'].includes(status)
  const finished = !props.processing && !!status && ['succeeded', 'partial'].includes(status)
  const readError = currentRun && props.viewedRunId === currentRun.id ? props.readError : error
  const title = props.processing ? task ? '正在更新筛选方案' : '正在整理筛选方案'
    : readError ? '筛选状态暂时无法读取'
      : props.failed ? '本轮处理未完成' : props.cancelled ? '本次整理已停止'
      : running ? status === 'queued' ? '筛选已排队' : '正在筛选'
        : finished ? status === 'partial' ? '筛选完成 · 部分待判断' : '筛选完成'
          : status === 'failed' ? '筛选未完成' : status === 'cancelled' ? '筛选已停止'
            : task?.unresolved.length ? '需要补充筛选条件' : props.pending ? '等待启动筛选'
              : task ? props.paused ? '方案已生成，按要求暂不筛选' : '筛选方案已整理'
                : props.failed ? '方案未完成' : '尚未形成筛选方案'
  const coverage = finished ? detail?.result?.coverage : undefined
  const progress = detail?.job?.progress
  const ranking = task?.scope.ranking
  const contentChange = useRef(props.onContentChange)
  contentChange.current = props.onContentChange
  useEffect(() => { contentChange.current() }, [props.processing, task?.revision, task?.unresolved.length, status, coverage?.true_count, coverage?.unknown_count, readError])
  return <section className="screening-delivery-card" aria-label="本次选股进展">
    <header><span className="screening-delivery-icon" aria-hidden="true">{props.processing || running || props.pending ? <LoaderCircle size={17} className="spin" /> : finished ? <Check size={17} /> : <FileSearch size={17} />}</span><div>
      <strong role="status" aria-live="polite" aria-atomic="true">{title}</strong>
      {task && <p>{task.conditions.length} 项条件 · {taskUniverseLabel(task)} · 截至 {task.scope.as_of || '待确定'}</p>}
    </div></header>
    {task && <p className="screening-delivery-rules">{task.conditions.slice(0, 2).map(item => item.description).join('；')}{task.conditions.length > 2 ? '；…' : ''}</p>}
    {ranking && <p className="screening-delivery-ranking"><span>{({ industry: '行业内', all_a_shares: '全部A股', watchlist: '自选股票池', after_filters: '满足指定条件的股票' } as Record<string, string>)[String(ranking.ranking_universe)] || '排名范围待确定'}</span><span>前 {String(ranking.top_n ?? '待确定')} 名</span><span>{ranking.ties_policy === 'include_all' ? '保留全部并列' : '同分按股票代码排序'}</span><span>{ranking.missing_policy === 'exclude_with_notice' ? '排除缺失并说明' : '范围不完整时保留未知'}</span></p>}
    {running && <div className="screening-delivery-progress">{typeof progress === 'number' && Number.isFinite(progress) && <progress aria-label="筛选进度" max={1} value={Math.max(0, Math.min(1, progress))} />}<span>{detail?.job?.message || '正在读取真实执行进度…'}</span></div>}
    {coverage && <div className="screening-delivery-counts">{(readError || props.failed) && <span>{props.failed ? '已取得的筛选结果' : '上次读取结果'}</span>}<span>符合 <strong>{coverage.true_count}</strong> 只</span><span>尚无法判断 <strong>{coverage.unknown_count}</strong> 只</span><span>已判断 {coverage.true_count + coverage.false_count} / {coverage.target_total} 只</span>{!!coverage.failed_count && <span>其中 {coverage.failed_count} 只处理失败</span>}{!!coverage.not_evaluated_count && <span>{coverage.not_evaluated_count} 只未处理</span>}</div>}
    {readError && <p className="workspace-error">{readError}。暂不能据此判断是否有匹配结果。</p>}
    {!!task?.unresolved.length && <ScreeningClarifications key={`${task.task_id}:${task.revision}`} items={task.unresolved} disabled={props.disabled} onCompose={props.onClarify} actionLabel={props.paused ? '补充并更新方案' : '补充并继续筛选'} helpText="补充回答将与输入框中的草稿一起提交。" />}
    <div className="screening-delivery-actions">
      {task && <button type="button" className="text-button workspace-button" onClick={props.onPlan}>查看方案</button>}
      {currentRun && <button type="button" className="secondary-button compact workspace-button" onClick={props.onResults}>{running ? '查看进度' : '查看名单'}</button>}
      {props.canStart && <button type="button" className="primary-button compact workspace-button" disabled={props.disabled} onClick={props.onStart}>开始筛选</button>}
      {props.pending && props.onRetryStart && <button type="button" className="text-button workspace-button" disabled={props.disabled} onClick={props.onRetryStart}>重试启动</button>}
      {readError && <button type="button" className="text-button workspace-button" onClick={props.onReload}>重新读取状态</button>}
      {(props.processing || running) && props.onStop && <button type="button" className="text-button workspace-button" disabled={props.stopping} onClick={props.onStop}>停止</button>}
      {!props.processing && <button type="button" className="text-button workspace-button" onClick={props.onEdit}>{task ? '调整要求' : '补充要求'}</button>}
    </div>
  </section>
}
