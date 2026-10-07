import { useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle, Square } from 'lucide-react'

export function isExecutionFailure(content: string) {
  return /^(?:Codex\s*(?:运行失败|运行不可用|研究回合失败)|研究处理失败|研究执行失败|本次处理失败|研究服务启动失败)/i.test(content.trim()) || /^\s*(?:Traceback \(most recent call last\)|Error:.*(?:stdout|stderr|runtime))/i.test(content)
}

export function ResearchFailure({ content, onRetry, disabled }: { content: string; onRetry?: () => void; disabled?: boolean }) {
  const permission = /拒绝访问|access.denied|permission.denied|os error 5/i.test(content)
  const timeout = /timeout|timed.out|超时/i.test(content)
  return <div className="research-failure" role="alert">
    <div><AlertCircle size={19} /><strong>{timeout ? '这次研究等待超时' : permission ? '研究服务暂时无法启动' : '这次研究未能完成'}</strong></div>
    <p>{permission ? '服务无法访问所需的本地文件。请检查“数据与服务”，恢复服务后重新处理。' : timeout ? '原问题已保留，可以重新处理，或缩小研究范围后再试。' : '原问题和已有成果已保留。请检查服务状态，再重新处理。'}</p>
    {onRetry && <button className="secondary-button" disabled={disabled} onClick={onRetry}>重试这次研究</button>}
    <details><summary>查看技术详情</summary><pre>{content}</pre></details>
  </div>
}

function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds / 60) % 60} 分`
}

export function ResearchProgress({ label, startedAt, updatedAt, stopping, onStop }: {
  label: string; startedAt: string; updatedAt: string; stopping: boolean; onStop: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10000); return () => window.clearInterval(timer) }, [])
  const started = Date.parse(startedAt), updated = Date.parse(updatedAt)
  return <div className="research-progress">
    <div className="research-progress-heading"><span role="status"><LoaderCircle size={17} className="spin" />{label}</span><button type="button" className="text-button" disabled={stopping} onClick={onStop} aria-label="停止当前研究"><Square size={14} />{stopping ? '正在停止…' : '停止任务'}</button></div>
    <p>已耗时 {Number.isFinite(started) ? duration(now - started) : '正在计时'} · {Number.isFinite(updated) ? `最近更新于 ${new Date(updated).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : '等待进度更新'}</p>
  </div>
}
