import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, LoaderCircle, Play, Save } from 'lucide-react'
import { api, type DataStatus, type Filter, type Pattern } from '../api'
import StockSearch from './StockSearch'
import { useSessionState, isText } from '../useSessionState'
import { TechnicalRuleFields, useTechnicalRules } from './screening/TechnicalRuleEditor'
import { screeningMethodIcons } from './screening/ScreeningMethodCards'
import { ResponsiveMarketIndicatorChart, type IndicatorChart } from './MarketIndicatorChart'
import type { Node } from '../pages/StrategyPage'
import './reusable-condition-creator.css'

const types = [{ id: 'technical', label: '技术条件' }, { id: 'pattern', label: '形态条件' }, { id: 'news', label: '资讯条件' }, { id: 'report', label: '研报条件' }] as const
type Kind = typeof types[number]['id']
type Definition = { kind: 'technical'; template_id: string; template_version: number; parameters: Record<string, number> }
  | { kind: 'pattern'; pattern_id: string; pattern_version: number; minimum_similarity: number; match_mode: string; recent_bars: number }
  | { kind: 'news' | 'report'; question: string; fact_requirement: string; event_requirement: string; lookback_calendar_days: number; numeric_requirement: boolean; quantifier: string; minimum_independent_events: number }
type Trial = { builder_draft_id: string; definition: Definition; description: string; sample: { stock_code: string; as_of: string }; verified_at: string; result: { state: string; reason?: string; actual_date?: string; similarity?: number; threshold?: number; chart?: IndicatorChart; details?: { name: string; state: string; reason?: string }[]; evidence?: Record<string, unknown>[]; candidate_points?: number[]; template_points?: number[] } }
export type SavedReusableCondition = { asset_kind: 'filter' | 'pattern'; asset: Filter | Pattern; reference: Node }
type CachedTrial = Trial & { request_key: string; saved?: SavedReusableCondition }
const record = (value: unknown): value is Record<string, string> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string')
const trialRecord = (value: unknown): value is Record<string, CachedTrial> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item && typeof item.builder_draft_id === 'string' && typeof item.request_key === 'string' && item.definition && typeof item.result?.state === 'string')
const stateLabel = (value: string) => ({ true: '符合', false: '不符合', unknown: '数据不足' }[value] || value)
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)

