import { useEffect, useId, useState } from 'react'
import { api } from '../../api'
import './screening-templates.css'

export type ScreeningTemplate = {
  id: string; version: number; name: string; formula: string
  parameters: Record<string, { label: string; default: number; min: number; max: number; step: number }>
}
export function templateLabel(item: ScreeningTemplate, params: Record<string, number>) {
  if (item.id === 'above_sma') return `收盘价高于${params.window}日均线`
  if (item.id === 'return_above') return `近${params.window}日涨幅大于${params.threshold}%`
  if (item.id === 'ma_cross') return `${params.fast}日均线上穿${params.slow}日均线`
  return item.name
}
export default function ScreeningTemplates({ disabled, onSelect }: {
  disabled: boolean
  onSelect: (template: ScreeningTemplate, parameters: Record<string, number>) => void
}) {
  const [items, setItems] = useState<ScreeningTemplate[]>([])
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  const [selectedId, setSelectedId] = useState('')
  const previewId = useId()
  useEffect(() => {
    let active = true
    setError('')
    api<{ items: ScreeningTemplate[] }>('/screening-templates').then(result => {
      if (!Array.isArray(result.items)) throw new Error('Invalid templates')
      if (active) setItems(result.items)
    }).catch(() => { if (active) setError('基础方案暂时无法读取，可以重试或在下方描述条件。') })
    return () => { active = false }
  }, [reload])
  return <section className="screening-templates" aria-label="基础方案">
    {error && <p role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>重试读取基础方案</button></p>}
    {!error && !items.length && <p role="status">正在读取基础方案…</p>}
    <div className="screening-template-entries">{items.map(item => {
      const defaults = Object.fromEntries(Object.entries(item.parameters).map(([key, spec]) => [key, spec.default]))
      return <button key={item.id} type="button" className="secondary-button compact" aria-label={`选择基础方案：${templateLabel(item, defaults)}`} aria-expanded={selectedId === item.id} aria-controls={selectedId === item.id ? previewId : undefined} disabled={disabled} onClick={() => setSelectedId(current => current === item.id ? '' : item.id)}>{templateLabel(item, defaults)}</button>
    })}</div>
    {items.filter(item => item.id === selectedId).map(item => {
      const params = Object.fromEntries(Object.entries(item.parameters).map(([key, spec]) => [key, Number(values[item.id]?.[key] ?? spec.default)]))
      const invalid = Object.entries(item.parameters).some(([key, spec]) => values[item.id]?.[key] === '' || !Number.isFinite(params[key]) || params[key] < spec.min || params[key] > spec.max || spec.step === 1 && !Number.isInteger(params[key])) || item.id === 'ma_cross' && params.fast >= params.slow
      return <article key={item.id} id={previewId} className="screening-template-preview" aria-label="基础方案预览">
        <h3>{templateLabel(item, params)}</h3><p>按交易日收盘价计算；核对参数后生成方案，确认后才开始筛选。</p>
        <details className="screening-template-edit"><summary>调整参数<span>{Object.entries(item.parameters).map(([key, spec]) => `${spec.label} ${params[key]}`).join(" · ")}</span></summary><div className="screening-template-parameters">{Object.entries(item.parameters).map(([key, spec]) => <label key={key}>{spec.label}<input type="number" aria-label={`${item.name}：${spec.label}`} min={spec.min} max={spec.max} step={spec.step} value={values[item.id]?.[key] ?? spec.default} disabled={disabled} onChange={event => setValues(current => ({ ...current, [item.id]: { ...current[item.id], [key]: event.target.value } }))} /></label>)}</div></details>
        <details className="screening-template-explanation"><summary>公式与说明</summary><p>{item.formula}</p><p>仅使用本地日线，不依赖模型解析。复权口径待核实；历史长度或数据不足时保留为未知。</p></details>
        {invalid && <small role="alert">请填写允许范围内的数值；短周期必须小于长周期</small>}
        <button type="button" className="secondary-button compact" aria-label={`查看方案：${item.name}`} disabled={disabled || invalid} onClick={() => onSelect(item, params)}>生成可核对方案</button>
      </article>
    })}
  </section>
}
