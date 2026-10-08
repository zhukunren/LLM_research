import { useRef } from 'react'
import { Download, FileText, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { ATTACHMENT_ACCEPT, attachmentDownloadUrl, type ConversationAttachment, type DraftAttachment } from './useConversationAttachments'
import './composer-attachments.css'

function fileSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB` }

function DraftChip({ item, disabled, onRemove, onCancel, onRetry }: {
  item: DraftAttachment & { canRetry: boolean }; disabled: boolean
  onRemove: (id: string) => void; onCancel: (id: string) => void; onRetry: (id: string, file?: File) => void
}) {
  const picker = useRef<HTMLInputElement>(null)
  return <li className={`composer-attachment-chip attachment-${item.status}`}>
    {item.status === 'uploading' ? <LoaderCircle size={18} className="spin" aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />}
    <span className="attachment-chip-copy"><strong title={item.name}>{item.name}</strong><small>{item.status === 'uploading' ? '正在上传…' : item.status === 'ready' ? fileSize(item.bytes) : item.status === 'cancelled' ? '上传已取消' : item.error || '上传未完成'}</small></span>
    {item.status !== 'ready' && item.status !== 'uploading' && <><button type="button" className="icon-button" disabled={disabled} aria-label={`${item.canRetry ? '重试上传' : '重新选择'}：${item.name}`} title={item.canRetry ? '重试上传' : '重新选择原文件'} onClick={() => item.canRetry ? onRetry(item.requestId) : picker.current?.click()}><RotateCcw size={14} /></button><input ref={picker} type="file" hidden accept={ATTACHMENT_ACCEPT} aria-label={`重新选择原文件：${item.name}`} onChange={event => { const file = event.target.files?.[0]; if (file) onRetry(item.requestId, file); event.currentTarget.value = '' }} /></>}
    <button type="button" className="icon-button" disabled={disabled} aria-label={`${item.status === 'uploading' ? '取消上传' : '移除附件'}：${item.name}`} title={item.status === 'uploading' ? '取消上传' : '移除附件'} onClick={() => item.status === 'uploading' ? onCancel(item.requestId) : onRemove(item.requestId)}><X size={14} /></button>
  </li>
}

export function DraftAttachmentChips({ items, disabled, onRemove, onCancel, onRetry }: {
  items: (DraftAttachment & { canRetry: boolean })[]; disabled: boolean
  onRemove: (id: string) => void; onCancel: (id: string) => void; onRetry: (id: string, file?: File) => void
}) {
  if (!items.length) return null
  return <ul className="composer-attachment-chips" aria-label="待发送附件">{items.map(item => <DraftChip key={item.requestId} item={item} disabled={disabled} onRemove={onRemove} onCancel={onCancel} onRetry={onRetry} />)}</ul>
}

export function MessageAttachmentChips({ items }: { items?: ConversationAttachment[] }) {
  if (!items?.length) return null
  return <ul className="message-attachment-chips" aria-label="消息附件">{items.map(item => <li key={item.id}><a href={attachmentDownloadUrl(item)} download={item.filename} className="composer-attachment-chip" aria-label={`下载附件：${item.filename}`}><FileText size={18} aria-hidden="true" /><span className="attachment-chip-copy"><strong title={item.filename}>{item.filename}</strong><small>{fileSize(item.bytes)}</small></span><Download size={14} aria-hidden="true" /></a></li>)}</ul>
}
