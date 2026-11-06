import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FlaskConical, RefreshCw } from 'lucide-react'
import { api } from '../../api'
import { isText, useSessionState } from '../../useSessionState'
import { templateDescription } from '../../screeningMethods'
import type { ScreeningTemplate } from '../conversation/ScreeningTemplates'
import StockSearch from '../StockSearch'
import { ResponsiveMarketIndicatorChart, type IndicatorChart } from '../MarketIndicatorChart'

const validValues = (value: unknown): value is Record<string, Record<string, string>> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => !!item && typeof item === 'object' && !Array.isArray(item) && Object.values(item).every(field => typeof field === 'string'))

export function useTechnicalRules(enabled: boolean, key: string, singlesOnly = false) {
  const [items, setItems] = useState<ScreeningTemplate[]>([])
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0)
  const [selectedId, setSelectedId] = useSessionState(`${key}.template`, 'trend_momentum', isText)
  const [values, setValues] = useSessionState(`${key}.parameters`, {}, validValues)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setLoading(true); setError('')
    api<{ items: ScreeningTemplate[] }>('/screening-templates?include_singles=true' + (singlesOnly ? '&singles_only=true' : ''), { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setItems(result.items)
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [enabled, retry, singlesOnly])
  const selected = items.find(item => item.id === selectedId) ?? items[0]
  const parameters = useMemo(() => selected ? Object.fromEntries(Object.entries(selected.parameters).map(([name, spec]) => [name, Number(values[selected.id]?.[name] ?? spec.default)])) : {}, [selected, values])
  const invalid = !selected || Object.entries(selected.parameters).some(([name, spec]) => values[selected.id]?.[name] === '' || !Number.isFinite(parameters[name]) || parameters[name] < spec.min || parameters[name] > spec.max || spec.step === 1 && !Number.isInteger(parameters[name])) || 'fast' in parameters && parameters.fast >= parameters.slow
  return { items, selected, parameters, values, invalid, loading, error, retry: () => setRetry(value => value + 1), select: setSelectedId,
    change: (name: string, value: string) => { if (selected) setValues(current => ({ ...current, [selected.id]: { ...current[selected.id], [name]: value } })) } }
}

export type TechnicalRules = ReturnType<typeof useTechnicalRules>

export function TechnicalRuleFields({ rules, disabled }: { rules: TechnicalRules; disabled?: boolean }) {
  return <div className="technical-rule-editor">
    {rules.loading && <p role="status">正在读取技术规则…</p>}
    {rules.error && <p role="alert" className="workspace-error">{rules.error}<button type="button" className="text-button workspace-button" onClick={rules.retry}>重新读取规则</button></p>}
    <div className="technical-rule-options" role="group" aria-label="选择技术规则">{rules.items.map(item => <button type="button" className="workspace-button" key={item.id} disabled={disabled} aria-pressed={rules.selected?.id === item.id} onClick={() => rules.select(item.id)}>{item.name}{rules.selected?.id === item.id && <Check size={15} aria-hidden="true" />}</button>)}</div>
    {rules.selected && <>
      <div className="technical-rule-parameters">{Object.entries(rules.selected.parameters).map(([name, spec]) => <label className="workspace-field-label" key={name}>{spec.label}<input type="number" className="workspace-field" aria-label={spec.label} min={spec.min} max={spec.max} step={spec.step} disabled={disabled} value={rules.values[rules.selected!.id]?.[name] ?? spec.default} onChange={event => rules.change(name, event.target.value)} /></label>)}</div>
      <div className="technical-rule-formula"><span>规则口径</span><p>{templateDescription(rules.selected, rules.parameters)}</p></div>
      {rules.invalid && <p role="alert" className="workspace-inline-error">请填写允许范围内的参数；短均线周期必须小于长周期。</p>}
    </>}
  </div>
}

type Preview = { stock_code: string; requested_as_of: string; actual_date: string | null; state: 'true' | 'false' | 'unknown'; details: { name: string; state: string; reason?: string; actual?: number | Record<string, number> | null; threshold?: number | null; unit?: string }[]; chart: IndicatorChart }
const stateLabels: Record<string, string> = { true: '符合', false: '不符合', unknown: '数据不足' }

export function TechnicalRuleTrial({ rules, asOf, disabled }: { rules: TechnicalRules; asOf: string; disabled?: boolean }) {
  const [stock, setStock] = useSessionState('screening.technical.trialStock', '600000.SH', isText)
  const [result, setResult] = useState<{ key: string; preview: Preview } | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const request = useRef<AbortController | null>(null)
  const key = JSON.stringify([rules.selected?.id, rules.selected?.version, rules.parameters, stock, asOf])
  const currentKey = useRef(key); currentKey.current = key
  useEffect(() => { request.current?.abort(); setBusy(false); setError(''); return () => request.current?.abort() }, [key])
  async function preview() {
    if (!rules.selected || rules.invalid || !/^\d{6}\.(SH|SZ|BJ)$/.test(stock) || !asOf || busy) return
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    setBusy(true); setError('')
    try {
      const value = await api<Preview>(`/screening-templates/${rules.selected.id}/preview`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ version: rules.selected.version, parameters: rules.parameters, stock_code: stock, as_of: asOf }) })
      if (!controller.signal.aborted && currentKey.current === key) setResult({ key, preview: value })
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const current = result?.key === key ? result.preview : null
  return <section className="technical-rule-trial" aria-label="单股试算">
    <header><FlaskConical size={19} /><div><h2>先用一只股票试算</h2><p>按当前规则与截止日期核对行情。</p></div></header>
    <div className="technical-trial-controls"><StockSearch label="技术规则试算股票" value={stock} disabled={disabled || busy} onSelectionPending={() => setStock('')} onChange={setStock} /><button type="button" className="secondary-button workspace-button" disabled={disabled || busy || rules.invalid || !asOf || !/^\d{6}\.(SH|SZ|BJ)$/.test(stock)} onClick={() => void preview()}>{busy ? <RefreshCw size={15} className="spin" /> : <FlaskConical size={15} />}{busy ? '试算中…' : '试算规则'}</button></div>
    {error && <p role="alert" className="workspace-error">{error}</p>}
    {result && !current && <p role="status" className="technical-trial-note">参数或证券已改变，请重新试算。</p>}
    {current ? <>
      <div className="technical-trial-result"><strong className={`technical-trial-state is-${current.state}`}>{stateLabels[current.state]}</strong><span>行情日 {current.actual_date || '暂无'} · 截止 {current.requested_as_of}</span></div>
      {current.chart.bars.length > 0 && <ResponsiveMarketIndicatorChart chart={current.chart} height={230} minHeight={180} />}
      <ul className="technical-trial-details">{current.details.map((item, index) => <li key={index}><div><strong>{item.name}</strong><span>{stateLabels[item.state]}</span></div>{item.reason ? <p>{item.reason}</p> : item.actual != null && <p>计算值：{typeof item.actual === 'number' ? Number(item.actual.toFixed(4)) + (item.unit || '') : Object.entries(item.actual).map(([name, value]) => `${name === 'fast' ? '短均线' : name === 'slow' ? '长均线' : name} ${Number(value.toFixed(4))}`).join(' · ')}{item.threshold != null ? ` · 比较值 ${Number(item.threshold.toFixed(4))}` : ''}</p>}</li>)}</ul>
    </> : !busy && <div className="technical-trial-empty"><FlaskConical size={26} /><p>选择股票并试算，查看符合情况、计算值与走势图。</p></div>}
    <p className="technical-trial-note">试算使用本地未复权日线；批量筛选仍逐只核对数据完整性。</p>
  </section>
}
