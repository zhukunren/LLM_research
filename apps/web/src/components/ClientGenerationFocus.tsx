import { generationFocusLimit } from '../clientService'

const focusLabel = '关注点（Prompt）'

export default function ClientGenerationFocus({ value, onChange, example, disabled, submitted }: {
  value: string; onChange: (value: string) => void; example: string; disabled?: boolean; submitted?: string
}) {
  return <div className="client-generation-options">
    <details>
      <summary>{focusLabel}{value.trim() && <span>已填写</span>}</summary>
      <textarea className="workspace-field" aria-label={focusLabel} rows={2} maxLength={generationFocusLimit}
        value={value} disabled={disabled} placeholder={example} onChange={event => onChange(event.target.value)} />
    </details>
    {submitted && <p className="client-submitted-focus">已提交关注点 · {submitted}</p>}
  </div>
}
