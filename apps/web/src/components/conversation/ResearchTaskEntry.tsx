import { useEffect, useId, useRef, useState } from 'react'
import { ArrowUpRight, Building2, FileSearch, ListFilter } from 'lucide-react'
import StockSearch, { useSecurities } from '../StockSearch'
import { isText, useSessionState } from '../../useSessionState'
import './research-task-entry.css'

const directions = ['经营变化', '主要风险', '同行比较'] as const
type Direction = typeof directions[number]

export default function ResearchTaskEntry({ draft, draftKey, disabled, onPrompt, onScreening, onReports }: {
  draft: string; draftKey: string; disabled: boolean; onPrompt: (prompt: string) => void; onScreening?: () => void; onReports: () => void
}) {
  const [companyOpen, setCompanyOpen] = useState(false)
  const companyPanel = useRef<HTMLElement>(null)
  const companyPanelId = useId()
  const [stockCode, setStockCode] = useState('')
  const [direction, setDirection] = useState<Direction>('经营变化')
  const [generated, setGenerated] = useSessionState(`research.starter.${draftKey}`, '', isText)
  const [suggestion, setSuggestion] = useState('')
  const appendedDraft = draft ? `${draft}\n\n${suggestion}` : suggestion
  const { items } = useSecurities()
  useEffect(() => {
    const panel = companyPanel.current
    if (companyOpen && panel?.closest('.mobile-app-shell')) panel.scrollIntoView?.({ block: 'nearest' })
  }, [companyOpen])
  function apply(prompt: string, nextDraft: string) {
    if (nextDraft.length > 8000) { setSuggestion(prompt); return }
    setGenerated(prompt)
    setSuggestion('')
    onPrompt(nextDraft)
  }
  function prepare(code: string, nextDirection: Direction) {
    const stock = items.find(item => item.stock_code === code && item.market !== '指数')
    if (!stock) return
    const request = nextDirection === '主要风险' ? '分析主要经营风险、反方证据，以及哪些变化会使当前判断失效。'
      : nextDirection === '同行比较' ? '选择业务可比的同行，比较经营表现、估值与主要风险，说明可比性和数据差异。'
        : '分析最近的经营变化、关键依据与主要风险，列出接下来需要验证的事项。'
    const prompt = `请帮我看懂${stock.name}（${stock.stock_code}）：${request}区分事实与推断，标明报告期、数据日期和来源。`
    if (!draft.trim()) apply(prompt, prompt)
    else if (generated && draft.includes(generated)) apply(prompt, draft.replace(generated, () => prompt))
    else setSuggestion(prompt)
  }
  return <div className="research-task-entry">
    <p className="research-task-intro">选择一个方向，或直接输入你的问题。</p>
    <h2 className="mobile-research-task-heading">常用任务</h2>
    <div className="research-task-options" role="group" aria-label="开始投资研究">
      <button type="button" className="research-task-option workspace-button" disabled={disabled} aria-expanded={companyOpen} aria-controls={companyOpen ? companyPanelId : undefined} onClick={() => setCompanyOpen(value => !value)}><Building2 size={22} aria-hidden="true" /><span><strong>看懂一只股票</strong><small>了解经营变化、依据与风险</small></span><ArrowUpRight size={16} aria-hidden="true" /></button>
      <button type="button" className="research-task-option workspace-button" disabled={disabled || !onScreening} onClick={onScreening}><ListFilter size={22} aria-hidden="true" /><span><strong>按条件找股票</strong><small>描述要求，查看符合规则的名单</small></span><ArrowUpRight size={16} aria-hidden="true" /></button>
      <button type="button" className="research-task-option workspace-button" disabled={disabled} onClick={onReports}><FileSearch size={22} aria-hidden="true" /><span><strong>读懂一份研报</strong><small>选取资料，核对判断与原文</small></span><ArrowUpRight size={16} aria-hidden="true" /></button>
    </div>
    {companyOpen && <section ref={companyPanel} id={companyPanelId} className="research-task-company" aria-label="选择研究公司">
      <label className="workspace-field-label">想了解哪家公司？<StockSearch label="搜索研究公司名称或代码" value={stockCode} disabled={disabled} onSelectionPending={() => { setStockCode(''); setSuggestion('') }} onChange={code => { setStockCode(code); prepare(code, direction) }} /></label>
      <div className="research-task-directions" role="group" aria-label="关注方向">{directions.map(item => <button key={item} type="button" className="workspace-button" aria-pressed={item === direction} disabled={disabled} onClick={() => { setDirection(item); if (stockCode) prepare(stockCode, item) }}>{item}</button>)}</div>
      {suggestion ? <div className="research-draft-suggestion">
        <p role="status">现有草稿已保留。可把下面的提问追加到末尾。</p>
        <p>{suggestion}</p>
        <button type="button" className="secondary-button workspace-button" disabled={disabled || appendedDraft.length > 8000}
          onClick={() => apply(suggestion, appendedDraft)}>追加到草稿</button>
        {appendedDraft.length > 8000 && <p>草稿最多 8000 字，请先精简内容。</p>}
      </div> : <p>选择公司可准备提问，点击“发送”开始研究。</p>}
    </section>}
  </div>
}
