import { useEffect, useMemo, useState } from 'react'
import { Check, MessageSquareText, Play, Save, Sparkles } from 'lucide-react'
import { api, type Filter } from '../api'

type Library = 'news' | 'technical' | 'report'
type DraftResponse = { name: string; description: string; expression: Record<string, unknown>; validation: { valid: boolean; errors: string[] }; source: string }
type PreviewResponse = { state: string; actual?: number; operator?: string; threshold?: number; reason?: string; warning?: string; hits?: { page_number: number; title: string; snippet: string }[] }
type Criterion = { id: string; label: string; question: string; signals: string[]; counter_signals: string[] }
type SecurityCandidate = { company_name: string | null; reported_code: string; canonical_code: string; role: string; page: number; quote: string; validated_against_page: boolean }
type ReportEvaluation = {
  id: string; status: string; as_of: string; lookback_start: string; model: string; job_id?: string
  coverage: Record<string, unknown>
  result: { assessments?: {
    document_id: string; title: string; publication_date: string; publication_date_source: string; available_at: string; availability_status: string
    candidate_code: string | null; stock_code: string | null; binding_status: string; state: string
    security_candidates?: SecurityCandidate[]; primary_security_candidate?: SecurityCandidate | null
    criteria: { criterion_id: string; label: string; state: string; summary: string; evidence: { page: number; quote: string; evidence_type: string; period: string | null }[] }[]
  }[] }
  job?: { id: string; state: string; progress: number; message: string }
}

const libText = {
  news: { title: '资讯库', intro: '设计资讯筛选条件', placeholder: '例如：过去 5 个交易日，公告新增订单且金额超过 1 亿元', name: '资讯条件', dependency: '资讯数据源未接入。条件可以编辑和保存；正式运行会被阻断。' },
  technical: { title: '技术指标库', intro: '描述并保存常见或自定义时序指标', placeholder: '描述行情字段、计算窗口和判断方式', name: '技术指标条件', dependency: '行情可用于探索试算；复权口径与量额单位未核验，正式运行受限。' },
  report: { title: '研报条件', intro: '用自然语言表达研究目标，生成可编辑的判断口径', placeholder: '例如：找基本面改善且行业景气度上升的公司；重视订单和毛利率，不把预测当成已实现事实', name: '研报证据条件', dependency: '模型逐份评估本地研报并从原文提取证券代码；唯一主体候选需人工确认，确认后刷新评估才会进入策略。无本地报告不表示不符合。' },
}

const initialCriterion: Criterion = {
  id: 'research_goal', label: '研究目标', question: '判断研报是否提供支持该研究目标的证据；区分已发生事实、公司表述、分析师观点和预测。只根据可引用原文判断。',
  signals: ['与研究目标直接相关的公司或行业证据'], counter_signals: ['与研究目标直接相关的反向证据'],
}

