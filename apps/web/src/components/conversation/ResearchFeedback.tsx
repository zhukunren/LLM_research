import { StockText } from '../StockMentions'
import { useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle, Square } from 'lucide-react'
import './research-progress.css'

export function isExecutionFailure(content: string) {
  return /^(?:Codex\s*(?:运行失败|运行不可用|研究回合失败)|研究处理失败|研究执行失败|本次处理失败|研究服务启动失败)/i.test(content.trim()) || /^\s*(?:Traceback \(most recent call last\)|Error:.*(?:stdout|stderr|runtime))/i.test(content)
}

export function ResearchFailure({ content, onRetry, disabled }: { content: string; onRetry?: () => void; disabled?: boolean }) {
  const permission = /拒绝访问|access.denied|permission.denied|os error 5/i.test(content)
  const timeout = /timeout|timed.out|超时/i.test(content)
  return <StockText><div className="research-failure" role="alert">
    <div><AlertCircle size={19} /><strong>{timeout ? '这次研究等待超时' : permission ? '研究服务暂时无法启动' : '这次研究未能完成'}</strong></div>
    <p>{permission ? '服务无法访问所需的本地文件。请检查“数据与服务”，恢复服务后重新处理。' : timeout ? '原问题已保留，可以重新处理，或缩小研究范围后再试。' : '原问题和已有成果已保留。请检查服务状态，再重新处理。'}</p>
    {onRetry && <button className="secondary-button" disabled={disabled} onClick={onRetry}>重试这次研究</button>}
    <details><summary>查看技术详情</summary><pre>{content}</pre></details>
  </div></StockText>
}

function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds / 60) % 60} 分`
}

export function ResearchProgress({ label, startedAt, updatedAt, stopping, onStop }: {
  label: string; startedAt: string; updatedAt: string; stopping: boolean; onStop: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const started = Date.parse(startedAt), updated = Date.parse(updatedAt)
  const elapsed = Number.isFinite(started) ? now - started : 0
  const lastActivity = Number.isFinite(updated) ? updated : started
  const waitingLong = !stopping && elapsed >= 90000 && Number.isFinite(lastActivity) && now - lastActivity >= 60000
  const status = stopping ? '正在停止…' : label
  return <div className="research-progress research-progress--compact">
    <div className="research-progress-heading">
      <span className="research-progress-status" role="status" aria-live="polite" aria-atomic="true"><LoaderCircle size={15} className="spin" aria-hidden="true" /><span title={status}>{status}</span></span>
      <span className="research-progress-duration" aria-live="off">{Number.isFinite(started) ? duration(elapsed) : '正在计时'}</span>
      <button type="button" className="text-button" disabled={stopping} onClick={onStop} aria-label="停止当前研究"><Square size={12} aria-hidden="true" />停止</button>
    </div>
    {waitingLong && <p className="research-progress-waiting">仍在处理，可继续等待或停止。</p>}
  </div>
}
