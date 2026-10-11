import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Bookmark, Check, ChevronRight, Copy, Download, GitBranch, ListFilter, LoaderCircle, MoreHorizontal, RefreshCw, Share2, Star, X } from 'lucide-react'
import { api, type Conversation, type ConversationMessage } from '../../api'
import { trapDialogTab } from '../../keyboard'
import AnswerSources from './AnswerSources'
import { answerSources } from './collectAnswerSources'
import { displayedMessages } from './answerVersions'

export default function ResearchAnswerTools({ conversation, message, locked, saved, savingNote, onSave, onCopy, onObserve, onDraft, onRegenerate, onBranch }: {
  conversation: Conversation; message: ConversationMessage; locked: boolean; saved: boolean; savingNote: boolean
  onSave: () => void; onCopy: () => void; onObserve: () => void; onDraft: () => void
  onRegenerate?: () => void; onBranch?: () => void
}) {
  const [menu, setMenu] = useState(false)
  const [dialog, setDialog] = useState<'sources' | 'share' | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [resolvedSources, setResolvedSources] = useState<Record<string, unknown>[] | null>(null)
  const [loadingSources, setLoadingSources] = useState(false), [sourceRetry, setSourceRetry] = useState(0)
  const [share, setShare] = useState<{ id: string; url: string } | null>(null)
  const [shareLoading, setShareLoading] = useState(false), [sharing, setSharing] = useState(false)
  const shareRequest = useRef<string | null>(null), shareLock = useRef(false)
  const [position, setPosition] = useState<CSSProperties>({ top: 0, left: 0 })
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null)
  const dialogLauncher = useRef<HTMLElement | null>(null)
  const menuId = useId()
  const sources = answerSources({ ...message, source_refs: [...(resolvedSources ?? []), ...message.source_refs] })
  const closeMenu = (focus = true) => { setMenu(false); if (focus) trigger.current?.focus() }
  const openDialog = (kind: 'sources' | 'share') => {
    dialogLauncher.current = kind === 'sources' ? trigger.current : document.activeElement as HTMLElement
    closeMenu(false); setError(''); setCopied(false); setDialog(kind)
  }
  useLayoutEffect(() => {
    if (!menu) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(240, window.innerWidth - 24), height = popup.current?.offsetHeight || 170
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: Math.max(12, rect.top >= height + 12 ? rect.top - height - 6 : Math.min(rect.bottom + 6, window.innerHeight - height - 12)), maxHeight: window.innerHeight - 24 })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [menu])
  useEffect(() => {
    if (!menu) return
    popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) closeMenu(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menu])
  useEffect(() => {
    if (!dialog) return
    const previous = dialogLauncher.current, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; closeButton.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [dialog])
  useEffect(() => {
    if (!dialog) return
    const controller = new AbortController()
    if (dialog === 'sources') {
      setLoadingSources(true)
      api<{ items: Record<string, unknown>[] }>(`/conversations/${conversation.id}/answers/${message.id}/sources`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) { if (!Array.isArray(result.items)) throw new Error('来源返回格式无效，请重试。'); setResolvedSources(result.items) } })
        .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
        .finally(() => { if (!controller.signal.aborted) setLoadingSources(false) })
    } else {
      setShareLoading(true)
      api<{ configured: boolean; share: { id: string; url: string } | null }>(`/conversations/${conversation.id}/answers/${message.id}/share`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) { setShare(result.share || null); if (result.configured === false) setError('公开分享服务尚未配置。') } })
        .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
        .finally(() => { if (!controller.signal.aborted) setShareLoading(false) })
    }
    return () => controller.abort()
  }, [dialog, conversation.id, message.id, sourceRetry])
  async function createShare() {
    if (shareLock.current || shareLoading) return
    shareLock.current = true; setSharing(true); setError('')
    shareRequest.current ||= crypto.randomUUID()
    try {
      const result = await api<{ id: string; url: string }>(`/conversations/${conversation.id}/answers/${message.id}/share`, {
        method: 'POST', body: JSON.stringify({ request_id: shareRequest.current }),
      })
      if (!result.url?.startsWith('https://')) throw new Error('分享链接未生成，请重试。')
      setShare(result)
    } catch (reason) { setError((reason as Error).message) }
    finally { shareLock.current = false; setSharing(false) }
  }
  async function revokeShare() {
    if (!share || shareLock.current) return
    shareLock.current = true; setSharing(true); setError('')
    try {
      await api(`/conversations/${conversation.id}/shares/${share.id}`, { method: 'DELETE' })
      setShare(null); setCopied(false); shareRequest.current = null
    } catch (reason) { setError((reason as Error).message) }
    finally { shareLock.current = false; setSharing(false) }
  }
  async function copyLink() {
    if (!share) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('浏览器暂时无法复制，请选中链接复制。')
      await navigator.clipboard.writeText(share.url); setCopied(true); setError('')
    } catch (reason) { setError((reason as Error).message) }
  }
  function download() {
    const messages = displayedMessages(conversation.messages, { [message.regeneration_of || message.id]: message.id })
    const index = messages.findIndex(item => item.id === message.id)
    const content = `# ${conversation.title || '研究对话'}\n\n` + messages.slice(0, index + 1)
      .map(item => `## ${item.role === 'user' ? '我' : '研究助手'}\n\n${item.content}`).join('\n\n---\n\n')
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = '研究对话.md'; link.click()
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <>
    <div className="research-answer-toolbar" role="group" aria-label="回答操作">
      <button type="button" aria-label="复制答复" title="复制答复" onClick={onCopy}><Copy size={17} /></button>
      <button type="button" aria-label="分享答复" title="分享答复" onClick={() => openDialog('share')}><Share2 size={17} /></button>
      <button type="button" aria-label="重新生成答案" title="重新生成答案" disabled={locked || !onRegenerate} onClick={onRegenerate}><RefreshCw size={17} /></button>
      <button type="button" aria-label="保存为研究笔记" title={saved ? '已保存为研究笔记' : savingNote ? '正在保存…' : '保存为研究笔记'} disabled={locked || saved} onClick={onSave}>
        {savingNote ? <LoaderCircle size={17} className="spin" /> : saved ? <Check size={17} /> : <Bookmark size={17} />}<span className="sr-only">{saved ? '已保存为研究笔记' : ''}</span>
      </button>
      <button type="button" aria-label="加入观察" title="加入观察" disabled={locked} onClick={onObserve}><Star size={17} /></button>
      <button ref={trigger} type="button" aria-label="更多回答操作" title="更多回答操作" aria-haspopup="menu" aria-expanded={menu} aria-controls={menu ? menuId : undefined}
        onClick={() => setMenu(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setMenu(true) } }}><MoreHorizontal size={19} /></button>
    </div>
    {menu && createPortal(<div ref={popup} id={menuId} className="research-answer-menu" style={position} role="menu" aria-label="更多回答操作" onKeyDown={event => {
      const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu() }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      } else if (event.key === 'Tab') closeMenu(false)
    }}>
      <button type="button" role="menuitem" onClick={() => openDialog('sources')}><BookOpen size={17} />查看来源{(sources.length > 0 || resolvedSources !== null) && <span className="research-answer-source-count">{sources.length}</span>}</button>
      <button type="button" role="menuitem" disabled={locked || !onBranch} onClick={() => { closeMenu(false); onBranch?.() }}><GitBranch size={17} />打开新对话分支<ChevronRight size={15} /></button>
      <button type="button" role="menuitem" disabled={locked} onClick={() => { closeMenu(); onDraft() }}><ListFilter size={17} />转为选股草稿</button>
    </div>, document.body)}
    {dialog && createPortal(<div className={`research-result-dialog-backdrop${dialog === 'sources' ? ' research-sources-backdrop' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null) }}>
      <section className={`research-result-dialog${dialog === 'sources' ? ' research-sources-drawer' : ''}`} role="dialog" aria-modal="true" aria-label={dialog === 'sources' ? '回答来源' : '分享研究答复'}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setDialog(null) }; trapDialogTab(event) }}>
        <header className="research-result-dialog-header"><h2>{dialog === 'sources' ? '来源' : '分享研究答复'}</h2><button ref={closeButton} type="button" className="icon-button" aria-label={dialog === 'sources' ? '关闭回答来源' : '关闭分享'} onClick={() => setDialog(null)}><X size={20} /></button></header>
        <div className="research-result-dialog-body">
          {dialog === 'sources' ? <>
            {loadingSources && <p role="status">正在读取这条答复的来源…</p>}
            {sources.length ? <AnswerSources references={sources} expanded /> : !loadingSources && !error && <p className="research-answer-empty-sources">这条答复没有附可查看的来源。</p>}
            {error && <p role="alert" className="research-next-step-submit-error">{error}<button type="button" className="text-button" onClick={() => { setError(''); setSourceRetry(value => value + 1) }}>重试读取来源</button></p>}
          </> : <>
            <p className="research-share-description">创建链接后，任何收到链接的人都能在其他设备查看截至这条回答的对话、完整报告和来源。后续研究不会改变已分享的内容。</p>
            {shareLoading && <p role="status">正在读取分享链接…</p>}
            {share && <input className="research-share-link" aria-label="研究对话分享链接" readOnly value={share.url} onFocus={event => event.target.select()} />}
            <div className="research-share-actions">{share ? <button type="button" className="primary-button" disabled={sharing} onClick={() => void copyLink()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? '已复制链接' : '复制链接'}</button> : <button type="button" className="primary-button" disabled={sharing || shareLoading} onClick={() => void createShare()}>{sharing ? <LoaderCircle size={16} className="spin" /> : <Share2 size={16} />}{sharing ? '正在创建…' : '创建分享链接'}</button>}<button type="button" className="secondary-button" onClick={download}><Download size={16} />下载对话文件</button></div>
            {share && <button type="button" className="text-button research-share-revoke" disabled={sharing} onClick={() => void revokeShare()}>撤销分享链接</button>}
            {error && <p role="alert" className="research-next-step-submit-error">{error}</p>}
          </>}
        </div>
      </section>
    </div>, document.body)}
  </>
}
