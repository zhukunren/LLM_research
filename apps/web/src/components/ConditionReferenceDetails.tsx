import type { Asset, Node } from '../pages/StrategyPage'
import { applyConditionParameters, conditionText } from '../conditionText'
import { latestReferenceAsset, referenceAsset, referenceName, updatedReference } from '../compositionReferences'
import { compositionIssues } from '../screeningWorkflow'
import ConditionWorkspaceDrawer from './ConditionWorkspaceDrawer'
import './composition-reference-settings.css'

function summary(node: Node, asset?: Asset): string {
  if (asset?.filter) return conditionText(asset.filter.library, applyConditionParameters(asset.filter.expression, node.parameter_overrides), asset.filter.contract?.summary ?? asset.filter.description)
  if (asset?.pattern) return `${asset.pattern.target_bars} 个交易日的形态 · 最低相似度 ${node.min_similarity ?? Number(asset.pattern.params.min_similarity ?? 80)} · ${(node.match_mode ?? asset.pattern.params.match_mode) === 'recent' ? `近期 ${node.recent_bars ?? Number(asset.pattern.params.recent_bars ?? 20)} 根内最相近窗口` : '当前窗口'}`
  return '当前固定版本未载入，请刷新条件目录。'
}

export default function ConditionReferenceDetails({ node, catalog, disabled, onUpdate, onClose }: {
  node: Node; catalog: Asset[]; disabled: boolean; onUpdate: (next: Node) => void; onClose: () => void
}) {
  const current = referenceAsset(node, catalog)
  const latest = latestReferenceAsset(node, catalog)
  const currentItem = current?.filter ?? current?.pattern
  const latestItem = latest?.filter ?? latest?.pattern
  const hasUpdate = !!latestItem && latestItem.version > (node.version ?? 0)
  const candidate = latest ? updatedReference(node, current, latest) : node
  const issues = hasUpdate ? compositionIssues(candidate, catalog) : []
  const versions = catalog.filter(asset => node.op === 'filter_ref' ? asset.filter?.id === node.filter_id : asset.pattern?.id === node.pattern_id)
    .map(asset => asset.filter ?? asset.pattern!).sort((a, b) => b.version - a.version)
  const provenance = current?.filter?.provenance ?? current?.pattern?.provenance
  const originalPrompt = current?.filter?.provenance?.original_prompt ?? provenance?.prompt
  return <ConditionWorkspaceDrawer title="条件详情" description={referenceName(node, catalog)} closeLabel="关闭条件引用详情" className="condition-reference-drawer" onClose={onClose}>
    <section className="condition-reference-section"><h3>本组合使用的条件</h3>
      <dl><div><dt>版本</dt><dd>已固定 v{node.version}</dd></div><div><dt>保存时间</dt><dd>{currentItem?.created_at?.slice(0, 10) || '未载入'}</dd></div></dl>
      <p>{summary(node, current)}</p>
      <small>加入组合时自动固定版本；条件库中的后续修改保留为新版本。</small>
    </section>
    <section className="condition-reference-section"><h3>{hasUpdate ? `可更新到 v${latestItem!.version}` : '版本状态'}</h3>
      {hasUpdate ? <>
        <p className="condition-reference-latest-name">{latestItem!.name}</p>
        <p>{summary(candidate, latest)}</p>
        <p className="composition-settings-note">更新将保留本组合的排序权重与兼容的自定义参数，保存组合后用于后续筛选。</p>
        {!!issues.length && <div className="workspace-error condition-reference-update-issues" role="alert"><p>本组合配置与新版不兼容，请先调整对应设置再更新。</p>{issues.map(issue => <p key={issue}>{issue}</p>)}</div>}
        <button type="button" className="secondary-button workspace-button" disabled={disabled || !!issues.length} onClick={() => onUpdate(candidate)}>更新到 v{latestItem!.version}</button>
      </> : <p>{current ? '已使用当前可用的最新版本。' : '未找到可更新的版本，请刷新条件目录。'}</p>}
    </section>
    {!!(originalPrompt || current?.filter?.provenance?.source_document || current?.filter?.contract?.notes.length) && <section className="condition-reference-section"><h3>条件来源与口径</h3>
      {originalPrompt && <p>{originalPrompt}</p>}
      {current?.filter?.provenance?.source_document && <p>{current.filter.provenance.source_document.title} · 第 {current.filter.provenance.source_document.page} 页</p>}
      {!!current?.filter?.contract?.notes.length && <ul>{current.filter.contract.notes.map(note => <li key={note}>{note}</li>)}</ul>}
    </section>}
    {versions.length > 1 && <details className="condition-reference-history"><summary>查看历史版本 · {versions.length}</summary>{versions.map(item => <div key={item.version}><strong>v{item.version} · {item.name}</strong><small>{item.created_at.slice(0, 10)}</small></div>)}</details>}
  </ConditionWorkspaceDrawer>
}
