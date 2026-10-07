import { Download, FileText, LoaderCircle } from 'lucide-react'
import type { ResearchFile } from '../research'

export const reportPending = (status?: string) => status === 'queued' || status === 'running'
const reportLabels: Record<string, string> = { queued: '等待生成 PDF', running: '正在生成 PDF', failed: 'PDF 生成未完成', cancelled: 'PDF 生成已停止', partial: '部分报告需重新整理' }

export default function ResearchFileList({ files, onRetry, busyId }: { files: ResearchFile[]; onRetry: (file: ResearchFile) => void; busyId?: string }) {
  return <div className="research-file-list">{files.map(file => file.url ? <a key={file.id || file.url} className="research-file-row" href={file.url} download title={file.name}><FileText size={18} /><span><strong>{file.name}{file.previous ? ' · 此前生成' : ''}</strong><small>{(file.bytes / 1024).toFixed(1)} KB</small></span><Download size={16} /></a> : <div key={file.id || file.name} className="research-file-row"><LoaderCircle size={18} className={reportPending(file.status) ? 'spin' : ''} /><span><strong>{file.name}</strong><small role="status">{reportLabels[file.status || ''] || '报告正在整理'} · 研究正文已保存</small>{['failed', 'partial'].includes(file.status || '') && file.message && <small>{file.message}</small>}</span>{['failed', 'cancelled', 'partial'].includes(file.status || '') && file.retry_url && <button className="text-button" disabled={busyId === file.id} onClick={() => onRetry(file)}>{busyId === file.id ? '正在提交…' : '重试报告'}</button>}</div>)}</div>
}
