import { ArrowUpRight, ChartNoAxesCombined, FileSearch, Newspaper, Shapes } from 'lucide-react'
import { screeningMethods, type ScreeningMethod } from '../../screeningMethods'

export const screeningMethodIcons = { technical: ChartNoAxesCombined, pattern: Shapes, news: Newspaper, report: FileSearch }

export default function ScreeningMethodCards({ onSelect, disabled = false }: { onSelect: (method: ScreeningMethod) => void; disabled?: boolean }) {
  return <section className="screening-method-entry" aria-label="选择选股方式">
    <p>也可以从一种选股方式开始</p>
    <div className="screening-method-cards">{screeningMethods.map(method => {
      const Icon = screeningMethodIcons[method.id]
      return <button type="button" key={method.id} className="workspace-button" disabled={disabled} onClick={() => onSelect(method.id)}><Icon size={21} aria-hidden="true" /><span><strong>{method.label}</strong><small>{method.short}</small></span><ArrowUpRight size={15} aria-hidden="true" /></button>
    })}</div>
  </section>
}
