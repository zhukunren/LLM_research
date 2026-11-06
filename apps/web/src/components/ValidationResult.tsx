import { AlertCircle, AlertTriangle, Info } from 'lucide-react'
import type { AdvisorValidationResult } from '../intelligence'

export function ValidationResult({ validation }: { validation: AdvisorValidationResult }) {
  const hasErrors = validation.errors.length > 0
  const hasWarnings = validation.warnings.length > 0
  if (!hasErrors && !hasWarnings && validation.suggestions.length === 0) return null

  return <section className="advisor-validation" data-tone={hasErrors ? 'error' : hasWarnings ? 'warning' : 'suggestion'} aria-label="投顾校验提示" aria-live="polite">
    <h3>{hasErrors ? <AlertCircle size={16} /> : hasWarnings ? <AlertTriangle size={16} /> : <Info size={16} />}
      {hasErrors ? '存在校验错误，请重新生成' : hasWarnings ? '交付前请核对' : '表达建议'}</h3>
    {!hasErrors && <p>以下提示不阻止保存和复制，交付前请由投顾核对。</p>}
    {validation.errors.length > 0 && <div><h4>错误</h4><ul>{validation.errors.map((error, index) => <li key={index}>{error}</li>)}</ul></div>}
    {hasWarnings && <div><h4>待核验事项</h4><ul>{validation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    {validation.suggestions.length > 0 && <div><h4>建议</h4><ul>{validation.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}</ul></div>}
  </section>
}
