import { useEffect, useMemo, useState } from 'react'
import { Check, GitBranch, Plus, Save, Trash2 } from 'lucide-react'
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
    <div className="page-heading"><div><p className="eyebrow">可复用条件 · 参数调整 · 历史版本</p><h1>筛选设置</h1></div><button className="secondary-button" onClick={reset}><Plus size={15} />新建策略</button></div>
    <div className="strategy-layout">
      <aside className="asset-rail strategy-rail"><div className="rail-heading"><strong>策略版本</strong><span>{strategies.length}</span></div>
        {strategies.map((item) => <button className={`asset-row ${activeId === item.id && activeVersion === item.version ? 'selected' : ''}`} key={`${item.id}@${item.version}`} onClick={() => load(item)}>
          <span className="asset-row-title">{item.name}</span><span className="asset-row-meta">v{item.version} · Top {item.top_n}</span>
        </button>)}
        {!strategies.length && <div className="side-empty">组合条件后发布第一条策略。</div>}
      </aside>
      <div className="strategy-main"><section className="editor-card">
        <div className="section-title-row"><h2><GitBranch size={17} />组合策略</h2><span>{referenceCount(tree)} 项条件{activeVersion ? ` · 基于 v${activeVersion}` : ''}</span></div>
        <div className="form-grid"><label>策略名称<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label><label>结果数量 TopN<input type="number" min={1} max={500} value={topN} onChange={(event) => setTopN(Number(event.target.value))} /></label></div>
        <p className="editor-help">同一条件可多次加入，分别调整周期或阈值。每项条件固定到所选版本。</p>
        <NodeEditor node={tree} catalog={catalog} onChange={setTree} depth={0} />
        <div className="strategy-actions"><button className="secondary-button" disabled={busy} onClick={validate}><Check size={15} />校验策略</button><button className="primary-button" disabled={busy || !name.trim() || !referenceCount(tree)} onClick={save}><Save size={15} />发布新版本</button></div>
        {!!errors.length && <div className="error-list">{errors.map((error, index) => <div key={index}>{error}</div>)}</div>}
        {notice && <div className="inline-notice" role="status">{notice}</div>}
      </section>
      <section className="strategy-notes"><h2>使用说明</h2>
        <div><span className="status-dot good" /><p>分组支持全部满足（AND）、任一满足（OR）和整体取反（NOT）。缺少证据时保留 unknown。</p></div>
        <div><span className="status-dot good" /><p>权重对命中条件评分，同分按证券代码排序。旧策略和旧运行不会随条件更新而改变。</p></div>
        <div><span className="status-dot warning" /><p>示例行情可用于探索运行。后续补齐数据后刷新数据状态；正式运行仍检查口径与依赖。</p></div>
        <div><span className="status-dot warning" /><p>研报条件需先按同一截止日完成评估。修改研报判断口径或回溯期，应另存条件版本并重新评估。</p></div>
      </section></div>
    </div>
  </div>
}

