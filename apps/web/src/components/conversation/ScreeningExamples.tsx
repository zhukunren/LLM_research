import { useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import type { ConversationScope } from '../../api'
import './screening-examples.css'

export type ScreeningExampleItem = { label: string; goal: string; prompt: string }
export type ScreeningExampleGroup = { id: ConversationScope; label: string; items: ScreeningExampleItem[] }

type Props = {
  groups: ScreeningExampleGroup[]
  disabled: boolean
  modelUnavailable?: boolean
  onSelect: (prompt: string) => void
}

/**
 * First-run example map. The fixed starters above cover the deterministic
 * path; these examples show the breadth that needs the model to translate a
 * goal into conditions. Selecting one only fills the draft, never executes.
 */
export default function ScreeningExamples({ groups, disabled, modelUnavailable = false, onSelect }: Props) {
  const [active, setActive] = useState<ConversationScope>(groups[0]?.id ?? 'technical')
  if (!groups.length) return null
  const current = groups.find(group => group.id === active) ?? groups[0]
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  return <section className="screening-examples" aria-label="更多选股示例">
    <div className="screening-examples-heading">
      <div>
        <h2>看看还能筛什么</h2>
        <p>选一个目标填入草稿；标“模型理解”的示例会由模型拆成条件，发送前仍可修改。</p>
      </div>
      <span className="screening-examples-count">共 {total} 个示例</span>
    </div>
    <div className="screening-example-tabs" role="group" aria-label="选股示例分类">
      {groups.map(group => <button key={group.id} type="button" aria-pressed={current.id === group.id} onClick={() => setActive(group.id)} className="workspace-button">{group.label}</button>)}
    </div>
    <div className="screening-example-grid" role="group" aria-label={current.label}>
      {current.items.map(item => <button key={item.label} type="button" aria-label={item.goal} disabled={disabled || modelUnavailable} onClick={() => onSelect(item.prompt)} className="screening-example-card workspace-button">
        <span className="screening-example-kind">模型理解</span>
        <strong>{item.goal}</strong>
        <span className="screening-example-prompt">{item.prompt}</span>
        <ArrowUpRight size={14} aria-hidden="true" />
      </button>)}
    </div>
    {modelUnavailable && <p className="screening-example-offline workspace-feedback-inline" role="status">模型暂不可用，示例暂时无法解析；可先使用上方的固定规则方案。</p>}
  </section>
}