export function ConditionSampleProof({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null
  const proof = value as Record<string, unknown>, sample = proof.sample as Record<string, unknown> | undefined
  if (proof.created_by !== 'condition_builder' || !sample) return null
  const verified = new Date(String(proof.verified_at))
  const verifiedAt = Number.isNaN(verified.getTime()) ? '时间未记录' : verified.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  return <details className="condition-sample-proof"><summary>创建时的样本验证</summary><p>{String(sample.stock_code)} · 截至 {String(sample.as_of)} · 当时结果：{stateLabel(String(proof.sample_state))}</p><p>验证时间：{verifiedAt}（北京时间）。其他公司、日期和修改后的参数需要重新判断。</p></details>
}

export function PatternPathChart({ target, candidate, label }: { target: number[]; candidate?: number[]; label: string }) {
  const finite = (values: number[]) => values.length > 1 && values.every(Number.isFinite)
  if (!finite(target) || candidate && !finite(candidate)) return null
  const all = [...target, ...(candidate || [])], low = Math.min(...all), high = Math.max(...all), range = high - low || 1
  const path = (values: number[]) => values.map((value, index) => `${16 + index / (values.length - 1) * 368},${116 - (value - low) / range * 100}`).join(' ')
  return <figure className="condition-path-chart"><svg viewBox="0 0 400 144" role="img" aria-label={label}><polyline points={path(target)} fill="none" stroke="var(--ui-primary)" strokeWidth="2" />{candidate && <polyline points={path(candidate)} fill="none" stroke="var(--ui-warning)" strokeWidth="2" />}<text x="16" y="140">区间进度</text></svg><figcaption>{label} · 纵向为归一化价格{candidate ? ' · 蓝线：目标；棕线：样本' : ''}</figcaption></figure>
}

export default function ReusableConditionCreator({ data, patterns, busy: parentBusy = false, customEditor, onSaved, onUse, onOpenPatterns }: {
  data: DataStatus | null; patterns: Pattern[]; busy?: boolean; customEditor: ReactNode
  onSaved: (saved: SavedReusableCondition) => void; onUse: (reference: Node) => void; onOpenPatterns?: () => void
}) {
  const [kind, setKind] = useSessionState<Kind>('condition.creator.kind', 'technical', (value): value is Kind => types.some(item => item.id === value))
  const [mode, setMode] = useSessionState('condition.creator.technicalMode', 'rules', isText)
  const [fields, setFields] = useSessionState<Record<string, string>>('condition.creator.fields', {}, record)
  const [trials, setTrials] = useSessionState<Record<string, CachedTrial>>('condition.creator.trials', {}, trialRecord)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true), lock = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort() } }, [])
  const rules = useTechnicalRules(kind === 'technical', 'condition.creator.technical', true)
  const get = (key: string, fallback = '') => fields[`${kind}.${key}`] ?? fallback
  const set = (key: string, value: string) => setFields(current => ({ ...current, [`${kind}.${key}`]: value }))
  const patternKey = get('pattern'), selectedPattern = patterns.find(item => `${item.id}@${item.version}` === patternKey)
  const recentSupported = !selectedPattern || ['path-window-v2', 'candle-window-v2'].includes(selectedPattern.algorithm_version || '')
  const lookback = Number(get('lookback', kind === 'report' ? '365' : '30'))
  const threshold = Number(get('threshold', String(selectedPattern?.params.min_similarity ?? 80)))
  const recent = Number(get('recent', String(selectedPattern?.params.recent_bars ?? 20)))
  const minimumEvents = Number(get('minimumEvents', '1'))
  const matchMode = get('matchMode', selectedPattern?.params.match_mode === 'recent' ? 'recent' : 'current')
  const sampleCode = get('sampleCode'), asOf = get('asOf', kind === 'technical' || kind === 'pattern' ? data?.last_date || '' : today())
  let definition: Definition | null = null
  if (kind === 'technical' && rules.selected && !rules.invalid) definition = { kind, template_id: rules.selected.id, template_version: rules.selected.version, parameters: rules.parameters }
  if (kind === 'pattern' && selectedPattern && (matchMode === 'current' || recentSupported) && get('threshold', String(threshold)).trim() && get('recent', String(recent)).trim() && Number.isFinite(threshold) && threshold >= 0 && threshold <= 100 && Number.isInteger(recent) && recent >= 1 && recent <= 120) definition = { kind, pattern_id: selectedPattern.id, pattern_version: selectedPattern.version, minimum_similarity: threshold, match_mode: matchMode, recent_bars: recent }
  if ((kind === 'news' || kind === 'report') && get('question').trim() && Number.isInteger(lookback) && lookback >= 1 && lookback <= 3650 && Number.isInteger(minimumEvents) && minimumEvents >= 1 && minimumEvents <= 100) definition = { kind, question: get('question').trim(), fact_requirement: get('basis', 'actual'), event_requirement: kind === 'news' ? get('event', 'any') : 'any', lookback_calendar_days: lookback, numeric_requirement: get('numeric') === 'true', quantifier: get('quantifier', 'exists'), minimum_independent_events: kind === 'news' ? minimumEvents : 1 }
  const requestKey = JSON.stringify({ definition, stock_code: sampleCode, as_of: asOf })
  const trial = trials[kind], current = !!definition && trial?.request_key === requestKey
  const saved = current ? trial?.saved : undefined
  const name = get('name', trial?.description.slice(0, 60) || '')
  const invalidDate = !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf > today() || !!data?.last_date && (kind === 'technical' || kind === 'pattern') && asOf > data.last_date
  const disabled = parentBusy || !!busy

  async function preview() {
    if (lock.current || disabled || !definition || !sampleCode || invalidDate) return
    const selectedKind = kind, key = requestKey
    set('asOf', asOf)
    lock.current = true; setBusy('preview'); setError('')
    setTrials(previous => previous[selectedKind] ? { ...previous, [selectedKind]: { ...previous[selectedKind], request_key: '' } } : previous)
    controller.current = new AbortController()
    try {
      const result = await api<Trial>('/condition-builder/preview', { method: 'POST', signal: controller.current.signal, body: JSON.stringify({ definition, stock_code: sampleCode, as_of: asOf }) })
      if (mounted.current) setTrials(previous => ({ ...previous, [selectedKind]: { ...result, request_key: key } }))
    } catch (reason) { if (mounted.current && !controller.current.signal.aborted) setError((reason as Error).message) }
    finally { lock.current = false; if (mounted.current) setBusy('') }
  }
  async function save() {
    if (lock.current || disabled || !current || !trial || !name.trim() || saved) return
    const selectedKind = kind
    lock.current = true; setBusy('save'); setError('')
    try {
      const result = await api<SavedReusableCondition>('/condition-builder/save', { method: 'POST', body: JSON.stringify({ builder_draft_id: trial.builder_draft_id, definition, name: name.trim() }) })
      if (mounted.current) { setTrials(previous => ({ ...previous, [selectedKind]: { ...trial, saved: result } })); onSaved(result) }
    } catch (reason) { if (mounted.current) setError((reason as Error).message) }
    finally { lock.current = false; if (mounted.current) setBusy('') }
  }

  return <div className="reusable-condition-creator">
    <div className="reusable-condition-types" role="group" aria-label="条件创建类型">{types.map(item => { const Icon = screeningMethodIcons[item.id]; return <button key={item.id} type="button" className="workspace-button" aria-pressed={kind === item.id} disabled={disabled} onClick={() => { setKind(item.id); setError('') }}><Icon size={17} />{item.label}</button> })}</div>
    <p className="condition-creator-intro">定义一项可复用判断，核对样本后保存。股票范围和执行日期在选股时另行设置。</p>
    {kind === 'technical' && <div className="screening-rule-mode" role="group" aria-label="技术条件创建方式"><button className="workspace-button" type="button" aria-pressed={mode !== 'describe'} disabled={disabled} onClick={() => setMode('rules')}>选择规则与参数</button><button className="workspace-button" type="button" aria-pressed={mode === 'describe'} disabled={disabled} onClick={() => setMode('describe')}>描述自定义条件</button></div>}
    {kind === 'technical' && mode === 'describe' ? customEditor : <>
      {kind === 'technical' && <TechnicalRuleFields rules={rules} disabled={disabled || !!saved} />}
      {kind === 'pattern' && <div className="condition-pattern-fields">
        <label className="workspace-field-label">已有形态模板<select className="workspace-field" aria-label="条件形态模板" disabled={disabled || !!saved} value={patternKey} onChange={event => set('pattern', event.target.value)}><option value="">选择一个固定版本</option>{patterns.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name} · v{item.version}</option>)}</select></label>
        {selectedPattern && <PatternPathChart target={selectedPattern.points} label={`${selectedPattern.name} · v${selectedPattern.version} · ${selectedPattern.target_bars} 根K线`} />}
        <div className="condition-creator-fields"><label className="workspace-field-label">最低相似度（分）<input className="workspace-field" aria-label="条件最低相似度" type="number" min={0} max={100} step={1} disabled={disabled || !!saved} value={get('threshold', String(selectedPattern?.params.min_similarity ?? 80))} onChange={event => set('threshold', event.target.value)} /></label><label className="workspace-field-label">匹配窗口<select className="workspace-field" aria-label="条件形态匹配窗口" disabled={disabled || !!saved} value={matchMode} onChange={event => set('matchMode', event.target.value)}><option value="current">截至样本日的当前窗口</option><option value="recent" disabled={!recentSupported}>近期最相近窗口</option></select></label>{matchMode === 'recent' && <label className="workspace-field-label">回看交易日数<input className="workspace-field" aria-label="条件形态回看日数" type="number" min={1} max={120} step={1} disabled={disabled || !!saved} value={get('recent', String(selectedPattern?.params.recent_bars ?? 20))} onChange={event => set('recent', event.target.value)} /></label>}</div>
        {!recentSupported && <p className="condition-creator-note">此目标使用旧版匹配算法，仅支持当前窗口。近期匹配请在形态工作台另存新版本。</p>}
        <p className="condition-creator-note">保存为独立的形态条件，保留来源版本；相似度不是未来上涨概率。</p>{onOpenPatterns && <button type="button" className="text-button workspace-button" disabled={disabled} onClick={onOpenPatterns}>前往形态选股创建目标</button>}
      </div>}
      {(kind === 'news' || kind === 'report') && <div className="condition-evidence-fields">
        <label className="workspace-field-label">{kind === 'news' ? '事件与成立标准' : '需要原文证实什么'}<textarea className="workspace-field" aria-label="可复用证据判断要求" rows={4} maxLength={1000} disabled={disabled || !!saved} value={get('question')} onChange={event => set('question', event.target.value)} placeholder={kind === 'news' ? '例如：有公司已实施回购的原文依据，排除仅提出计划的情况。' : '例如：报告提供订单实际增长的数据，并区分分析师预测。'} /></label>
        <div className="condition-creator-fields"><label className="workspace-field-label">资料窗口（自然日）<input type="number" className="workspace-field" aria-label="条件资料窗口" min={1} max={3650} step={1} disabled={disabled || !!saved} value={get('lookback', kind === 'report' ? '365' : '30')} onChange={event => set('lookback', event.target.value)} /></label><label className="workspace-field-label">事实口径<select className="workspace-field" aria-label="条件事实口径" disabled={disabled || !!saved} value={get('basis', 'actual')} onChange={event => set('basis', event.target.value)}><option value="actual">实际发生的事实</option><option value="forecast">预测与未来判断</option><option value="any">事实与预测均可，保留区别</option></select></label>{kind === 'news' && <label className="workspace-field-label">事件状态<select className="workspace-field" aria-label="条件事件状态" disabled={disabled || !!saved} value={get('event', 'any')} onChange={event => set('event', event.target.value)}><option value="any">按问题判断</option><option value="planned">计划阶段</option><option value="in_progress">实施中</option><option value="completed">已经完成</option></select></label>}</div>
        <div className="condition-creator-fields"><label className="workspace-field-label">资料判断范围<select className="workspace-field" aria-label="条件证据范围" disabled={disabled || !!saved} value={get('quantifier', 'exists')} onChange={event => set('quantifier', event.target.value)}><option value="exists">至少有一项充分依据</option><option value="all">全部已核对资料均满足</option></select></label>{kind === 'news' && <label className="workspace-field-label">最少独立事件数<input className="workspace-field" aria-label="条件独立事件数" type="number" min={1} max={100} step={1} disabled={disabled || !!saved} value={get('minimumEvents', '1')} onChange={event => set('minimumEvents', event.target.value)} /></label>}</div>
        <label className="condition-numeric-check"><input type="checkbox" checked={get('numeric') === 'true'} disabled={disabled || !!saved} onChange={event => set('numeric', String(event.target.checked))} />需要核对数值、单位或阈值</label>
        <p className="condition-creator-note">窗口相对于每次筛选日期计算。没有足够原文时保留“数据不足”，不会改成关键词命中。</p>
      </div>}
      <section className="condition-sample-check" aria-label="条件样本验证"><h3>验证一家公司</h3><div className="condition-creator-fields"><label className="workspace-field-label">样本公司<StockSearch label="可复用条件样本公司" value={sampleCode} disabled={disabled || !!saved} onSelectionPending={() => set('sampleCode', '')} onChange={value => set('sampleCode', value)} /></label><label className="workspace-field-label">样本截止日期<input className="workspace-field" type="date" aria-label="可复用条件样本日期" max={kind === 'technical' || kind === 'pattern' ? data?.last_date || today() : today()} disabled={disabled || !!saved} value={asOf} onChange={event => set('asOf', event.target.value)} /></label></div>
        <button className="secondary-button workspace-button" type="button" disabled={disabled || !definition || !/^\d{6}\.(SH|SZ|BJ)$/.test(sampleCode) || invalidDate || !!saved} onClick={() => void preview()}>{busy === 'preview' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{busy === 'preview' ? '正在核对样本…' : '验证样本'}</button>
        {trial && <div className="condition-trial-result" aria-label="条件样本验证结果"><p><strong>{stateLabel(trial.result.state)}</strong> · {trial.sample.stock_code} · 截至 {trial.sample.as_of}</p>{!current && <p className="workspace-feedback workspace-feedback-warning" role="status">下方为上次验证结果，当前设置尚未完成验证。请重新验证后保存。</p>}{trial.result.reason && <p>{trial.result.reason}</p>}{typeof trial.result.similarity === 'number' && <p>相似度 {trial.result.similarity} 分 · 要求至少 {trial.result.threshold} 分</p>}{trial.result.details?.map((detail, index) => <p key={index}>{detail.name}：{stateLabel(detail.state)}{detail.reason ? ` · ${detail.reason}` : ''}</p>)}{trial.result.chart?.bars.length ? <ResponsiveMarketIndicatorChart chart={trial.result.chart} height={220} minHeight={180} /> : null}{trial.result.template_points && trial.result.candidate_points && <PatternPathChart target={trial.result.template_points} candidate={trial.result.candidate_points} label="样本走势与固定目标对照" />}
          {trial.result.evidence?.map((item, index) => <blockquote key={index}><strong>{String(item.title || `样本依据 ${index + 1}`)}</strong>{typeof item.page_number === 'number' && <span> · 第 {item.page_number} 页</span>}<p>{String(item.quote || '')}</p>{kind === 'report' && typeof item.source_id === 'string' && <a href={`/api/v1/documents/${encodeURIComponent(item.source_id)}/pdf#page=${Number(item.page_number) || 1}`} target="_blank" rel="noreferrer">打开研报原文</a>}</blockquote>)}
        </div>}
      </section>
      <div className="condition-creator-save"><label className="workspace-field-label">条件名称<input className="workspace-field" aria-label="可复用条件名称" maxLength={100} disabled={disabled || !!saved} value={name} onChange={event => set('name', event.target.value)} /></label>{trial?.result.state === 'unknown' && current && <p className="condition-creator-note">该样本仍无法判断，可以保存规则；执行时仍需满足资料或模型依赖。</p>}<div>{saved ? <><p role="status"><Check size={16} />已保存 {saved.asset.name} · v{saved.asset.version}</p><button type="button" className="primary-button workspace-button" disabled={parentBusy} onClick={() => onUse(saved.reference)}>将此版本加入组合</button><button type="button" className="text-button workspace-button" onClick={() => { setTrials(previous => { const next = { ...previous }; delete next[kind]; return next }); set('name', '') }}>新建另一个条件</button></> : <button type="button" className="primary-button workspace-button" disabled={disabled || !current || !name.trim()} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存为可复用条件</button>}</div></div>
    </>}
    {error && <p className="workspace-error" role="alert">{error}</p>}
  </div>
}
