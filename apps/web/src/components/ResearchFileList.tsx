import { Download, FileText, LoaderCircle } from 'lucide-react'
import type { ResearchFile } from '../research'

export const reportPending = (status?: string) => status === 'queued' || status === 'running'
const reportLabels: Record<string, string> = { queued: '等待生成 PDF', running: '正在生成 PDF', failed: 'PDF 生成未完成', cancelled: 'PDF 生成已停止', partial: '部分报告需重新整理' }

export function isOriginalFormatOnlyDiscovery(file: { status?: string; source_kind?: unknown; discovery?: unknown }): boolean {
  if (file.source_kind !== 'discovery' || file.status !== 'partial'
    || !file.discovery || typeof file.discovery !== 'object' || Array.isArray(file.discovery)) return false
  const discovery = file.discovery as Record<string, unknown>
  return Array.isArray(discovery.errors) && discovery.errors.length === 0
    && Array.isArray(discovery.unsupported) && discovery.unsupported.length > 0
    && discovery.unsupported.every(name => {
      if (typeof name !== 'string') return false
      const basename = name.split(/[\\/]/).at(-1) || ''
      const dot = basename.lastIndexOf('.')
      return dot > 0 && ['.docx', '.xlsx', '.pptx'].includes(basename.slice(dot).toLowerCase())
    })
}

export default function ResearchFileList({ files, onRetry, busyId }: { files: (ResearchFile & { file_type?: string })[]; onRetry?: (file: ResearchFile) => void; busyId?: string }) {
  return <div className="research-file-list">{files.filter(file => !isOriginalFormatOnlyDiscovery(file)).map(file => file.url ? <a key={file.id || file.url} className="research-file-row" href={file.url} download title={file.name}><FileText size={18} aria-hidden="true" /><span><strong>{file.name}{file.previous ? ' · 此前生成' : ''}</strong><small>{file.file_type ? `${file.file_type.toUpperCase()} · ` : ''}{file.bytes >= 1024 * 1024 ? `${(file.bytes / (1024 * 1024)).toFixed(1)} MB` : `${(file.bytes / 1024).toFixed(1)} KB`}</small></span><Download size={16} aria-hidden="true" /></a> : <div key={file.id || file.name} className="research-file-row"><LoaderCircle size={18} className={reportPending(file.status) ? 'spin' : ''} /><span><strong>{file.name}</strong><small role="status">{reportLabels[file.status || ''] || '报告正在整理'} · 研究正文已保存</small>{['failed', 'partial'].includes(file.status || '') && file.message && <small>{file.message}</small>}</span>{['failed', 'cancelled', 'partial'].includes(file.status || '') && file.retry_url && onRetry && <button className="text-button" disabled={busyId === file.id} onClick={() => onRetry(file)}>{busyId === file.id ? '正在提交…' : '重试报告'}</button>}</div>)}</div>
}
