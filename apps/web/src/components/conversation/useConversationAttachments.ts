import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'

export type ConversationAttachment = {
  id: string; conversation_id: string; request_id?: string; filename: string; media_type: string
  bytes: number; sha256: string; created_at: string; url: string
}
export type DraftAttachment = {
  requestId: string; name: string; bytes: number; lastModified: number; conversationId?: string
  status: 'uploading' | 'ready' | 'error' | 'cancelled' | 'missing'
  error?: string; attachment?: ConversationAttachment
}
type DraftMap = Record<string, DraftAttachment[]>
type Target = { conversationId: string; draftKey: string }
const KEY = 'conversation.attachmentDrafts'
export const ATTACHMENT_ACCEPT = '.pdf,.docx,.xlsx,.pptx,.csv,.tsv,.txt,.md,.json,.png,.jpg,.jpeg,.webp,.gif,.bmp'
const MAX_FILES = 8
const MAX_BYTES = 25 * 1024 * 1024

function readDrafts(restore = true): DraftMap | null {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    const result: DraftMap = {}
    for (const [key, value] of Object.entries(stored)) {
      if (!Array.isArray(value)) continue
      result[key] = value.filter((item): item is DraftAttachment => !!item && typeof item === 'object'
        && typeof item.requestId === 'string' && typeof item.name === 'string' && typeof item.bytes === 'number'
        && ['uploading', 'ready', 'error', 'cancelled', 'missing'].includes(item.status))
        .slice(0, MAX_FILES).map(item => restore ? ({
          ...item, status: item.status === 'ready' && item.attachment?.id ? 'ready' : item.status === 'cancelled' ? 'cancelled' : 'missing',
          ...(item.status !== 'ready' && item.status !== 'cancelled' ? { error: '请选择原文件继续上传。' } : {}),
        }) : item)
    }
    return result
  } catch { return null }
}

function saveDrafts(value: DraftMap) {
  try { sessionStorage.setItem(KEY, JSON.stringify(value)); return true }
  catch { return false /* Current-page files remain available without storage. */ }
}

function validateFile(file: File) {
  if (file.size > MAX_BYTES) return '文件不能超过 25 MB。'
  const extension = '.' + file.name.split('.').at(-1)?.toLowerCase()
  if (!ATTACHMENT_ACCEPT.split(',').includes(extension)) return '暂不支持这个文件格式。'
  return ''
}

export function attachmentDownloadUrl(item: ConversationAttachment) {
  return `/api/v1/conversations/${encodeURIComponent(item.conversation_id)}/attachments/${encodeURIComponent(item.id)}/download`
}

