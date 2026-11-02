import type { Asset, Node } from '../pages/StrategyPage'
import { ParameterNumber } from '../pages/StrategyPage'
import { Info } from 'lucide-react'
import { applyConditionParameters, conditionParameter } from '../conditionText'
import { conditionAssetKey } from '../conditionTransfer'

export default function InlineConditionParameters({ node, catalog, disabled, onChange, onDetails }: {
  node: Node; catalog: Asset[]; disabled: boolean; onChange: (next: Node) => void; onDetails?: () => void
}) {
  const asset = catalog.find(item => item.key === conditionAssetKey(node))
  const parameters = asset?.filter?.parameters ?? {}
  const expression = asset?.filter ? applyConditionParameters(asset.filter.expression, node.parameter_overrides) : undefined
  function override(key: string, value: string | number | undefined) {
    const overrides = { ...node.parameter_overrides }
    if (value == null || value === '') delete overrides[key]
    else overrides[key] = value
    const next: Node = { ...node, parameter_overrides: overrides }
    if (!Object.keys(overrides).length) delete next.parameter_overrides
    onChange(next)
  }
  function numberChange(key: 'min_similarity' | 'recent_bars', value: number | undefined) {
    const next = { ...node }
    if (value == null) delete next[key]
    else next[key] = value
    onChange(next)
  }
  return <div className="condition-inline-parameters">
    <div className="condition-inline-fields">{Object.entries(parameters).map(([key, spec]) => spec.type === 'enum' ? <label key={key} className="workspace-field-label">{spec.label}<select aria-label={spec.label} disabled={disabled} value={String(node.parameter_overrides?.[key] ?? (expression ? conditionParameter(expression, key) : undefined) ?? 'up')} onChange={event => override(key, event.target.value)} className="workspace-field workspace-select">{Object.entries(spec.options ?? {}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : <ParameterNumber key={key} label={spec.label} value={Number(node.parameter_overrides?.[key] ?? (expression ? conditionParameter(expression, key) : undefined) ?? 0)} min={spec.min} max={spec.max} integer={spec.type === 'integer'} disabled={disabled} onChange={value => override(key, value)} />)}
      {node.op === 'pattern_ref' && <>
        <ParameterNumber label="最低相似度" value={node.min_similarity ?? Number(asset?.pattern?.params.min_similarity ?? 80)} min={0} max={100} step={0.5} disabled={disabled} onChange={value => numberChange('min_similarity', value)} />
        <label className="workspace-field-label">匹配窗口<select aria-label="形态匹配窗口" disabled={disabled} value={node.match_mode ?? (asset?.pattern?.params.match_mode === 'recent' ? 'recent' : 'current')} onChange={event => onChange({ ...node, match_mode: event.target.value as 'current' | 'recent', recent_bars: node.recent_bars ?? Number(asset?.pattern?.params.recent_bars ?? 20) })} className="workspace-field workspace-select"><option value="current">当前窗口</option><option value="recent">近期最相近窗口</option></select></label>
        {(node.match_mode ?? asset?.pattern?.params.match_mode) === 'recent' && <ParameterNumber label="近期回看交易日数" value={node.recent_bars ?? Number(asset?.pattern?.params.recent_bars ?? 20)} min={1} max={120} integer disabled={disabled} onChange={value => numberChange('recent_bars', value)} />}
      </>}
    </div>
    {!Object.keys(parameters).length && node.op !== 'pattern_ref' && <p>此条件使用固定判断口径。</p>}
    {!!Object.keys(node.parameter_overrides ?? {}).length && <button type="button" className="text-button workspace-button" disabled={disabled} onClick={() => { const next = { ...node }; delete next.parameter_overrides; onChange(next) }}>恢复条件默认参数</button>}
    <small className="condition-inline-note">修改仅对当前组合生效。</small>
    {onDetails && <button type="button" className="text-button condition-inline-details-link workspace-button" disabled={disabled} onClick={onDetails}><Info size={13} />条件详情</button>}
  </div>
}