export default function LibraryPage({ library }: { library: Library }) {
  const copy = libText[library]
  const [items, setItems] = useState<Filter[]>([])
  const [activeId, setActiveId] = useState('')
  const [version, setVersion] = useState(0)
  const [name, setName] = useState(copy.name)
  const [prompt, setPrompt] = useState('')
  const [description, setDescription] = useState('')
  const [draftSource, setDraftSource] = useState('')
  const [kind, setKind] = useState<'indicator_compare' | 'ma_cross' | 'evidence_query'>(library === 'technical' ? 'indicator_compare' : 'evidence_query')
  const [indicator, setIndicator] = useState('sma')
  const [field, setField] = useState('close')
  const [window, setWindow] = useState(20)
  const [operator, setOperator] = useState('lt')
  const [target, setTarget] = useState('close')
  const [threshold, setThreshold] = useState(70)
  const [fast, setFast] = useState(5)
  const [slow, setSlow] = useState(20)
  const [direction, setDirection] = useState('up')
  const [terms, setTerms] = useState('订单,数据中心')
  const [lookback, setLookback] = useState(library === 'report' ? 365 : 30)
  const [criteria, setCriteria] = useState<Criterion[]>([initialCriterion])
  const [combineCriteria, setCombineCriteria] = useState<'all' | 'any'>('all')
  const [evaluationAsOf, setEvaluationAsOf] = useState(todayLocal())
  const [evaluation, setEvaluation] = useState<ReportEvaluation | null>(null)
  const [stock, setStock] = useState('600000.SH')
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [blockers, setBlockers] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = () => api<{ items: Filter[] }>(`/filters?library=${library}`).then(({ items: next }) => setItems(next)).catch((error) => setNotice(error.message))
  useEffect(() => { refresh(); resetForm() }, [library])

  const expression = useMemo<Record<string, unknown>>(() => {
    if (library === 'report') return { op: 'evidence_query', evaluation_mode: 'rubric', criteria, combine: combineCriteria, lookback_calendar_days: lookback, evidence_policy: '每项判断须引用原文；事实、公司表述、分析师观点和预测分开标记；无证据为 unknown。' }
    if (library === 'news') return { op: 'evidence_query', terms: terms.split(/[，,;；]+/).map((item) => item.trim()).filter(Boolean), lookback_calendar_days: lookback, scope: 'same_document_page', source: 'tushare' }
    if (kind === 'ma_cross') return { op: 'ma_cross', fast_window: fast, slow_window: slow, direction }
    if (kind === 'evidence_query') return { op: 'evidence_query', terms: terms.split(/[，,;；]+/).map((item) => item.trim()).filter(Boolean), lookback_calendar_days: lookback, scope: 'same_document_page' }
    return {
      op: 'indicator_compare', indicator, field, window, operator,
      ...(target !== 'value' ? { compare_field: target } : { value: threshold }),
    }
  }, [library, kind, indicator, field, window, operator, target, threshold, fast, slow, direction, terms, lookback, criteria, combineCriteria])

  useEffect(() => {
    if (library !== 'report' || !activeId || !version) return
    let active = true
    api<{ items: { id: string }[] }>(`/report-evaluations?filter_id=${encodeURIComponent(activeId)}&version=${version}`).then(async ({ items }) => {
      if (items[0]) { const latest = await api<ReportEvaluation>(`/report-evaluations/${items[0].id}`); if (active) setEvaluation(latest) }
    }).catch((error) => { if (active) setNotice(error.message) })
    return () => { active = false }
  }, [library, activeId, version])

  useEffect(() => {
    if (!evaluation || !['queued', 'running'].includes(evaluation.status)) return
    let active = true
    const timer = globalThis.setInterval(() => {
      api<ReportEvaluation>(`/report-evaluations/${evaluation.id}`).then((result) => { if (active) setEvaluation(result) }).catch((error) => { if (active) setNotice((error as Error).message) })
    }, 1500)
    return () => { active = false; globalThis.clearInterval(timer) }
  }, [evaluation?.id, evaluation?.status])

  function resetForm() {
    setActiveId(''); setVersion(0); setName(copy.name); setDescription(''); setPrompt('');
    setKind(library === 'technical' ? 'indicator_compare' : 'evidence_query'); setPreview(null); setBlockers([]); setNotice(''); setEvaluation(null); setDraftSource('')
    setCriteria([initialCriterion]); setCombineCriteria('all'); setLookback(library === 'report' ? 365 : 30); setEvaluationAsOf(todayLocal())
  }

  async function makeDraft() {
    if (!prompt.trim()) { setNotice('先写下筛选要求'); return }
    setBusy(true); setNotice('')
    try {
      const result = await api<DraftResponse>('/filters/draft', { method: 'POST', body: JSON.stringify({ library, prompt }) })
      setName(result.name); setDescription(result.description); setDraftSource(result.source)
      const draft = result.expression
      if (library === 'report' && draft.evaluation_mode === 'rubric') {
        setCriteria(normalizeCriteria(draft.criteria))
        setCombineCriteria(draft.combine === 'any' ? 'any' : 'all')
        setLookback(Number(draft.lookback_calendar_days ?? 365))
        setKind('evidence_query')
      }
      else if (draft.op === 'ma_cross') { setKind('ma_cross'); setFast(Number(draft.fast_window ?? 5)); setSlow(Number(draft.slow_window ?? 20)); setDirection(String(draft.direction ?? 'up')) }
      else if (draft.op === 'indicator_compare') {
        setKind('indicator_compare'); setIndicator(String(draft.indicator ?? 'sma')); setField(String(draft.field ?? 'close')); setWindow(Number(draft.window ?? 20)); setOperator(String(draft.operator ?? 'gt'))
        if (typeof draft.compare_field === 'string') setTarget(draft.compare_field)
        else { setTarget('value'); setThreshold(Number(draft.value ?? 70)) }
      } else {
        setKind('evidence_query'); setTerms(Array.isArray(draft.terms) ? draft.terms.map(String).join(',') : prompt)
        setLookback(Number(draft.lookback_calendar_days ?? 30))
      }
      setNotice(result.validation.valid ? '草稿已生成并通过结构校验，可继续编辑。' : `草稿需要修正：${result.validation.errors.join('；')}`)
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  async function load(item: Filter) {
    setActiveId(item.id); setVersion(item.version); setName(item.name); setDescription(item.description); setPreview(null); setBlockers([])
    const value = item.expression
    if (value.op === 'ma_cross') { setKind('ma_cross'); setFast(Number(value.fast_window)); setSlow(Number(value.slow_window)); setDirection(String(value.direction ?? 'up')) }
    else if (value.op === 'indicator_compare') {
      setKind('indicator_compare'); setIndicator(String(value.indicator)); setField(String(value.field ?? 'close')); setWindow(Number(value.window)); setOperator(String(value.operator))
      if (typeof value.compare_field === 'string') setTarget(value.compare_field)
      else { setTarget('value'); setThreshold(Number(value.value)) }
    } else if (library === 'report' && value.evaluation_mode === 'rubric') {
      setKind('evidence_query'); setCriteria(normalizeCriteria(value.criteria)); setCombineCriteria(value.combine === 'any' ? 'any' : 'all'); setLookback(Number(value.lookback_calendar_days ?? 365))
    } else {
      setKind('evidence_query'); setTerms(Array.isArray(value.terms) ? value.terms.map(String).join(',') : ''); setLookback(Number(value.lookback_calendar_days ?? 30))
    }
    setEvaluation(null)
    setNotice(`已载入 v${item.version}。保存后会生成新版本，历史策略继续引用旧版本。`)
  }

  async function save() {
    if (!name.trim()) { setNotice('条件名称不能为空'); return }
    setBusy(true); setNotice('')
    try {
      const item = await api<Filter>('/filters', { method: 'POST', body: JSON.stringify({ id: activeId || undefined, library, name, description, expression }) })
      setActiveId(item.id); setVersion(item.version); await refresh()
      setNotice(`已保存 ${item.name} v${item.version}`)
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  async function validate() {
    if (!activeId) { setNotice('先保存条件，再检查数据依赖'); return }
    try {
      const result = await api<{ valid: boolean; blockers: string[]; errors: string[] }>(`/filters/${activeId}/validate?version=${version}`, { method: 'POST' })
      setBlockers(result.blockers); setNotice(result.valid ? '结构校验通过' : result.errors.join('；'))
    } catch (error) { setNotice((error as Error).message) }
  }

  async function tryPreview() {
    if (!activeId) { setNotice('先保存条件再试算'); return }
    setBusy(true)
    try {
      const result = await api<PreviewResponse>(`/filters/${activeId}/preview?version=${version}`, { method: 'POST', body: JSON.stringify({ stock_code: stock || undefined }) })
      setPreview(result); setNotice('试算已完成')
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  async function controlEvaluation(action: 'cancel' | 'retry') {
    const jobId = evaluation?.job?.id ?? evaluation?.job_id
    if (!jobId || !evaluation) return
    setBusy(true)
    try {
      const result = await api<{ evaluation_run_id?: string }>(`/jobs/${jobId}/${action}`, { method: 'POST' })
      setEvaluation(await api<ReportEvaluation>(`/report-evaluations/${result.evaluation_run_id ?? evaluation.id}`))
      setNotice(action === 'retry' ? '已创建新的评估记录，原结果保留。' : '评估已取消')
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  async function startReportEvaluation() {
    if (!activeId) { setNotice('先保存判断口径，再评估研报'); return }
    setBusy(true); setNotice('')
    try {
      const result = await api<ReportEvaluation & { job_id?: string }>(`/filters/${activeId}/evaluate-reports?version=${version}`, {
        method: 'POST', body: JSON.stringify({ as_of: evaluationAsOf }),
      })
      setEvaluation(result)
      setNotice(result.status === 'blocked_dependency' ? String(result.coverage.message ?? '评估依赖未满足') : '研报评估任务已提交')
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  async function confirmReportSecurity(documentId: string) {
    setBusy(true)
    try {
      const result = await api<{ stock_code: string }>(`/documents/${documentId}/confirm-llm-security-binding`, { method: 'POST' })
      if (activeId) {
        try {
          const refreshed = await api<ReportEvaluation>(`/filters/${activeId}/evaluate-reports?version=${version}`, {
            method: 'POST', body: JSON.stringify({ as_of: evaluationAsOf }),
          })
          setEvaluation(refreshed)
          setNotice(`已确认 ${result.stock_code}，正在刷新当前口径的策略证券映射。`)
        } catch (error) { setNotice(`已确认 ${result.stock_code}，但评估刷新失败：${(error as Error).message}`) }
      } else setNotice(`已确认 ${result.stock_code}，请重新运行研报条件以刷新策略映射。`)
      return result.stock_code
    } catch (error) {
      setNotice((error as Error).message)
      return null
    } finally { setBusy(false) }
  }

  function updateCriterion(index: number, patch: Partial<Criterion>) {
    setCriteria((current) => current.map((criterion, position) => position === index ? { ...criterion, ...patch } : criterion))
  }

  return (
    <div className="page-content">
      <div className="page-heading"><div><p className="eyebrow">条件资产 · {library === 'news' ? 'Tushare 适配预留' : library === 'report' ? '版本化证据判断' : '确定性计算'}</p><h1>{copy.title}</h1></div><span className="plain-state"><span className="status-dot warning" />{library === 'news' ? '数据源未接入' : library === 'report' ? '评估需文本模型' : '行情口径待核验'}</span></div>
      <div className="dependency-banner"><span className="status-dot warning" /><div><strong>{copy.intro}</strong><p>{copy.dependency}</p></div></div>
      <div className="library-layout">
        <aside className="asset-rail">
          <div className="rail-heading"><strong>已保存条件</strong><button className="text-button" onClick={resetForm}>新建</button></div>
          {items.map((item) => <button className={`asset-row ${activeId === item.id ? 'selected' : ''}`} key={item.id} onClick={() => load(item)}>
            <span className="asset-row-title">{item.name}</span><span className="asset-row-meta">v{item.version} · {item.created_at.slice(0, 10)}</span>
          </button>)}
          {!items.length && <div className="rail-empty">保存后的条件会显示在这里。</div>}
        </aside>

        <div className="library-workspace">
          <section className="conversation-panel">
            <div className="panel-heading"><div><MessageSquareText size={16} /><strong>条件对话</strong></div><span>结构化草稿</span></div>
            <label className="sr-only" htmlFor="filter-prompt">筛选要求</label>
            <textarea id="filter-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={copy.placeholder} rows={3} />
            <div className="conversation-footer"><span>{draftSource === 'configured_llm' ? '已配置文本模型' : library === 'report' ? '本地通用判断模板' : '本地规则解析'}</span><button className="secondary-button compact" onClick={makeDraft} disabled={busy}><Sparkles size={14} />生成条件草稿</button></div>
          </section>

          <section className="condition-editor">
            <div className="panel-heading"><div><SlidersIcon /><strong>条件编辑器</strong></div><span>{version ? `当前 v${version}` : '未保存草稿'}</span></div>
            <div className="form-grid two-col">
              <label className="field"><span>条件名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label className="field"><span>说明</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="条件的适用范围与默认假设" /></label>
            </div>
            {library === 'report' ? <div className="rubric-editor">
              <div className="rubric-heading"><div><strong>判断标准</strong><small>模型按这些标准查找支持与反向证据；未提及将标为 unknown。</small></div><label className="field"><span>标准关系</span><select value={combineCriteria} onChange={(event) => setCombineCriteria(event.target.value as 'all' | 'any')}><option value="all">全部满足</option><option value="any">任一满足</option></select></label></div>
              {criteria.map((criterion, index) => <div className="rubric-criterion" key={criterion.id}>
                <div className="rubric-criterion-heading"><span className="rubric-index">{String(index + 1).padStart(2, '0')}</span><label className="field grow"><span>维度名称</span><input value={criterion.label} onChange={(event) => updateCriterion(index, { label: event.target.value })} /></label><button className="table-action danger-action" title="移除判断维度" disabled={criteria.length <= 1} onClick={() => setCriteria((current) => current.filter((_, position) => position !== index))}>×</button></div>
                <label className="field"><span>判断问题</span><textarea rows={3} value={criterion.question} onChange={(event) => updateCriterion(index, { question: event.target.value })} /></label>
                <label className="field"><span>关注信号（逗号分隔）</span><input value={criterion.signals.join('，')} onChange={(event) => updateCriterion(index, { signals: splitSignals(event.target.value) })} /></label>
                <label className="field"><span>反向信号（逗号分隔）</span><input value={criterion.counter_signals.join('，')} onChange={(event) => updateCriterion(index, { counter_signals: splitSignals(event.target.value) })} /></label>
              </div>)}
              <div className="rubric-footer"><button className="secondary-button compact" disabled={criteria.length >= 8} onClick={() => setCriteria((current) => [...current, { id: `criterion_${Date.now()}`, label: '新增判断维度', question: '', signals: [], counter_signals: [] }])}>添加判断维度</button><label className="field"><span>回溯自然日</span><input type="number" min={1} max={3650} value={lookback} onChange={(event) => setLookback(Number(event.target.value))} /></label></div>
            </div> : library === 'technical' && kind !== 'evidence_query' ? <>
              <div className="segmented compact-segment">
                <button className={kind === 'indicator_compare' ? 'selected' : ''} onClick={() => setKind('indicator_compare')}>指标比较</button>
                <button className={kind === 'ma_cross' ? 'selected' : ''} onClick={() => setKind('ma_cross')}>均线穿越</button>
              </div>
              {kind === 'ma_cross' ? <div className="rule-line">
                <span>MA</span><NumberField value={fast} onChange={setFast} min={2} max={249} /><select aria-label="穿越方向" value={direction} onChange={(event) => setDirection(event.target.value)}><option value="up">上穿</option><option value="down">下穿</option></select><span>MA</span><NumberField value={slow} onChange={setSlow} min={3} max={250} />
              </div> : <div className="rule-line wrap-line">
                <label className="field"><span>指标</span><select value={indicator} onChange={(event) => { const next = event.target.value; setIndicator(next); if (next !== 'sma') setField('close'); if (next.startsWith('macd_')) setWindow(9); else if (next.startsWith('kdj_')) setWindow(9); else if (next === 'atr') setWindow(14) }}><option value="sma">简单均线 SMA</option><option value="ema">指数均线 EMA</option><option value="rsi">RSI</option><option value="bollinger">布林上轨</option><option value="macd_dif">MACD DIF</option><option value="macd_dea">MACD DEA</option><option value="macd_hist">MACD 柱值</option><option value="kdj_k">KDJ K</option><option value="kdj_d">KDJ D</option><option value="kdj_j">KDJ J</option><option value="atr">ATR</option></select></label>
                {indicator === 'sma' && <label className="field"><span>计算字段</span><select value={field} onChange={(event) => setField(event.target.value)}><option value="close">收盘价</option><option value="volume">成交量</option></select></label>}
                <label className="field"><span>{indicator.startsWith('macd_') ? 'MACD 信号期' : '窗口'}</span><input type="number" min={2} max={indicator.startsWith('kdj_') || indicator === 'atr' ? 100 : 250} value={window} disabled={indicator.startsWith('macd_')} onChange={(event) => setWindow(Number(event.target.value))} /></label>
                <label className="field"><span>比较</span><select value={operator} onChange={(event) => setOperator(event.target.value)}><option value="gt">大于</option><option value="gte">大于等于</option><option value="lt">小于</option><option value="lte">小于等于</option><option value="eq">等于</option></select></label>
                <label className="field"><span>比较对象</span><select value={target} onChange={(event) => setTarget(event.target.value)}><option value="close">当前收盘价</option><option value="open">当前开盘价</option><option value="high">当前最高价</option><option value="low">当前最低价</option><option value="volume">当前成交量</option><option value="amount">当前成交额</option><option value="value">固定数值</option></select></label>
                {target === 'value' && <label className="field"><span>阈值</span><input type="number" step="any" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label>}
              </div>}
            </> : <div className="rule-line wrap-line">
              <label className="field grow"><span>同一页需出现的关键词</span><input value={terms} onChange={(event) => setTerms(event.target.value)} /></label>
              <label className="field"><span>回溯自然日</span><input type="number" min={1} max={3650} value={lookback} onChange={(event) => setLookback(Number(event.target.value))} /></label>
            </div>}
            <div className="expression-preview"><span>规则预览</span><code>{expressionLabel(expression)}</code></div>
            <div className="button-row"><button className="secondary-button" onClick={validate}><Check size={15} />校验依赖</button><button className="primary-button" disabled={busy} onClick={save}><Save size={15} />保存新版本</button></div>
          </section>

          {library !== 'news' && <section className="preview-panel">
            <div className="panel-heading"><div><Play size={15} /><strong>{library === 'report' ? '按口径评估本地研报' : '单证券试算'}</strong></div><span>{library === 'report' ? '异步 · 逐条校验引用' : '探索模式'}</span></div>
            {library === 'report' ? <>
              <div className="preview-control"><label className="field"><span>报告截止日</span><input type="date" value={evaluationAsOf} onChange={(event) => setEvaluationAsOf(event.target.value)} /></label><button className="secondary-button" disabled={busy || !activeId} onClick={startReportEvaluation}><Play size={14} />评估研报</button></div>
              <div className="search-scope-note">评估会将回溯范围内的研报文本发送到已配置的模型服务；模型结果、验证后的原文引用和评估版本保存在本地。</div>
              {evaluation && <ReportEvaluationPanel evaluation={evaluation} busy={busy} onConfirmLlm={confirmReportSecurity} onJobAction={controlEvaluation} />}
            </> : <>
              <div className="preview-control"><label className="field"><span>证券代码</span><input value={stock} onChange={(event) => setStock(event.target.value.toUpperCase())} /></label><button className="secondary-button" disabled={busy || !activeId} onClick={tryPreview}><Play size={14} />试算</button></div>
              {preview && <div className={`preview-result ${preview.state}`}><strong>{stateName(preview.state)}</strong>{preview.actual !== undefined && <span>实际值 {format(preview.actual)} {preview.operator} {format(preview.threshold)}</span>}<small>{preview.reason ?? preview.warning}</small></div>}
            </>}
          </section>}

          {blockers.length > 0 && <div className="dependency-list">{blockers.map((item) => <div key={item}><span className="status-dot warning" />{item}</div>)}</div>}
          {notice && <div className="inline-notice" role="status">{notice}</div>}
        </div>
      </div>
    </div>
  )
}

function NumberField({ value, onChange, min, max }: { value: number; onChange: (value: number) => void; min: number; max: number }) {
  return <input className="short-number" type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
}

function SlidersIcon() { return <span className="mini-slider-icon">≡</span> }
function format(value?: number) { return value === undefined ? '—' : Number(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') }
function stateName(state: string) { return state === 'true' ? '命中' : state === 'false' ? '未命中' : state === 'blocked_dependency' ? '依赖阻断' : '状态未知' }
function expressionLabel(value: Record<string, unknown>) {
  if (value.evaluation_mode === 'rubric') return `研报判断口径：${Array.isArray(value.criteria) ? value.criteria.map((item) => (item as Criterion).label).join(value.combine === 'all' ? ' + ' : ' / ') : '待编辑'} · 回溯 ${value.lookback_calendar_days} 日`
  if (value.op === 'evidence_query') return `同一页包含 ${Array.isArray(value.terms) ? value.terms.join('、') : '关键词'}，回溯 ${value.lookback_calendar_days} 日`
  if (value.op === 'ma_cross') return `MA${value.fast_window} ${value.direction === 'down' ? '向下' : '向上'}穿越 MA${value.slow_window}`
  if (value.compare_field === 'close') return `收盘价 ${invertLabel(String(value.operator))} ${String(value.indicator).toUpperCase()}(${value.window})`
  return `${String(value.indicator).toUpperCase()}(${value.window}) ${String(value.operator)} ${value.compare_field ?? value.value}`
}

function invertLabel(operator: string) {
  return ({ lt: '>', gt: '<', lte: '>=', gte: '<=', eq: '=' } as Record<string, string>)[operator] ?? operator
}

function normalizeCriteria(value: unknown): Criterion[] {
  if (!Array.isArray(value)) return [initialCriterion]
  const valid = value.filter((item): item is Criterion => Boolean(item && typeof item === 'object' && typeof (item as Criterion).id === 'string' && typeof (item as Criterion).label === 'string' && typeof (item as Criterion).question === 'string'))
  return valid.length ? valid.map((item) => ({
    id: item.id,
    label: item.label,
    question: item.question,
    signals: Array.isArray(item.signals) ? item.signals.map(String) : [],
    counter_signals: Array.isArray(item.counter_signals) ? item.counter_signals.map(String) : [],
  })) : [initialCriterion]
}

function splitSignals(value: string) {
  return value.split(/[，,;；]+/).map((item) => item.trim()).filter(Boolean).slice(0, 12)
}

function todayLocal() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function ReportEvaluationPanel({ evaluation, busy, onConfirmLlm, onJobAction }: { evaluation: ReportEvaluation; busy: boolean; onConfirmLlm: (documentId: string) => Promise<string | null>; onJobAction: (action: 'cancel' | 'retry') => Promise<void> }) {
  const coverage = evaluation.coverage
  const assessments = evaluation.result.assessments ?? []
  const state = evaluation.status
  const [confirmedBindings, setConfirmedBindings] = useState<Record<string, string>>({})
  return <div className="report-evaluation-result">
    <div className="evaluation-summary">
      <span className={`status-pill ${state}`}>{evaluationStatus(state)}</span>
      <span>模型：{evaluation.model}</span>
      <span>截止 {evaluation.as_of}</span>
      {evaluation.job && <span>{evaluation.job.message} {Math.round(evaluation.job.progress * 100)}%</span>}
      {(evaluation.job?.id || evaluation.job_id) && <div className="job-actions">{['queued', 'running'].includes(state) && <button className="secondary-button compact" disabled={busy} onClick={() => onJobAction('cancel')}>取消评估</button>}{['failed', 'cancelled', 'partial'].includes(state) && <button className="secondary-button compact" disabled={busy} onClick={() => onJobAction('retry')}>重试评估</button>}</div>}
    </div>
    {Object.entries(coverage).length > 0 && <div className="evaluation-coverage">
      <span>本地报告 {String(coverage.documents_indexed ?? 0)}</span>
      <span>范围内 {String(coverage.documents_in_window ?? 0)}</span>
      <span>可用日期未确认 {String(coverage.excluded_unconfirmed_availability_date ?? 0)}</span>
      <span>已评估 {String(coverage.evaluated ?? 0)}</span>
      <span>已确认代码 {String(coverage.confirmed_security_bindings ?? 0)}</span>
      {Number(coverage.excluded_after_as_of ?? 0) > 0 && <span>截止日后排除 {String(coverage.excluded_after_as_of)}</span>}
      {Number(coverage.excluded_missing_publication_date ?? 0) > 0 && <span>日期待核验 {String(coverage.excluded_missing_publication_date)}</span>}
    </div>}
    {typeof coverage.message === 'string' && <div className="dependency-row">{coverage.message}</div>}
    {assessments.map((assessment) => <article className="assessment-card" key={assessment.document_id}>
      <div className="assessment-heading"><div><strong>{assessment.title}</strong><small>首次可用 {assessment.available_at}{assessment.availability_status === 'confirmed' ? '' : '（未确认）'} · 文件日期候选 {assessment.publication_date} · {assessment.stock_code ?? assessment.candidate_code ?? '证券代码待确认'} · {confirmedBindings[assessment.document_id] ? `已确认 ${confirmedBindings[assessment.document_id]}` : bindingStatusName(assessment.binding_status)}</small></div><span className={`state-text ${assessment.state}`}>{stateName(assessment.state)}</span></div>
      {assessment.security_candidates?.length ? <div className="assessment-security-candidates"><strong>LLM 证券代码候选 · {evaluation.model}</strong>{assessment.security_candidates.map((candidate, index) => <div className="assessment-security-candidate" key={`${candidate.canonical_code}-${candidate.page}-${index}`}><span><b>{candidate.company_name || candidate.canonical_code}</b> · {candidate.canonical_code} · {securityRoleName(candidate.role)} · p.{candidate.page}</span><q>{candidate.quote}</q></div>)}{assessment.binding_status === 'llm_candidate' && !confirmedBindings[assessment.document_id] && <button className="secondary-button compact" disabled={busy} onClick={async () => { const code = await onConfirmLlm(assessment.document_id); if (code) setConfirmedBindings((current) => ({ ...current, [assessment.document_id]: code })) }}><Check size={13} />确认 LLM 主体代码</button>}</div> : null}
      {assessment.criteria.map((criterion) => <div className="assessment-criterion" key={criterion.criterion_id}>
        <div className="assessment-criterion-title"><b>{criterion.label}</b><span className={`state-text ${criterion.state}`}>{stateName(criterion.state)}</span></div>
        <p>{criterion.summary}</p>
        {criterion.evidence.map((evidence, index) => <blockquote key={`${evidence.page}-${index}`}><span>p.{evidence.page} · {evidenceType(evidence.evidence_type)}{evidence.period ? ` · ${evidence.period}` : ''}</span><q>{evidence.quote}</q></blockquote>)}
      </div>)}
    </article>)}
    {state === 'queued' || state === 'running' ? null : assessments.length === 0 && !coverage.message && <div className="empty-inline">截止日和回溯范围内没有可评估的已索引研报。空范围不会返回未命中。</div>}
    <div className="evaluation-footnote">只覆盖已索引的本地研报，不代表全市场报告完整；没有研报或证据不足均为 unknown。引用经过页内原文校验。</div>
  </div>
}

function evaluationStatus(status: string) {
  const labels: Record<string, string> = { queued: '排队中', running: '评估中', succeeded: '已完成', partial: '覆盖不完整', failed: '失败', cancelled: '已取消', blocked_dependency: '模型未配置' }
  return labels[status] ?? status
}

function evidenceType(type: string) {
  const labels: Record<string, string> = { reported_fact: '报告事实', company_statement: '公司表述', analyst_opinion: '分析师观点', forecast: '预测', counter_evidence: '反向证据' }
  return labels[type] ?? type
}

function bindingStatusName(status: string) {
  const labels: Record<string, string> = { confirmed: '代码已确认', llm_candidate: 'LLM 唯一主体候选待确认', llm_ambiguous: 'LLM 多主体候选待核对', llm_subject_unclear: 'LLM 未确认主体代码', llm_no_candidate: 'LLM 未识别代码', filename_candidate: '文件名备用候选待核对' }
  return labels[status] ?? '证券代码待核对'
}

function securityRoleName(role: string) {
  const labels: Record<string, string> = { issuer: '报告主体', subsidiary: '子公司', peer: '同行', customer: '客户', supplier: '供应商', index: '指数', unclear: '主体不明确' }
  return labels[role] ?? '主体不明确'
}