export function useConversationAttachments(draftKey: string, conversationId: string | undefined, ensureConversation: () => Promise<Target>) {
  const [drafts, setDrafts] = useState<DraftMap>(() => readDrafts() ?? {})
  const draftsRef = useRef(drafts)
  const files = useRef(new Map<string, File>())
  const controllers = useRef(new Map<string, AbortController>())
  const mounted = useRef(true)
  const storageAvailable = useRef(true)
  const currentKey = useRef(draftKey)
  currentKey.current = draftKey
  const ensureRef = useRef(ensureConversation)
  ensureRef.current = ensureConversation
  const [error, setError] = useState('')

  function update(change: (value: DraftMap) => DraftMap) {
    if (!mounted.current) return
    // Another mounted draft may have written since this request started. Apply
    // the narrow key/item update to the latest map, never a stale whole copy.
    const latest = storageAvailable.current ? readDrafts(false) : null
    draftsRef.current = change(latest ?? draftsRef.current)
    storageAvailable.current = saveDrafts(draftsRef.current)
    setDrafts(draftsRef.current)
  }

  function changeItem(key: string, requestId: string, change: Partial<DraftAttachment>) {
    update(value => ({ ...value, [key]: (value[key] || []).map(item => item.requestId === requestId ? { ...item, ...change } : item) }))
  }

  function move(from: string, to: string, requestIds?: string[]) {
    if (from === to) return
    update(value => {
      const moved = (value[from] || []).filter(item => !requestIds || requestIds.includes(item.requestId))
      const keep = (value[from] || []).filter(item => requestIds && !requestIds.includes(item.requestId))
      const existing = value[to] || []
      return { ...value, [from]: keep, [to]: [...existing, ...moved.filter(item => !existing.some(old => old.requestId === item.requestId))] }
    })
  }

  async function sendFile(key: string, item: DraftAttachment, cid: string, file: File) {
    const current = (draftsRef.current[key] || []).find(saved => saved.requestId === item.requestId)
    if (!current || current.status === 'cancelled' || controllers.current.has(item.requestId)) return
    const validation = validateFile(file)
    if (validation) { changeItem(key, item.requestId, { status: 'error', error: validation }); return }
    const controller = new AbortController()
    controllers.current.set(item.requestId, controller)
    changeItem(key, item.requestId, { status: 'uploading', conversationId: cid, error: '' })
    const body = new FormData()
    body.append('file', file)
    body.append('request_id', item.requestId)
    try {
      const uploaded = await api<ConversationAttachment>(`/conversations/${encodeURIComponent(cid)}/attachments`, { method: 'POST', body, signal: controller.signal })
      if (!uploaded?.id || uploaded.conversation_id !== cid || (uploaded.request_id && uploaded.request_id !== item.requestId)) throw new Error('上传结果尚未确认，请重试。')
      if (!controller.signal.aborted) {
        changeItem(key, item.requestId, { status: 'ready', attachment: uploaded, error: '' })
        files.current.delete(item.requestId)
      }
    } catch (reason) {
      if (!controller.signal.aborted) changeItem(key, item.requestId, { status: 'error', error: reason instanceof Error ? reason.message : '上传失败，请重试。' })
    } finally { controllers.current.delete(item.requestId) }
  }

  async function upload(selected: FileList | File[]) {
    const batch = Array.from(selected)
    if (!batch.length) return
    const owner = currentKey.current
    if ((draftsRef.current[owner]?.length || 0) + batch.length > MAX_FILES) { setError('每条消息最多添加 8 个文件。'); return }
    setError('')
    const entries: DraftAttachment[] = batch.map(file => {
      const requestId = crypto.randomUUID()
      files.current.set(requestId, file)
      return { requestId, name: file.name, bytes: file.size, lastModified: file.lastModified, status: 'uploading' }
    })
    update(value => ({ ...value, [owner]: [...(value[owner] || []), ...entries] }))
    let targetKey = owner
    try {
      const target = await ensureRef.current()
      if (!mounted.current) return
      targetKey = target.draftKey
      move(owner, targetKey, entries.map(item => item.requestId))
      await Promise.all(entries.map(item => sendFile(targetKey, item, target.conversationId, files.current.get(item.requestId)!)))
    } catch (reason) {
      for (const item of entries) changeItem(targetKey, item.requestId, { status: 'error', error: reason instanceof Error ? reason.message : '无法准备上传，请重试。' })
    }
  }

  async function retry(requestId: string, replacement?: File) {
    const owner = currentKey.current
    const item = draftsRef.current[owner]?.find(value => value.requestId === requestId)
    if (!item || controllers.current.has(requestId)) return
    if (replacement) {
      if (replacement.name !== item.name || replacement.size !== item.bytes) {
        changeItem(owner, requestId, { status: 'missing', error: '请选择同一个文件，或先移除后添加新文件。' })
        return
      }
      files.current.set(requestId, replacement)
    }
    const file = files.current.get(requestId)
    if (!file) { changeItem(owner, requestId, { status: 'missing', error: '请选择原文件继续上传。' }); return }
    let targetKey = owner
    changeItem(owner, requestId, { status: 'uploading', error: '' })
    try {
      const target = item.conversationId ? { conversationId: item.conversationId, draftKey: owner } : await ensureRef.current()
      if (!mounted.current) return
      targetKey = target.draftKey
      move(owner, targetKey, [requestId])
      await sendFile(targetKey, item, target.conversationId, file)
    } catch (reason) { changeItem(targetKey, requestId, { status: 'error', error: reason instanceof Error ? reason.message : '上传失败，请重试。' }) }
  }

  function cancel(requestId: string) {
    controllers.current.get(requestId)?.abort()
    changeItem(currentKey.current, requestId, { status: 'cancelled', error: '' })
  }

  function remove(requestId: string) {
    controllers.current.get(requestId)?.abort()
    files.current.delete(requestId)
    update(value => ({ ...value, [currentKey.current]: (value[currentKey.current] || []).filter(item => item.requestId !== requestId) }))
    setError('')
  }

  function clear(key: string, ids: string[]) {
    update(value => ({ ...value, [key]: (value[key] || []).filter(item => !item.attachment || !ids.includes(item.attachment.id)) }))
  }

  useEffect(() => {
    setError('')
    if (!conversationId || !(draftsRef.current[draftKey] || []).some(item => item.status !== 'ready' && item.status !== 'cancelled')) return
    const controller = new AbortController()
    void api<{ items: ConversationAttachment[] }>(`/conversations/${encodeURIComponent(conversationId)}/attachments`, { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items) || controller.signal.aborted) return
      update(value => ({ ...value, [draftKey]: (value[draftKey] || []).map(item => {
        const stored = result.items.find(attachment => attachment.request_id === item.requestId)
        return stored && item.status !== 'cancelled' && !controllers.current.has(item.requestId)
          ? { ...item, conversationId, attachment: stored, status: 'ready', error: '' } : item
      }) }))
    }).catch(() => { /* Keep the original pending chip and its retry identity. */ })
    return () => controller.abort()
  }, [draftKey, conversationId])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of controllers.current.values()) controller.abort()
    }
  }, [])

  const items: DraftAttachment[] = (drafts[draftKey] || []).map(item => item.status !== 'ready' && item.status !== 'cancelled'
    && !files.current.has(item.requestId) && !controllers.current.has(item.requestId)
    ? { ...item, status: 'missing', error: '请选择原文件继续上传。' } : item)
  return {
    items: items.map(item => ({ ...item, canRetry: files.current.has(item.requestId) })), error, upload, retry, cancel, remove, move, clear,
    ready: items.filter(item => item.status === 'ready' && item.attachment).map(item => item.attachment!),
    uploading: items.some(item => item.status === 'uploading'),
    hasUnready: items.some(item => item.status !== 'ready'),
  }
}
