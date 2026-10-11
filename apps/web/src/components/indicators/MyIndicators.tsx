import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, ArrowRight, Bookmark, Check, ChevronLeft, FlaskConical, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { api, type DataStatus } from '../../api'
import { trapDialogTab } from '../../keyboard'
import StockSearch from '../StockSearch'
import { ResponsiveMarketIndicatorChart, type IndicatorChart } from '../../pages/TechnicalBrowser'
import {
  describeIndicatorPrompt, indicatorComparisons, indicatorSaveRequestId, indicatorScreeningPrompt, parameterError, reuseIndicatorPrompt,
  type IndicatorComparison, type IndicatorParameter, type IndicatorTrial,
  type IndicatorTrialSummary, type SavedIndicator,
} from '../../dynamicIndicators'
import './my-indicators.css'

type Props = {
  conversationId?: string
  contextKey: string
  workflow: 'research' | 'screening'
  data?: DataStatus | null
  defaultStock?: string
  defaultAsOf?: string
  disabled?: boolean
  turnActive: boolean
  refreshKey: number
  onPrompt: (prompt: string) => boolean | void
  onScreening?: (prompt: string) => boolean | void
}

/** An entry in the current conversation, not a second indicator-authoring workflow. */
export default function MyIndicators(props: Props) {
  const [open, setOpen] = useState(false)
  const [trials, setTrials] = useState<IndicatorTrialSummary[]>([])
  const [trialError, setTrialError] = useState('')
  const [handoffError, setHandoffError] = useState('')
  const [reload, setReload] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => { setOpen(false); setTrials([]); setTrialError(''); setHandoffError('') }, [props.contextKey])
  useEffect(() => {
    const controller = new AbortController()
    let reading = false
    if (!props.conversationId) { setTrials([]); return }
    const load = async () => {
      if (reading || controller.signal.aborted) return
      reading = true
      try {
        const response = await api<{ items: IndicatorTrialSummary[] }>(`/dynamic-indicators/trials?conversation_id=${encodeURIComponent(props.conversationId!)}`, { signal: controller.signal })
        if (!controller.signal.aborted) { setTrials(Array.isArray(response.items) ? response.items : []); setTrialError('') }
      } catch (reason) { if (!controller.signal.aborted) setTrialError((reason as Error).message) }
      finally { reading = false }
    }
    void load()
    const timer = props.turnActive ? globalThis.setInterval(() => { void load() }, 2000) : undefined
    return () => { controller.abort(); globalThis.clearInterval(timer) }
  }, [props.conversationId, props.contextKey, props.refreshKey, props.turnActive, reload])
  function close(restoreFocus = true) { setOpen(false); if (restoreFocus) trigger.current?.focus() }
  function handoff(prompt: string, screening = false) {
    const handler = screening ? props.onScreening : props.onPrompt
    if (!handler || handler(prompt) === false) { setHandoffError('当前草稿加上指标请求过长，请先关闭此面板并精简草稿，再添加指标请求。'); return }
    close(false)
  }
  return <>
    <button type="button" ref={trigger} className="my-indicators-trigger" aria-label="我的指标" aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => { setHandoffError(''); setReload(value => value + 1); setOpen(true) }}><Activity size={15} /><span>我的指标</span>{trials.length > 0 && <span className="my-indicators-count" title="当前对话的试算记录">{trials.length}</span>}</button>
    {open && createPortal(<IndicatorWorkspace key={props.contextKey} {...props} id={id} trials={trials} trialError={trialError} handoffError={handoffError} onReloadTrials={() => setReload(value => value + 1)} onClose={close} onHandoff={handoff} />, document.body)}
  </>
}

type WorkspaceProps = Props & {
  id: string
  trials: IndicatorTrialSummary[]
  trialError: string
  handoffError: string
  onReloadTrials: () => void
  onClose: (restoreFocus?: boolean) => void
  onHandoff: (prompt: string, screening?: boolean) => void
}
type Selection = { kind: 'trial'; id: string } | { kind: 'saved'; id: string; version: number }
const fmt = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })

