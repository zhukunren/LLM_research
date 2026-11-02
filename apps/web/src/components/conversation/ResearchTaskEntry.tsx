import { useState } from 'react'
import { ArrowUpRight, Building2, FileSearch, ListFilter } from 'lucide-react'
import StockSearch, { useSecurities } from '../StockSearch'
import './research-task-entry.css'

const directions = ['经营变化', '主要风险', '同行比较'] as const
type Direction = typeof directions[number]

export default function ResearchTaskEntry({ disabled, onPrompt, onScreening, onReports }: {
  disabled: boolean; onPrompt: (prompt: string) => void; onScreening?: () => void; onReports: () => void
}) {
  const [companyOpen, setCompanyOpen] = useState(false)
  const [stockCode, setStockCode] = useState('')
  const [direction, setDirection] = useState<Direction>('经营变化')
  const { items } = useSecurities()
  function prepare(code: string, nextDirection: Direction) {
    const stock = items.find(item => item.stock_code === code && item.market !== '指数')
    if (!stock) return
    const request = nextDirection === '主要风险' ? '分析主要经营风险、反方证据，以及哪些变化会使当前判断失效。'
      : nextDirection === '同行比较' ? '选择业务可比的同行，比较经营表现、估值与主要风险，说明可比性和数据差异。'
        : '分析最近的经营变化、关键依据与主要风险，列出接下来需要验证的事项。'
    onPrompt(`请帮我看懂${stock.name}（${stock.stock_code}）：${request}区分事实与推断，标明报告期、数据日期和来源。`)
  }
  return <div className="research-task-entry">
    <p className="research-task-intro">选一件想做的事，也可以直接在下方提问。</p>
    <div className="research-task-options" role="group" aria-label="开始投资研究">
      <button type="button" className="research-task-option workspace-button" disabled={disabled} aria-expanded={companyOpen} onClick={() => setCompanyOpen(value => !value)}><Building2 size={22} aria-hidden="true" /><span><strong>看懂一只股票</strong><small>了解经营变化、依据与风险</small></span><ArrowUpRight size={16} aria-hidden="true" /></button>
      <button type="button" className="research-task-option workspace-button" disabled={disabled || !onScreening} onClick={onScreening}><ListFilter size={22} aria-hidden="true" /><span><strong>按条件找股票</strong><small>描述要求，查看符合规则的名单</small></span><ArrowUpRight size={16} aria-hidden="true" /></button>
      <button type="button" className="research-task-option workspace-button" disabled={disabled} onClick={onReports}><FileSearch size={22} aria-hidden="true" /><span><strong>读懂一份研报</strong><small>选取资料，核对判断与原文</small></span><ArrowUpRight size={16} aria-hidden="true" /></button>
    </div>
    {companyOpen && <section className="research-task-company" aria-label="选择研究公司">
      <label className="workspace-field-label">想了解哪家公司？<StockSearch label="搜索研究公司名称或代码" value={stockCode} disabled={disabled} onSelectionPending={() => setStockCode('')} onChange={code => { setStockCode(code); prepare(code, direction) }} /></label>
      <div className="research-task-directions" role="group" aria-label="关注方向">{directions.map(item => <button key={item} type="button" className="workspace-button" aria-pressed={item === direction} disabled={disabled} onClick={() => { setDirection(item); if (stockCode) prepare(stockCode, item) }}>{item}</button>)}</div>
      <p>选择公司后会填入可编辑的问题，点击“发送”开始研究。</p>
    </section>}
  </div>
}
