import { useState } from 'react'
import type { ScreeningTaskRevision } from '../../api'
import './screening-clarifications.css'

type Unresolved = ScreeningTaskRevision['unresolved'][number]

type Props = {
  items: Unresolved[]
  disabled: boolean
  onCompose: (text: string) => void
  actionLabel?: string
  helpText?: string
}

const kindLabels: Record<string, string> = {
  ambiguous: '需要确认',
  unsupported: '数据暂不支持',
  missing_data: '缺少数据',
  conflict: '条件冲突',
}

/**
 * Turn unresolved questions into answerable cards. Answers are composed into
 * the composer instead of being submitted directly, so an unsent draft or
 * attachment is never lost and the user can still choose preview or re-run.
 */
export default function ScreeningClarifications({ items, disabled, onCompose, actionLabel = '把回答填入输入框', helpText = '填写后只会把回答填入输入框，不会自动开始筛选；确认后再选择只改方案或重新筛选。' }: Props) {
  const [answers, setAnswers] = useState<Record<number, string>>({})
  if (!items.length) return null
  const filled = items
    .map((item, index) => ({ item, answer: (answers[index] ?? '').trim() }))
    .filter(entry => entry.answer)
  function compose() {
    if (!filled.length) return
    const lines = filled.map(({ item, answer }) => `- ${item.question}\n  ${answer}`)
    onCompose(`请根据以下回答修改筛选方案：\n${lines.join('\n')}`)
  }
  return <section className="screening-clarifications" aria-label="待澄清问题">
    <div className="screening-clarifications-heading">
      <h3>还需要你确认 {items.length} 件事</h3>
      <p>{helpText}</p>
    </div>
    {items.map((item, index) => <article className="screening-clarification-card" key={`${item.source_quote}-${index}`}>
      <div className="screening-clarification-meta">
        <span className="screening-clarification-kind">{kindLabels[item.kind] ?? '需要补充'}</span>
        {item.source_quote && <q>{item.source_quote}</q>}
      </div>
      <strong>{item.question}</strong>
      {item.suggestion && <p>{item.suggestion}</p>}
      <label className="workspace-field-label">
        <span>你的回答</span>
        <input
          className="workspace-field"
          aria-label={`回答：${item.question}`}
          value={answers[index] ?? ''}
          disabled={disabled}
          placeholder="输入选择或补充说明"
          onChange={event => setAnswers(current => ({ ...current, [index]: event.target.value }))}
        />
      </label>
    </article>)}
    <div className="screening-clarifications-actions">
      <button type="button" className="primary-button compact workspace-button" disabled={disabled || !filled.length} onClick={compose}>{actionLabel}</button>
      <span>填写一条即可；其余问题可以继续补充。</span>
    </div>
  </section>
}
