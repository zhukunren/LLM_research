import { ArrowUpRight, ChartNoAxesCombined, FileSearch, GitCompareArrows } from 'lucide-react'
import './research-starters.css'

type Starter = { label: string; prompt: string; description?: string }
const icons = [ChartNoAxesCombined, GitCompareArrows, FileSearch]

/** A shortcut only prepares an editable question; it never starts a task. */
export default function ResearchStarters({ items, disabled, onSelect }: {
  items: Starter[]
  disabled: boolean
  onSelect: (prompt: string) => void
}) {
  return <div className="research-start-options" role="group" aria-label="常用研究问题">
    {items.map((item, index) => {
      const Icon = icons[index % icons.length]
      return <button key={item.label} type="button" className="research-start-option" aria-label={item.label}
        title={`填入问题：${item.prompt}`} disabled={disabled} onClick={() => onSelect(item.prompt)}>
        <Icon className="research-start-icon" size={21} strokeWidth={1.6} aria-hidden="true" />
        <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
        <ArrowUpRight className="research-start-arrow" size={16} aria-hidden="true" />
      </button>
    })}
  </div>
}
