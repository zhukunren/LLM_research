import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, GitBranch, Plus, Save, Search, Trash2, X } from 'lucide-react'
import { api, type Filter, type Pattern, type Strategy } from '../api'
import { applyConditionParameters, conditionParameter, conditionText } from '../conditionText'

export type Node = {
  op: string; children?: Node[]; filter_id?: string; pattern_id?: string; version?: number
  score_weight?: number; parameter_overrides?: Record<string, number | string>; min_similarity?: number; match_mode?: 'current' | 'recent'; recent_bars?: number
}
export type Asset = { key: string; label: string; filter?: Filter; pattern?: Pattern }
const emptyTree = (): Node => ({ op: 'all', children: [] })
const assetKey = (node: Node) => `${node.op === 'pattern_ref' ? 'pattern' : 'filter'}:${node.pattern_id ?? node.filter_id}@${node.version}`
const referenceCount = (node: Node): number => node.op.endsWith('_ref') ? 1 : (node.children ?? []).reduce((count, child) => count + referenceCount(child), 0)

function makeReference(asset: Asset): Node {
  return asset.pattern
    ? { op: 'pattern_ref', pattern_id: asset.pattern.id, version: asset.pattern.version, score_weight: 1, min_similarity: Number(asset.pattern.params.min_similarity ?? 80), match_mode: asset.pattern.params.match_mode === 'recent' ? 'recent' : 'current', recent_bars: Number(asset.pattern.params.recent_bars ?? 20) }
    : { op: 'filter_ref', filter_id: asset.filter!.id, version: asset.filter!.version, score_weight: 1 }
}

