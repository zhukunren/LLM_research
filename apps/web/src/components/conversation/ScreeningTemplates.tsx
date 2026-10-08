import { useEffect, useState } from 'react'
import { api } from '../../api'
import './screening-templates.css'

export type ScreeningTemplate = {
  id: string; version: number; name: string; formula: string
  parameters: Record<string, { label: string; default: number; min: number; max: number; step: number }>
}
export default function ScreeningTemplates({ disabled, onSelect }: {
  disabled: boolean
  onSelect: (template: ScreeningTemplate, parameters: Record<string, number>) => void
}) {
  const [items, setItems] = useState<ScreeningTemplate[]>([])
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  useEffect(() => {
    let active = true
    setError('')
    api<{ items: ScreeningTemplate[] }>('/screening-templates').then(result => {
      if (active) setItems(result.items)
    }).catch(() => { if (active) setError('基础方案暂时无法读取，可以重试或在下方描述条件。') })
    return () => { active = false }
  }, [reload])
  return <section className="screening-templates" aria-label="基础方案">
    <div><h3>从基础方案开始</h3><p>参数直接生成可核对的日线条件，无需模型解析；确认后才会筛选</p></div>
    {error && <p role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>重试读取基础方案</button></p>}
    {!error && !items.length && <p role="status">正在读取基础方案…</p>}
    <div className="screening-template-grid">{items.map(item => {
      const params = Object.fromEntries(Object.entries(item.parameters).map(([key, spec]) => [key, Number(values[item.id]?.[key] ?? spec.default)]))
      const invalid = Object.entries(item.parameters).some(([key, spec]) => values[item.id]?.[key] === '' || !Number.isFinite(params[key]) || params[key] < spec.min || params[key] > spec.max || spec.step === 1 && !Number.isInteger(params[key])) || item.id === 'ma_cross' && params.fast >= params.slow
      return <article key={item.id} className="screening-template-card">
        <h4>{item.name}</h4><p>{item.formula}</p>
        <div className="screening-template-parameters">{Object.entries(item.parameters).map(([key, spec]) => <label key={key}>{spec.label}<input type="number" aria-label={`${item.name}：${spec.label}`} min={spec.min} max={spec.max} step={spec.step} value={values[item.id]?.[key] ?? spec.default} disabled={disabled} onChange={event => setValues(current => ({ ...current, [item.id]: { ...current[item.id], [key]: event.target.value } }))} /></label>)}</div>
        {invalid && <small role="alert">请填写允许范围内的数值；短周期必须小于长周期</small>}
        <button type="button" className="secondary-button compact" disabled={disabled || invalid} onClick={() => onSelect(item, params)}>查看方案：{item.name}</button>
      </article>
    })}</div>
    <small>仅使用本地日线，复权口径待核实；数据不足保留为未知。指标条件不代表投资建议</small>
  </section>
}
