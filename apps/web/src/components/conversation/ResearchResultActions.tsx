import { StockText } from '../StockMentions'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, X } from 'lucide-react'
import type { Conversation, ConversationMessage } from '../../api'
import { trapDialogTab } from '../../keyboard'
import StockSearch, { useSecurities } from '../StockSearch'
import { researchAnswerExcerpt, researchAnswerScreeningDraft, researchAnswerSecurityCodes, researchAnswerTurn, uniqueResearchSecurity } from './researchResultNextSteps'
import './research-result-actions.css'
import ResearchAnswerTools from './ResearchAnswerTools'

export type ResearchResultRequest =
  | { kind: 'draft'; instructions: string }
  | { kind: 'observe'; stock_code: string; note: string; verification: string; invalidation: string }

export default function ResearchResultActions({ conversation, message, disabled, savingNote, savingAction, onSave, onCopy, onSubmit, onContinue, onRegenerate, onBranch }: {
  conversation: Conversation; message: ConversationMessage; disabled: boolean; savingNote: boolean; savingAction: boolean
  onSave: () => Promise<boolean>; onCopy: () => void; onSubmit: (request: ResearchResultRequest) => Promise<boolean>
  onContinue: () => void
  onRegenerate?: () => void; onBranch?: () => void
}) {
  const { items: securities, loading: catalogLoading, error: catalogError } = useSecurities()
  const [saved, setSaved] = useState(false)
  const [action, setAction] = useState<'draft' | 'observe' | null>(null)
  const [instructions, setInstructions] = useState('')
  const [stockCode, setStockCode] = useState('')
  const [note, setNote] = useState('')
  const [verification, setVerification] = useState('')
  const [invalidation, setInvalidation] = useState('')
  const [submissionError, setSubmissionError] = useState('')
  const closeButton = useRef<HTMLButtonElement>(null)
  const submitLock = useRef(false)
  const codes = researchAnswerSecurityCodes(conversation, message)
  const suggestedSecurity = uniqueResearchSecurity(codes, securities)
  const selectedSecurity = securities.find(item => item.stock_code === stockCode && item.market !== '指数')
  const locked = disabled || savingNote || savingAction

  useEffect(() => {
    if (!action) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [action])

  function closeAction() {
    if (!savingAction && !submitLock.current) setAction(null)
  }

  function startAction(next: 'draft' | 'observe') {
    if (locked) return
    setSubmissionError('')
    setAction(next)
    if (next === 'draft') setInstructions(researchAnswerScreeningDraft(message.content))
    else { setStockCode(suggestedSecurity?.stock_code ?? ''); setNote(researchAnswerExcerpt(message.content)); setVerification(''); setInvalidation('') }
  }

  async function submit() {
    if (!action || locked || submitLock.current || (action === 'observe' ? !selectedSecurity : !instructions.trim())) return
    submitLock.current = true
    setSubmissionError('')
    try {
      const complete = await onSubmit(action === 'draft'
        ? { kind: 'draft', instructions: instructions.trim() }
        : { kind: 'observe', stock_code: selectedSecurity!.stock_code, note: note.trim(), verification: verification.trim(), invalidation: invalidation.trim() })
      if (complete) setAction(null)
      else setSubmissionError('暂时未能保存，当前内容已保留。可以重试，或关闭此窗口查看错误详情。')
    } catch {
      setSubmissionError('暂时未能保存，当前内容已保留。请重试。')
    } finally { submitLock.current = false }
  }

  if (researchAnswerTurn(conversation, message)?.state === 'awaiting_user') {
    const index = conversation.messages.findIndex(item => item.id === message.id)
    if (conversation.messages.slice(index + 1).some(item => item.role === 'user')) return null
    return <StockText><section className="research-next-steps" aria-label="研究答复操作"><button type="button" className="primary-button" disabled={locked} onClick={onContinue}>补充研究要求<ArrowRight size={16} /></button></section></StockText>
  }

  return <StockText><section className="research-next-steps" aria-label="研究答复操作">
    <ResearchAnswerTools conversation={conversation} message={message} locked={locked} saved={saved} savingNote={savingNote}
      onSave={() => { void (async () => { if (await onSave()) setSaved(true) })() }} onCopy={onCopy}
      onObserve={() => startAction('observe')} onDraft={() => startAction('draft')} onRegenerate={onRegenerate} onBranch={onBranch} />
    {action && createPortal(<div className="research-result-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeAction() }}>
      <section className="research-result-dialog" role="dialog" aria-modal="true" aria-label={action === 'draft' ? '研究转选股草稿' : '加入研究候选观察'} onKeyDown={event => {
        if (event.key === 'Escape') {
          const target = event.target as HTMLElement
          if (target.getAttribute('role') === 'combobox' && target.getAttribute('aria-expanded') === 'true') return
          event.stopPropagation(); closeAction()
        }
        trapDialogTab(event)
      }}>
      <header className="research-result-dialog-header"><h2>{action === 'draft' ? '研究转选股草稿' : '加入研究候选观察'}</h2><button ref={closeButton} type="button" className="icon-button" aria-label="关闭研究操作" disabled={savingAction} onClick={closeAction}><X size={20} /></button></header>
      <form className="research-next-step-form" aria-label={action === 'draft' ? '研究转选股草稿' : '加入研究候选观察'} onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="research-result-dialog-body">
      {action === 'draft' ? <label>选股要求<textarea aria-label="可执行选股条件" value={instructions} maxLength={3000} rows={4} disabled={locked} onChange={event => setInstructions(event.target.value)} /></label> : <>
        <label>选择要观察的公司<div className="research-candidate-stock-search" onFocusCapture={event => { if ((event.target as HTMLElement).getAttribute('role') === 'combobox') setStockCode('') }} onInputCapture={() => setStockCode('')}><StockSearch label="观察候选股票代码" value={stockCode} onChange={setStockCode} disabled={locked} /></div></label>
        <p className="research-candidate-selection" role="status">{selectedSecurity ? `已选择：${selectedSecurity.name || selectedSecurity.stock_code}（${selectedSecurity.stock_code}）` : catalogLoading ? '正在读取公司目录…' : catalogError ? '公司目录暂未载入。' : '未选择公司。'}</p>
        <label>关注理由<textarea aria-label="观察候选备注" value={note} maxLength={2000} onChange={event => setNote(event.target.value)} disabled={locked} rows={3} /></label>
        <details className="research-candidate-plan"><summary>验证计划与失效条件</summary><label>验证事项<textarea aria-label="观察候选验证事项" value={verification} maxLength={2000} onChange={event => setVerification(event.target.value)} disabled={locked} rows={2} /></label><label>判断失效条件<textarea aria-label="观察候选失效条件" value={invalidation} maxLength={2000} onChange={event => setInvalidation(event.target.value)} disabled={locked} rows={2} /></label></details>
      </>}
      {submissionError && <p className="research-next-step-submit-error" role="alert">{submissionError}</p>}
      </div>
      <footer className="research-next-step-form-actions"><button type="submit" className="primary-button compact" disabled={locked || (action === 'draft' ? !instructions.trim() : !selectedSecurity)}>{savingAction ? '正在保存…' : action === 'draft' ? '创建选股草稿' : '保存研究候选'}</button><button type="button" className="secondary-button compact" disabled={savingAction} onClick={closeAction}>取消</button></footer>
      </form>
      </section>
    </div>, document.body)}
  </section></StockText>
}