export default function StrategyPage() {
  const [filters, setFilters] = useState<Filter[]>([])
  const [patterns, setPatterns] = useState<Pattern[]>([])
  const [strategies, setStrategies] = useState<Strategy[]>([])
  const [tree, setTree] = useState<Node>(emptyTree)
  const [activeId, setActiveId] = useState('')
  const [activeVersion, setActiveVersion] = useState(0)
  const [name, setName] = useState('综合研究策略')
  const [topN, setTopN] = useState(30)
  const [notice, setNotice] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      const [f, p, s] = await Promise.all([
        api<{ items: Filter[] }>('/filters?include_history=true'),
        api<{ items: Pattern[] }>('/patterns?include_history=true'),
        api<{ items: Strategy[] }>('/strategies?include_history=true'),
      ])
      setFilters(f.items); setPatterns(p.items); setStrategies(s.items)
    } catch (error) { setNotice((error as Error).message) }
  }
  useEffect(() => { void refresh() }, [])

  const catalog = useMemo<Asset[]>(() => [
    ...filters.map((filter) => ({ key: `filter:${filter.id}@${filter.version}`, label: `${filter.name} · v${filter.version} · ${filter.library === 'technical' ? '技术' : filter.library === 'news' ? '资讯' : '研报'}`, filter })),
    ...patterns.map((pattern) => ({ key: `pattern:${pattern.id}@${pattern.version}`, label: `${pattern.name} · v${pattern.version} · 形态`, pattern })),
  ], [filters, patterns])

  function load(strategy: Strategy) {
    setTree(structuredClone(strategy.tree) as Node)
    setActiveId(strategy.id); setActiveVersion(strategy.version); setName(strategy.name); setTopN(strategy.top_n)
    setErrors([]); setNotice(`已载入 v${strategy.version}，完整保留分组、取反和参数。保存将创建新版本。`)
  }

  async function validate() {
    setBusy(true); setNotice('')
    try {
      const result = await api<{ valid: boolean; errors: string[] }>('/strategies/validate', { method: 'POST', body: JSON.stringify({ tree }) })
      setErrors(result.errors); setNotice(result.valid ? '逻辑、固定版本引用和参数均通过校验。' : '请修正下方问题。')
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  async function save() {
    setBusy(true); setNotice('')
    try {
      const result = await api<Strategy>('/strategies', { method: 'POST', body: JSON.stringify({ id: activeId || undefined, name, tree, top_n: topN }) })
      setActiveId(result.id); setActiveVersion(result.version); await refresh()
      setNotice(`已发布 ${result.name} v${result.version}`); setErrors([])
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  function reset() {
    setTree(emptyTree()); setActiveId(''); setActiveVersion(0); setName('综合研究策略'); setTopN(30); setErrors([]); setNotice('')
  }

  return <div className="page-content">
    <div className="page-heading"><div><h1>筛选设置</h1></div><button className="secondary-button" onClick={reset}><Plus size={15} />新建策略</button></div>
    <div className="strategy-layout">
      <aside className="asset-rail strategy-rail"><div className="rail-heading"><strong>策略版本</strong><span>{strategies.length}</span></div>
        {strategies.map((item) => <button className={`asset-row ${activeId === item.id && activeVersion === item.version ? 'selected' : ''}`} key={`${item.id}@${item.version}`} onClick={() => load(item)}>
          <span className="asset-row-title">{item.name}</span><span className="asset-row-meta">v{item.version} · Top {item.top_n}</span>
        </button>)}
        {!strategies.length && <div className="side-empty">暂无策略</div>}
      </aside>
      <div className="strategy-main"><section className="editor-card">
        <div className="section-title-row"><h2><GitBranch size={17} />组合策略</h2><span>{referenceCount(tree)} 项条件{activeVersion ? ` · 基于 v${activeVersion}` : ''}</span></div>
        <div className="form-grid"><label>策略名称<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label><label>结果数量 TopN<input type="number" min={1} max={500} value={topN} onChange={(event) => setTopN(Number(event.target.value))} /></label></div>
        <NodeEditor node={tree} catalog={catalog} onChange={setTree} depth={0} />
        <div className="strategy-actions"><button className="secondary-button" disabled={busy} onClick={validate}><Check size={15} />校验策略</button><button className="primary-button" disabled={busy || !name.trim() || !referenceCount(tree)} onClick={save}><Save size={15} />发布新版本</button></div>
        {!!errors.length && <div className="error-list">{errors.map((error, index) => <div key={index}>{error}</div>)}</div>}
        {notice && <div className="inline-notice" role="status">{notice}</div>}
      </section>
      </div>
    </div>
  </div>
}


const kindNames: Record<string, string> = { technical: '行情', news: '资讯', report: '研报', pattern: '形态' }
const assetKind = (asset: Asset) => asset.pattern ? 'pattern' : asset.filter!.library

function ConditionPicker({ catalog, onAdd, disabled, initialOpen, onCreate }: { catalog: Asset[]; onAdd: (asset: Asset) => void; disabled: boolean; initialOpen: boolean; onCreate?: () => void }) {
  const [open, setOpen] = useState(initialOpen)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [history, setHistory] = useState(false)
  const [limit, setLimit] = useState(8)
  const latest = useMemo(() => {
    const versions = new Map<string, number>()
    catalog.forEach(asset => { const item = asset.filter ?? asset.pattern!; const key = assetKind(asset) + ':' + item.id; versions.set(key, Math.max(versions.get(key) ?? 0, item.version)) })
    return versions
  }, [catalog])
  const matches = catalog.filter(asset => {
    const item = asset.filter ?? asset.pattern!
    return (!kind || assetKind(asset) === kind) && (history || latest.get(assetKind(asset) + ':' + item.id) === item.version)
      && [asset.label, asset.filter?.description, asset.filter?.contract?.summary, asset.filter?.provenance?.prompt].join(' ').toLowerCase().includes(query.trim().toLowerCase())
  })
  return <div className="condition-picker">
    <button type="button" className="secondary-button condition-picker-launch" disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)}><Plus size={14} />添加条件<ChevronDown size={14} /></button>
    {open && <div className="condition-picker-panel">
      <div className="condition-picker-controls"><label className="workspace-search"><Search size={15} /><input aria-label="查找可用条件" placeholder="搜索名称或判断口径" value={query} disabled={disabled} onChange={event => { setQuery(event.target.value); setLimit(8) }} /></label><select aria-label="筛选可用条件类型" value={kind} disabled={disabled} onChange={event => { setKind(event.target.value); setLimit(8) }}><option value="">全部类型</option>{Object.entries(kindNames).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select><button className="icon-button" type="button" aria-label="收起条件选择" onClick={() => setOpen(false)}><X size={15} /></button></div>
      <div className="condition-picker-caption"><span>{matches.length} 个可用版本</span><label><input type="checkbox" checked={history} disabled={disabled} onChange={event => { setHistory(event.target.checked); setLimit(8) }} />显示历史版本</label></div>
      <div className="condition-picker-list">{matches.slice(0,limit).map(asset => { const item = asset.filter ?? asset.pattern!; return <button type="button" key={asset.key} disabled={disabled} aria-label={'添加 ' + item.name + ' 第 ' + item.version + ' 版'} onClick={() => { onAdd(asset); setOpen(false) }}><span className="condition-kind">{kindNames[assetKind(asset)]}</span><span><strong>{item.name}</strong><small>{asset.filter?.contract?.summary ?? asset.filter?.description ?? asset.pattern?.target_bars + ' 根 K 线'}</small></span><span className="condition-version">v{item.version}</span><Plus size={14} /></button> })}</div>
      {!matches.length && <div className="condition-picker-empty"><p>{catalog.length ? '没有找到符合筛选的条件。' : '暂无已保存条件。'}</p>{query || kind ? <button className="text-button" type="button" onClick={() => { setQuery(''); setKind('') }}>清除筛选</button> : onCreate && <button className="text-button" type="button" onClick={onCreate}>去描述条件</button>}</div>}
      {matches.length > limit && <button className="text-button" type="button" onClick={() => setLimit(value => value + 8)}>显示更多条件</button>}
    </div>}
  </div>
}

export function ParameterNumber({ label, value, min, max, step, integer = false, disabled, onChange }: { label: string; value: number; min?: number; max?: number; step?: number | 'any'; integer?: boolean; disabled: boolean; onChange: (value: number | undefined) => void }) {
  const [raw, setRaw] = useState(String(value))
  const editing = useRef(false)
  useEffect(() => { if (!editing.current) setRaw(String(value)) }, [value])
  const parsed = Number(raw)
  const invalid = raw !== '' && (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || (min != null && parsed < min) || (max != null && parsed > max))
  return <label className="strategy-number-field">{label}<input aria-label={label} aria-invalid={invalid || undefined} type="number" value={raw} min={min} max={max} step={step ?? (integer ? 1 : 'any')} disabled={disabled} onFocus={() => { editing.current = true }} onChange={event => { setRaw(event.target.value); onChange(event.target.value === '' ? undefined : Number(event.target.value)) }} onBlur={() => { editing.current = false; if (!raw.trim()) setRaw(String(value)) }} />{invalid && <small>请核对数值范围</small>}</label>
}

export function NodeEditor({ node, catalog, onChange, onRemove, depth, disabled = false, onCreateCondition }: { node: Node; catalog: Asset[]; onChange: (node: Node) => void; onRemove?: () => void; depth: number; disabled?: boolean; onCreateCondition?: () => void }) {
  if (node.op === 'filter_ref' || node.op === 'pattern_ref') {
    const asset = catalog.find(item => item.key === assetKey(node))
    const parameters = asset?.filter?.parameters ?? {}
    const expression = asset?.filter ? applyConditionParameters(asset.filter.expression, node.parameter_overrides) : undefined
    const item = asset?.filter ?? asset?.pattern
    const versions = catalog.filter(candidate => node.op === 'filter_ref' ? candidate.filter?.id === node.filter_id : candidate.pattern?.id === node.pattern_id)
    const override = (key: string, value: string, numeric: boolean) => {
      const updated = { ...node.parameter_overrides }
      if (value === '') delete updated[key]; else updated[key] = numeric ? Number(value) : value
      const next: Node = { ...node, parameter_overrides: updated }
      if (!Object.keys(updated).length) delete next.parameter_overrides
      onChange(next)
    }
    function numberChange(key: 'score_weight' | 'min_similarity' | 'recent_bars', value: number | undefined) { const next = { ...node }; if(value == null) delete next[key]; else next[key] = value; onChange(next) }
    return <div className="strategy-reference">
      <div className="strategy-reference-heading"><div className="strategy-reference-identity"><span className="condition-kind">{asset ? kindNames[assetKind(asset)] : '未载入'}</span><strong>{item?.name ?? node.filter_id ?? node.pattern_id}</strong><span className="condition-version">v{node.version}</span></div><div className="heading-actions"><button type="button" className="quiet-button" disabled={disabled || depth >= 15} onClick={() => onChange({ op: 'not', children: [node] })}>排除</button>{onRemove && <button type="button" className="icon-button danger-action" disabled={disabled} aria-label="移除条件" onClick={onRemove}><Trash2 size={14} /></button>}</div></div>
      {asset?.filter?.contract && expression && <p className="strategy-rule-summary">{conditionText(asset.filter.library, expression, asset.filter.contract.summary)}</p>}
      <details className="condition-adjustments"><summary>本次参数<span>权重 {node.score_weight ?? 1} · {Object.keys(node.parameter_overrides ?? {}).length ? '已覆盖 ' + Object.keys(node.parameter_overrides!).length + ' 项' : '采用默认参数'}</span></summary>
        <div className="strategy-parameters">
          <label>固定引用版本<select aria-label="引用版本" value={assetKey(node)} disabled={disabled} onChange={event => { const version = catalog.find(candidate => candidate.key === event.target.value); if (version) onChange({ ...node, version: (version.filter ?? version.pattern!).version }) }}>{!asset && <option value={assetKey(node)}>v{node.version} · 当前未载入</option>}{versions.map(version => <option key={version.key} value={version.key}>第 {(version.filter ?? version.pattern!).version} 版</option>)}</select></label>
          <ParameterNumber label="评分权重" value={node.score_weight ?? 1} min={0} max={100} step={0.25} disabled={disabled} onChange={value => numberChange('score_weight',value)} />
          {Object.entries(parameters).map(([key, spec]) => spec.type === 'enum' ? <label key={key}>{spec.label}<select aria-label={spec.label} value={String(node.parameter_overrides?.[key] ?? (expression ? conditionParameter(expression,key) : undefined) ?? 'up')} disabled={disabled} onChange={event => override(key,event.target.value,false)}>{Object.entries(spec.options ?? {}).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label> : <ParameterNumber key={key} label={spec.label} value={Number(node.parameter_overrides?.[key] ?? (expression ? conditionParameter(expression,key) : undefined) ?? 0)} min={spec.min} max={spec.max} integer={spec.type === 'integer'} disabled={disabled} onChange={value => override(key,value == null ? '' : String(value),true)} />)}
          {node.op === 'pattern_ref' && <><ParameterNumber label="最低相似度" value={node.min_similarity ?? Number(asset?.pattern?.params.min_similarity ?? 80)} min={0} max={100} step={0.5} disabled={disabled} onChange={value => numberChange('min_similarity',value)} /><label>匹配窗口<select aria-label="形态匹配窗口" value={node.match_mode ?? (asset?.pattern?.params.match_mode === 'recent' ? 'recent' : 'current')} disabled={disabled} onChange={event => onChange({ ...node, match_mode: event.target.value as 'current' | 'recent', recent_bars: node.recent_bars ?? Number(asset?.pattern?.params.recent_bars ?? 20) })}><option value="current">当前窗口</option><option value="recent">近期最相近窗口</option></select></label>{(node.match_mode ?? asset?.pattern?.params.match_mode) === 'recent' && <ParameterNumber label="近期回看交易日数" value={node.recent_bars ?? Number(asset?.pattern?.params.recent_bars ?? 20)} min={1} max={120} integer disabled={disabled} onChange={value => numberChange('recent_bars',value)} />}</>}
          {!!Object.keys(node.parameter_overrides ?? {}).length && <button type="button" className="text-button" disabled={disabled} onClick={() => { const next = { ...node }; delete next.parameter_overrides; onChange(next) }}>恢复条件默认参数</button>}
        </div>
      </details>
    </div>
  }
  const children = node.children ?? []
  const add = (child: Node) => onChange({ ...node, children: [...children, child] })
  return <div className={'strategy-node ' + (node.op === 'not' ? 'strategy-negation' : '')}>
    <div className="strategy-node-heading"><span className="strategy-logic-label">{depth ? '条件组' : '选股逻辑'}</span><select aria-label={depth ? '分组逻辑' : '顶层逻辑'} value={node.op} disabled={disabled} onChange={event => { const op = event.target.value; onChange(op === 'not' && children.length > 1 ? { op, children: [node] } : { ...node, op }) }}><option value="all">全部满足（AND）</option><option value="any">任一满足（OR）</option><option value="not">整体排除（NOT）</option></select><span className="strategy-group-count">{referenceCount(node)} 项条件</span>{node.op === 'not' && children.length === 1 && <button type="button" className="text-button" disabled={disabled} onClick={() => onChange(children[0])}>取消排除</button>}{onRemove && <button type="button" className="icon-button danger-action" disabled={disabled} aria-label="移除分组" onClick={onRemove}><Trash2 size={14} /></button>}</div>
    <div className="strategy-node-children">{children.map((child,index) => <NodeEditor key={index} node={child} catalog={catalog} depth={depth+1} disabled={disabled} onCreateCondition={onCreateCondition} onChange={next => onChange({ ...node, children: children.map((item,i) => i === index ? next : item) })} onRemove={() => onChange({ ...node, children: children.filter((_,i) => i !== index) })} />)}</div>
    {(node.op !== 'not' || !children.length) && depth < 15 && <div className="strategy-add-row"><ConditionPicker catalog={catalog} disabled={disabled} initialOpen={!children.length} onCreate={onCreateCondition} onAdd={asset => add(makeReference(asset))} /><button type="button" className="quiet-button" disabled={disabled} onClick={() => add(emptyTree())}><Plus size={14} />添加分组</button></div>}
    {!children.length && <p className="strategy-empty-group">空分组无法保存或执行。</p>}
  </div>
}