function IndicatorWorkspace({ id, conversationId, workflow, data, defaultStock, defaultAsOf, disabled, turnActive, trials, trialError, handoffError, onReloadTrials, onClose, onHandoff, onScreening }: WorkspaceProps) {
  const [saved, setSaved] = useState<SavedIndicator[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [reload, setReload] = useState(0)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [record, setRecord] = useState<SavedIndicator | null>(null)
  const [trial, setTrial] = useState<IndicatorTrial | null>(null)
  const [versions, setVersions] = useState<SavedIndicator[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [description, setDescription] = useState('')
  const [descriptionOpen, setDescriptionOpen] = useState(true)
  const [detailReload, setDetailReload] = useState(0)
  const [stock, setStock] = useState(defaultStock ?? '000001.SH')
  const [asOf, setAsOf] = useState(defaultAsOf || data?.last_date || '')
  const [limit, setLimit] = useState(500)
  const [originalTrial, setOriginalTrial] = useState(false)
  const [parameters, setParameters] = useState<Record<string, IndicatorParameter>>({})
  const [trialInputs, setTrialInputs] = useState('')
  const [busy, setBusy] = useState<'' | 'preview' | 'save' | 'condition' | 'original'>('')
  const [saveName, setSaveName] = useState('')
  const [saveTarget, setSaveTarget] = useState('')
  const [output, setOutput] = useState('')
  const [operator, setOperator] = useState<IndicatorComparison>('gt')
  const [threshold, setThreshold] = useState('0')
  const [mobileDetail, setMobileDetail] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  const generation = useRef(0)
  const operation = useRef<AbortController | null>(null)
  const operationLocked = useRef(false)
  const saveAttempts = useRef(new Map<string, string>())
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const savedRef = useRef(saved)
  savedRef.current = saved
  const definition = trial?.definition ?? record?.definition
  const selectionKey = selection ? JSON.stringify(selection) : ''
  const inputKey = JSON.stringify([stock, asOf, limit, parameters])
  const staleTrial = !!trial && inputKey !== trialInputs
  const invalid = !/^\d{6}\.(SH|SZ|BJ)$/.test(stock) ? '请输入完整证券代码，例如 000001.SH。' : !asOf ? '请选择试算截止日。' : data?.last_date && asOf > data.last_date ? '截止日期不能晚于最新行情日期。' : !Number.isInteger(limit) || limit < 2 || limit > 500 ? '历史长度应为 2–500 个交易日。' : definition ? parameterError(definition, parameters) : ''
  const savedParametersUnchanged = !!record && Object.keys(record.definition.program.parameters).length === Object.keys(parameters).length && Object.entries(record.definition.program.parameters).every(([key, value]) => parameters[key] === value)
  const savedHistoryUnchanged = !!record && limit === (record.source_context?.requested_limit ?? 500)
  const savedInputLengthMatchesTrial = !trial || typeof record?.source_context?.input_bars !== 'number' || trial.dates.length === record.source_context.input_bars
  const savedVersionMatchesTrial = savedParametersUnchanged && savedHistoryUnchanged && savedInputLengthMatchesTrial && (!trial || record?.definition_hash === trial.definition_hash && ['price_basis', 'volume_unit', 'amount_unit'].every(key => record.source_context?.[key] === trial.source_context[key]))
  const numericThreshold = threshold.trim() ? Number(threshold) : NaN

  useEffect(() => {
    mounted.current = true
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('keydown', escape, true); mounted.current = false; ++generation.current; operation.current?.abort(); document.body.style.overflow = overflow }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setCatalogLoading(true); setCatalogError('')
    api<{ items: SavedIndicator[] }>('/dynamic-indicators', { signal: controller.signal }).then(response => {
      if (!controller.signal.aborted) setSaved(Array.isArray(response.items) ? response.items : [])
    }).catch(reason => { if (!controller.signal.aborted) setCatalogError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setCatalogLoading(false) })
    return () => controller.abort()
  }, [reload])
  useEffect(() => {
    // New arrivals never replace the version the user is already inspecting.
    if (!selection && trials.length) setSelection({ kind: 'trial', id: trials[0].trial_id })
  }, [trials, selection])
  useEffect(() => {
    if (!selection) return
    const controller = new AbortController()
    const current = ++generation.current
    operation.current?.abort(); operationLocked.current = false; setBusy('')
    setLoading(true); setError(''); setNotice(''); setTrial(null); setRecord(null); setVersions([]); setDescriptionOpen(false)
    const accepted = () => mounted.current && !controller.signal.aborted && current === generation.current
    const load = async () => {
      try {
        if (selection.kind === 'trial') {
          const next = await api<IndicatorTrial>(`/dynamic-indicators/trials/${encodeURIComponent(selection.id)}`, { signal: controller.signal })
          if (!accepted()) return
          installTrial(next)
          const alreadySaved = savedRef.current.find(item => item.trial_id === next.trial_id)
          if (alreadySaved) { setRecord(alreadySaved); setSaveName(alreadySaved.name) }
          setSaveTarget(alreadySaved?.id || next.indicator_id || '')
        } else {
          const [next, history] = await Promise.all([
            api<SavedIndicator>(`/dynamic-indicators/${encodeURIComponent(selection.id)}?version=${selection.version}`, { signal: controller.signal }),
            api<{ items: SavedIndicator[] }>(`/dynamic-indicators/${encodeURIComponent(selection.id)}/versions`, { signal: controller.signal }),
          ])
          if (!accepted()) return
          setRecord(next); setVersions(history.items); setParameters(next.definition.program.parameters); setLimit(typeof next.source_context?.requested_limit === 'number' ? next.source_context.requested_limit : 500)
          setSaveName(next.name); setSaveTarget(next.id); setOutput(next.definition.outputs[0]?.name || '')
        }
      } catch (reason) { if (accepted()) setError((reason as Error).message) }
      finally { if (accepted()) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [selectionKey, detailReload])

  useEffect(() => {
    if (!trial || record) return
    const alreadySaved = saved.find(item => item.trial_id === trial.trial_id)
    if (alreadySaved) { setRecord(alreadySaved); setSaveName(alreadySaved.name); setSaveTarget(alreadySaved.id) }
  }, [saved, trial?.trial_id, record])

  function installTrial(next: IndicatorTrial, original = false) {
    const historyLimit = typeof next.source_context.requested_limit === 'number' ? next.source_context.requested_limit : 500
    setLimit(historyLimit); setOriginalTrial(original)
    setTrial(next); setStock(next.stock_code); setAsOf(next.as_of); setParameters(next.parameters)
    setTrialInputs(JSON.stringify([next.stock_code, next.as_of, historyLimit, next.parameters]))
    setSaveName(next.definition.name); setOutput(next.definition.outputs[0]?.name || '')
  }
  function select(next: Selection) {
    setMobileDetail(true)
    if (JSON.stringify(next) === selectionKey) return
    setBusy('')
    ++generation.current; operation.current?.abort(); operationLocked.current = false
    setSelection(next); setError(''); setNotice(''); setMobileDetail(true)
  }
  function begin(kind: 'preview' | 'save' | 'condition' | 'original') {
    if (operationLocked.current) return null
    const controller = new AbortController(), current = ++generation.current
    operation.current = controller; operationLocked.current = true; setBusy(kind); setError(''); setNotice('')
    return { controller, accepted: () => mounted.current && !controller.signal.aborted && current === generation.current }
  }
  function finish(task: NonNullable<ReturnType<typeof begin>>) {
    if (!task.accepted()) return
    operationLocked.current = false; setBusy('')
  }
  function cancelPreview() {
    ++generation.current; operation.current?.abort(); operationLocked.current = false; setBusy(''); setNotice('已停止等待试算结果；若计算已完成，记录可能仍会出现在列表中。')
  }
  async function preview() {
    if (!definition || invalid) return
    const task = begin('preview'); if (!task) return
    try {
      const next = await api<IndicatorTrial>('/dynamic-indicators/preview', { method: 'POST', signal: task.controller.signal, body: JSON.stringify({
        ...(record ? { indicator_id: record.id, version: record.version } : { definition }),
        stock_code: stock, as_of: asOf, parameter_overrides: parameters, limit, ...(conversationId ? { conversation_id: conversationId } : {}),
      }) })
      if (!task.accepted()) return
      installTrial(next); onReloadTrials()
    } catch (reason) { if (task.accepted()) setError((reason as Error).message) }
    finally { finish(task) }
  }
  async function loadOriginalTrial() {
    if (!record?.trial_id) return
    const task = begin('original'); if (!task) return
    try {
      const next = await api<IndicatorTrial>(`/dynamic-indicators/trials/${encodeURIComponent(record.trial_id)}`, { signal: task.controller.signal })
      if (task.accepted()) installTrial(next, true)
    } catch (reason) { if (task.accepted()) setError((reason as Error).message) }
    finally { finish(task) }
  }
  async function save() {
    if (!trial || staleTrial || invalid || !trial.validation.saveable || !saveName.trim()) return
    const target = saved.find(item => item.id === saveTarget)
    if (saveTarget && !target) { setError('尚未读取到保存目标，请刷新指标列表后重试。'); return }
    const task = begin('save'); if (!task) return
    const payload = { trial_id: trial.trial_id, name: saveName.trim(), ...(target ? { indicator_id: target.id, base_version: target.version } : {}), confirmed: true }
    const key = JSON.stringify(payload)
    if (!saveAttempts.current.has(key)) saveAttempts.current.set(key, indicatorSaveRequestId(key))
    try {
      const next = await api<SavedIndicator>('/dynamic-indicators/save', { method: 'POST', signal: task.controller.signal, body: JSON.stringify({ ...payload, request_id: saveAttempts.current.get(key) }) })
      if (!task.accepted()) return
      setRecord(next); setSaveTarget(next.id); setSaveName(next.name)
      setSaved(items => [next, ...items.filter(item => item.id !== next.id)])
      setVersions(items => [next, ...items.filter(item => item.id === next.id && item.version !== next.version)])
      setNotice(`已保存“${next.name}” v${next.version}。此版本可在研究和选股中复用。`)
      setReload(value => value + 1)
    } catch (reason) { if (task.accepted()) setError((reason as Error).message) }
    finally { finish(task) }
  }
  async function useForScreening() {
    if (!record || !savedVersionMatchesTrial || staleTrial || invalid || !output || !Number.isFinite(numericThreshold) || !onScreening || disabled) return
    const task = begin('condition'); if (!task) return
    try {
      // Validate the explicit numeric-to-boolean wrapper before handing the
      // exact immutable reference to Codex. This endpoint does not run a scan.
      await api(`/dynamic-indicators/${encodeURIComponent(record.id)}/condition`, { method: 'POST', signal: task.controller.signal, body: JSON.stringify({ version: record.version, output, operator, threshold: numericThreshold }) })
      if (task.accepted()) onHandoff(indicatorScreeningPrompt(record, output, operator, numericThreshold), true)
    } catch (reason) { if (task.accepted()) setError((reason as Error).message) }
    finally { finish(task) }
  }
  function generate(modify = false) {
    if (disabled || !description.trim() || invalid) return
    onHandoff(describeIndicatorPrompt(description, stock, asOf, modify ? record ?? undefined : undefined, modify && !record ? trial ?? undefined : undefined, limit))
  }

  return <div className="my-indicators-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section id={id} className={`my-indicators-dialog${mobileDetail ? ' my-indicators-detail-open' : ''}`} role="dialog" aria-modal="true" aria-label="我的指标" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }; trapDialogTab(event) }}>
      <header className="my-indicators-header"><div><h2><Activity size={18} />我的指标</h2><p>描述指标 → Codex 生成 → 行情试算 → 保存复用</p></div><button ref={closeButton} type="button" className="icon-button" aria-label="关闭我的指标" onClick={() => onClose()}><X size={20} /></button></header>
      <div className="my-indicators-body">
        <aside className="my-indicators-catalog" aria-label="指标与试算记录">
          <button type="button" className="primary-button" onClick={() => { setMobileDetail(true); setDescriptionOpen(true); globalThis.setTimeout(() => descriptionRef.current?.focus(), 0) }}>描述新指标<ArrowRight size={14} /></button>
          <div className="my-indicators-section-heading"><h3>当前对话试算</h3><button type="button" className="icon-button" aria-label="刷新指标记录" onClick={() => { onReloadTrials(); setReload(value => value + 1) }}><RefreshCw size={14} /></button></div>
          {turnActive && <p className="my-indicators-muted" role="status"><LoaderCircle size={13} className="spin" />生成中的试算会出现在这里</p>}
          {trialError && <p className="my-indicators-error" role="alert">试算记录读取失败：{trialError}</p>}
          {!trials.length && !trialError && <p className="my-indicators-muted">描述想观察的规律，发送到当前对话。试算由 Codex 生成，不限于内置指标。</p>}
          {trials.map(item => <button key={item.trial_id} type="button" className="my-indicators-item" aria-pressed={selection?.kind === 'trial' && selection.id === item.trial_id} onClick={() => select({ kind: 'trial', id: item.trial_id })}><FlaskConical size={15} /><span><strong>{item.definition?.name || item.name || '指标试算'}</strong><small>{item.stock_code || '待查看'}{item.as_of ? ` · ${item.as_of}` : ''}</small></span></button>)}
          <h3>已保存指标</h3>
          {catalogLoading && !saved.length && <p className="my-indicators-muted" role="status">正在读取指标…</p>}
          {catalogError && <p role="alert" className="my-indicators-error">{catalogError}</p>}
          {!catalogLoading && !catalogError && !saved.length && <p className="my-indicators-muted">先试算，再明确保存。保存后可跨对话复用固定版本。</p>}
          {saved.map(item => <button type="button" key={item.id} className="my-indicators-item" aria-pressed={record?.id === item.id} onClick={() => select({ kind: 'saved', id: item.id, version: item.version })}><Bookmark size={15} /><span><strong>{item.name}</strong><small>v{item.version} · 已保存</small></span></button>)}
        </aside>
        <div className="my-indicators-detail">
          <button type="button" className="text-button my-indicators-back" onClick={() => setMobileDetail(false)}><ChevronLeft size={14} />返回指标列表</button>
          <details className="my-indicators-describe" open={descriptionOpen} onToggle={event => setDescriptionOpen(event.currentTarget.open)}>
            <summary>用自然语言创建或修改指标</summary>
            <label>指标描述<textarea ref={descriptionRef} aria-label="指标描述" value={description} maxLength={4000} disabled={disabled} placeholder="例如：计算收盘价相对20日成交量加权均价的偏离，再除以近期波动率。请画出完整历史曲线。" onChange={event => setDescription(event.target.value)} /></label>
            <p className="my-indicators-muted">请求写入当前{workflow === 'research' ? '研究' : '选股'}对话，发送后由 Codex 编写并试算。原有草稿会保留。</p>
            <div className="my-indicators-actions"><button type="button" className="primary-button" disabled={disabled || !description.trim() || !!invalid} onClick={() => generate()}>写入生成请求<ArrowRight size={14} /></button>{definition && <button type="button" className="secondary-button" disabled={disabled || !description.trim() || !!invalid} onClick={() => generate(true)}>基于当前指标修改</button>}</div>
          </details>
          <div className="my-indicators-inputs"><label>试算证券<StockSearch label="指标试算证券" includeIndices value={stock} onChange={setStock} disabled={!!busy} /></label><label>截止日期<input type="date" aria-label="指标试算日期" value={asOf} max={data?.last_date} disabled={!!busy} onChange={event => setAsOf(event.target.value)} /></label><label>历史长度（交易日）<input type="number" aria-label="指标历史长度" min={2} max={500} step={1} value={Number.isNaN(limit) ? '' : limit} disabled={!!busy} onChange={event => setLimit(event.target.value === '' ? NaN : Number(event.target.value))} /></label></div>
          {handoffError && <p className="my-indicators-error" role="alert">{handoffError}</p>}
          {invalid && <p className="my-indicators-error" role="alert">{invalid}</p>}
          {loading && <p role="status" className="my-indicators-muted"><LoaderCircle size={15} className="spin" />正在读取指标版本…</p>}
          {error && <div className="my-indicators-error" role="alert">{error}{!definition && selection && !loading && <button type="button" className="text-button" onClick={() => setDetailReload(value => value + 1)}>重试指标详情</button>}</div>}
          {notice && <p className="my-indicators-notice" role="status"><Check size={15} />{notice}</p>}
          {definition && !loading && <>
            <div className="my-indicators-version-heading"><div><h3>{record?.name || definition.name}</h3><p>{record ? `固定版本 v${record.version}` : '待保存试算'} · 数值时序指标</p></div>{record && versions.length > 1 && <label>历史版本<select aria-label="指标历史版本" value={record.version} disabled={!!busy} onChange={event => select({ kind: 'saved', id: record.id, version: Number(event.target.value) })}>{versions.map(item => <option key={item.version} value={item.version}>v{item.version}</option>)}</select></label>}</div>
            {record && <div className="my-indicators-saved-evidence"><p className="my-indicators-muted">保存于 {record.created_at}{typeof record.source_context?.input_bars === 'number' ? ` · 固定输入 ${record.source_context.input_bars} 个交易日` : ''} · 原始校验{record.validation?.saveable ? '通过' : record.validation ? '见记录' : '待读取'}。此为保存时的证据，重新试算会另建记录。</p>{record.trial_id && <button type="button" className="text-button" disabled={!!busy} onClick={() => void loadOriginalTrial()}>{busy === 'original' ? '正在读取原始试算…' : '查看保存时的原始试算'}</button>}{record.source_context && <SourceContext context={record.source_context} />}</div>}
            <p className="my-indicators-description">{definition.description}</p>
            <p className="my-indicators-formula">{definition.formula}</p>
            {!!Object.keys(definition.program.parameters).length && <fieldset className="my-indicators-parameters"><legend>试算参数</legend>{Object.entries(definition.program.parameters).map(([name, original]) => {
              const spec = definition.program.parameter_specs?.[name], value = parameters[name] ?? original
              return <label key={name}>{spec?.label || name}<input type="number" aria-label={`指标参数 ${spec?.label || name}`} disabled={!!busy} min={spec?.minimum} max={spec?.maximum} step={spec?.type === 'integer' ? 1 : 'any'} value={Number.isNaN(value) ? '' : value} onChange={event => setParameters(items => ({ ...items, [name]: event.target.value === '' ? NaN : Number(event.target.value) }))} />{spec?.description && <small>{spec.description}</small>}</label>
            })}</fieldset>}
            <div className="my-indicators-actions"><button type="button" className="secondary-button" disabled={!!busy || !!invalid} onClick={() => void preview()}>{busy === 'preview' ? <LoaderCircle size={14} className="spin" /> : <FlaskConical size={14} />}{trial ? '按当前参数重新试算' : '试算完整走势'}</button>{busy === 'preview' && <button type="button" className="text-button" onClick={cancelPreview}>取消试算</button>}</div>
            {staleTrial && <p className="my-indicators-stale" role="status">证券、日期、历史长度或参数已改变。下方仍是上次试算，请重新试算后保存或用于选股。</p>}
            {trial && <>{originalTrial && <p className="my-indicators-stale">正在查看保存此版本时的原始试算，未重新运行。</p>}<TrialResult trial={trial} /></>}
            <details className="my-indicators-source"><summary>公式、代码与数据口径</summary><p>协议 {definition.program.contract_version} · 最低历史 {definition.program.required_history_bars} 个交易日</p><p>所需字段：{definition.program.required_fields.join('、')}</p><p>原始描述：{definition.original_prompt}</p><pre>{definition.program.source_code}</pre><p>代码指纹：{trial?.code_hash || record?.code_hash}</p><p>定义指纹：{trial?.definition_hash || record?.definition_hash}</p></details>
            {trial && <section className="my-indicators-save" aria-label="保存指标版本"><h3>确认后保存</h3><p className="my-indicators-muted">保存公式、代码、参数与校验记录。已有版本不会被覆盖。</p><div className="my-indicators-inputs"><label>指标名称<input aria-label="保存指标名称" maxLength={100} value={saveName} disabled={!!busy} onChange={event => setSaveName(event.target.value)} /></label><label>保存位置<select aria-label="指标保存位置" disabled={!!busy} value={saveTarget} onChange={event => setSaveTarget(event.target.value)}><option value="">保存为新指标</option>{saved.map(item => <option key={item.id} value={item.id}>{item.name} · 新建 v{item.version + 1}</option>)}</select></label></div><button type="button" className="primary-button" disabled={!!busy || catalogLoading || !!catalogError || !!saveTarget && !saved.some(item => item.id === saveTarget) || staleTrial || !!invalid || !trial.validation.saveable || !saveName.trim() || !!record && savedVersionMatchesTrial && record.name === saveName.trim() && saveTarget === record.id} onClick={() => void save()}><Bookmark size={14} />{busy === 'save' ? '正在保存…' : '确认保存此版本'}</button>{!trial.validation.saveable && <p className="my-indicators-error">此试算未通过保存校验。请让 Codex 修正后重新试算。</p>}</section>}
            {record && <section className="my-indicators-reuse" aria-label="复用已保存指标"><h3>复用固定版本 v{record.version}</h3><button type="button" className="secondary-button" disabled={disabled || !!busy || !!invalid || !savedParametersUnchanged || !savedHistoryUnchanged} onClick={() => onHandoff(reuseIndicatorPrompt(record, stock, asOf, limit))}>在当前对话中研究</button><p className="my-indicators-muted">数值输出需要明确比较方式和阈值，才能作为选股条件。</p><div className="my-indicators-condition"><label>数值输出<select aria-label="选股指标输出" value={output} disabled={!!busy} onChange={event => setOutput(event.target.value)}>{record.definition.outputs.map(item => <option key={item.name} value={item.name}>{item.label}{item.unit ? `（${item.unit}）` : ''}</option>)}</select></label><label>比较方式<select aria-label="指标比较方式" value={operator} disabled={!!busy} onChange={event => setOperator(event.target.value as IndicatorComparison)}>{Object.entries(indicatorComparisons).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>阈值<input type="number" step="any" aria-label="指标选股阈值" value={threshold} disabled={!!busy} onChange={event => setThreshold(event.target.value)} /></label></div>{!savedVersionMatchesTrial && <p className="my-indicators-stale">试算参数、历史长度或行情口径与已保存版本不同。请先保存新版本，再将它用于选股。</p>}<button type="button" className="primary-button" disabled={disabled || !!busy || !onScreening || staleTrial || !!invalid || !savedVersionMatchesTrial || !output || !Number.isFinite(numericThreshold)} onClick={() => void useForScreening()}>{busy === 'condition' ? '正在准备…' : workflow === 'screening' ? '加入当前选股草稿' : '用于选股草稿'}<ArrowRight size={14} /></button><p className="my-indicators-muted">固定版本和参数，缺失值保留“未知”。只准备选股草稿，确认后再运行。</p></section>}
          </>}
        </div>
      </div>
    </section>
  </div>
}

function TrialResult({ trial }: { trial: IndicatorTrial }) {
  const chartGroups = splitIndicatorCharts(trial)
  return <section className="my-indicators-trial" aria-label="指标试算完整走势">
    <div className="my-indicators-trial-summary"><strong>{trial.stock_code}</strong><span>请求截至 {trial.as_of}</span><span>实际行情日 {trial.actual_date || '暂无'}</span></div>
    <p className="my-indicators-muted">完整试算序列：{trial.dates.length} 个交易日{trial.dates.length ? ` · ${trial.dates[0]} 至 ${trial.dates.at(-1)}` : ''}（单次最多 500 日）。预热及缺失值留空。</p>
    <div className="my-indicators-latest">{trial.definition.outputs.map(item => <div key={item.name}><span>{item.label}{item.unit ? `（${item.unit}）` : ''}</span><strong>{fmt(trial.series[item.name]?.at(-1))}</strong></div>)}</div>
    {chartGroups.map((chart, index) => <ResponsiveMarketIndicatorChart key={index} chart={chart} />)}
    <SourceContext context={trial.source_context} />
    <p className={trial.validation.passed ? 'my-indicators-muted' : 'my-indicators-error'}>{trial.validation.passed ? '已通过本次试算校验' : '本次试算未通过校验'}。单证券试算不代表全市场数据覆盖或投资效果。</p>
    {trial.validation.warnings?.map((warning, index) => <p className="my-indicators-stale" key={index}>{warning}</p>)}
    <details><summary>查看逐日数值</summary><div className="my-indicators-series-table"><table><thead><tr><th>交易日</th>{trial.definition.outputs.map(output => <th key={output.name}>{output.label}</th>)}</tr></thead><tbody>{trial.dates.map((date, index) => <tr key={date}><td>{date}</td>{trial.definition.outputs.map(output => <td key={output.name}>{fmt(trial.series[output.name]?.[index])}</td>)}</tr>)}</tbody></table></div></details>
  </section>
}

function SourceContext({ context }: { context: Record<string, unknown> }) {
  const basis = ({ unadjusted: '不复权', forward_adjusted: '前复权', back_adjusted: '后复权' } as Record<string, string>)[String(context.price_basis)] || '未核实'
  return <p className="my-indicators-muted">行情口径：{basis}{context.volume_unit ? ` · 成交量单位 ${String(context.volume_unit)}` : ''}{context.amount_unit ? ` · 成交额单位 ${String(context.amount_unit)}` : ''}{context.effective_market_date ? ` · 市场交易日 ${String(context.effective_market_date)}` : ''}</p>
}

/** Keep the shared chart intact, and never force different placements onto one scale. */
export function splitIndicatorCharts(trial: IndicatorTrial): IndicatorChart[] {
  const visibleBaseline = (chart: IndicatorChart) => chart.histogram && !chart.reference_lines.includes(0) ? { ...chart, reference_lines: [...chart.reference_lines, 0] } : chart
  if (trial.charts?.length) return trial.charts.flatMap(chart => chart.placement === 'overlay' && chart.histogram ? [...(chart.lines.length ? [{ ...chart, histogram: null }] : []), { ...chart, placement: 'pane' as const, lines: [] }] : [chart]).map(visibleBaseline)
  const charts: IndicatorChart[] = []
  for (const placement of ['overlay', 'pane'] as const) {
    const outputs = trial.definition.outputs.filter(output => (output.kind === 'histogram' ? 'pane' : output.placement) === placement)
    if (!outputs.length) continue
    const lines = outputs.filter(output => output.kind !== 'histogram').map(output => ({ id: output.name, label: output.label, color: output.color || 'var(--ui-chart-line)', values: trial.series[output.name] || trial.dates.map(() => null) }))
    const histograms = outputs.filter(output => output.kind === 'histogram')
    // The shared renderer supports one histogram per pane. Additional histogram
    // outputs get their own pane instead of silently dropping a series.
    charts.push({ bars: trial.chart.bars, placement, lines, histogram: histograms[0] ? { id: histograms[0].name, label: histograms[0].label, color: histograms[0].color || 'var(--ui-chart-line)', values: trial.series[histograms[0].name] || [] } : null, reference_lines: placement === 'pane' ? trial.chart.reference_lines : [] })
    histograms.slice(1).forEach(output => charts.push({ bars: trial.chart.bars, placement: 'pane', lines: [], histogram: { id: output.name, label: output.label, color: output.color || 'var(--ui-chart-line)', values: trial.series[output.name] || [] }, reference_lines: [] }))
  }
  return (charts.length ? charts : [trial.chart]).map(visibleBaseline)
}
