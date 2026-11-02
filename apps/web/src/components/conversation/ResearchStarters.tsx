import { ArrowUpRight, ChartNoAxesCombined, FileSearch, GitCompareArrows, type LucideIcon } from 'lucide-react'
import './research-starters.css'

type Starter = { label: string; prompt: string; description?: string; icon?: LucideIcon }
const icons = [ChartNoAxesCombined, GitCompareArrows, FileSearch]

/** A shortcut only prepares an editable question; it never starts a task. */
export default function ResearchStarters({ items, disabled, onSelect, groupLabel = '常用研究问题' }: {
  items: Starter[]
  groupLabel?: string
  disabled: boolean
  onSelect: (prompt: string) => void
}) {
  return <div className="research-start-options" role="group" aria-label={groupLabel}>
    {items.map((item, index) => {
      const Icon = item.icon ?? icons[index % icons.length]
      return <button key={item.label} type="button" className="research-start-option workspace-button" aria-label={item.label}
        data-tooltip={`填入问题：${item.prompt}`} disabled={disabled} onClick={() => onSelect(item.prompt)}>
        <Icon className="research-start-icon" size={21} strokeWidth={1.6} aria-hidden="true" />
        <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
        <ArrowUpRight className="research-start-arrow" size={16} aria-hidden="true" />
      </button>
    })}
  </div>
}