export function NodeEditor({ node, catalog, onChange, onRemove, depth }: { node: Node; catalog: Asset[]; onChange: (node: Node) => void; onRemove?: () => void; depth: number }) {
  if (node.op === 'filter_ref' || node.op === 'pattern_ref') {
    const asset = catalog.find((item) => item.key === assetKey(node))
    const parameters = asset?.filter?.parameters ?? {}
    const expression = asset?.filter ? applyConditionParameters(asset.filter.expression, node.parameter_overrides) : undefined
    const override = (key: string, value: string, numeric: boolean) => {
      const updated = { ...node.parameter_overrides }
      if (value === '') delete updated[key]
      else updated[key] = numeric ? Number(value) : value
      const next: Node = { ...node, parameter_overrides: updated }
      if (!Object.keys(updated).length) delete next.parameter_overrides
      onChange(next)
    }
    return <div className="strategy-reference">
      <div className="strategy-reference-heading"><strong>{asset?.label ?? `${node.filter_id ?? node.pattern_id} · v${node.version}`}</strong><div className="heading-actions">
        <button className="secondary-button compact" disabled={depth >= 15} onClick={() => onChange({ op: 'not', children: [node] })}>排除</button>
        {onRemove && <button className="table-action danger-action" aria-label="移除条件" onClick={onRemove}><Trash2 size={14} /></button>}
      </div></div>
      {asset?.filter?.contract && expression && <p className="editor-help">{conditionText(asset.filter.library, expression, asset.filter.contract.summary)}</p>}
      <details className="condition-adjustments"><summary>调整本次参数与排序权重{Object.keys(node.parameter_overrides ?? {}).length ? ' · 已调整' : ''}</summary><div className="strategy-parameters">
      <label className="weight-field">排序权重<input aria-label="评分权重" type="number" min={0} max={100} step={0.25} value={node.score_weight ?? 1} onChange={(event) => onChange({ ...node, score_weight: Number(event.target.value) })} /></label>
      {Object.entries(parameters).map(([key, spec]) => <label key={key}>{spec.label}
        {spec.type === 'enum' ? <select aria-label={spec.label} value={String(node.parameter_overrides?.[key] ?? (expression ? conditionParameter(expression, key) : undefined) ?? 'up')} onChange={(event) => override(key, event.target.value, false)}>{Object.entries(spec.options ?? {}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          : <input aria-label={spec.label} type="number" min={spec.min} max={spec.max} step={spec.type === 'integer' ? 1 : 'any'} value={Number(node.parameter_overrides?.[key] ?? (expression ? conditionParameter(expression, key) : undefined) ?? 0)} onChange={(event) => override(key, event.target.value, true)} />}
      </label>)}
      {node.op === 'pattern_ref' && <><label>最低相似度<input aria-label="最低相似度" type="number" min={0} max={100} step={0.5} value={node.min_similarity ?? Number(asset?.pattern?.params.min_similarity ?? 80)} onChange={(event) => onChange({ ...node, min_similarity: Number(event.target.value) })} /></label><label>匹配窗口<select aria-label="形态匹配窗口" value={node.match_mode ?? (asset?.pattern?.params.match_mode === 'recent' ? 'recent' : 'current')} onChange={(event) => onChange({ ...node, match_mode: event.target.value as 'current' | 'recent' })}><option value="current">当前窗口</option><option value="recent">近期最相近窗口</option></select></label>{(node.match_mode ?? asset?.pattern?.params.match_mode) === 'recent' && <label>近期回看<input aria-label="近期回看交易日数" type="number" min={1} max={120} value={node.recent_bars ?? Number(asset?.pattern?.params.recent_bars ?? 20)} onChange={(event) => onChange({ ...node, recent_bars: Number(event.target.value) })} /></label>}</>}
      {!!Object.keys(node.parameter_overrides ?? {}).length && <button className="text-button" onClick={() => { const next = { ...node }; delete next.parameter_overrides; onChange(next) }}>恢复条件默认参数</button>}
      </div></details>
    </div>
  }
  const children = node.children ?? []
  const add = (child: Node) => onChange({ ...node, children: [...children, child] })
  return <div className={`strategy-node ${node.op === 'not' ? 'strategy-negation' : ''}`}>
    <div className="strategy-node-heading"><select aria-label={depth ? '分组逻辑' : '顶层逻辑'} value={node.op} onChange={(event) => {
      const op = event.target.value
      onChange(op === 'not' && children.length > 1 ? { op, children: [node] } : { ...node, op })
    }}><option value="all">全部满足</option><option value="any">任一满足</option><option value="not">排除符合以下条件的股票</option></select>
      {node.op === 'not' && children.length === 1 && <button className="text-button" onClick={() => onChange(children[0])}>取消排除</button>}
      {onRemove && <button className="table-action danger-action" aria-label="移除分组" onClick={onRemove}><Trash2 size={14} /></button>}
    </div>
    {children.map((child, index) => <NodeEditor key={index} node={child} catalog={catalog} depth={depth + 1} onChange={(next) => onChange({ ...node, children: children.map((item, i) => i === index ? next : item) })} onRemove={() => onChange({ ...node, children: children.filter((_, i) => i !== index) })} />)}
    {(node.op !== 'not' || !children.length) && depth < 15 && <div className="strategy-add-row">
      <select aria-label="添加条件或形态" value="" onChange={(event) => { const asset = catalog.find((item) => item.key === event.target.value); if (asset) add(makeReference(asset)) }}><option value="">＋ 选择条件或形态版本</option>{catalog.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
      <button className="secondary-button compact" onClick={() => add(emptyTree())}><Plus size={14} />添加分组</button>
    </div>}
    {!children.length && <div className="editor-help">此组还没有条件，请添加后保存。</div>}
  </div>
}
