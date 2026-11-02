import { useState } from 'react'
import { ParameterNumber, type Asset, type Node } from '../pages/StrategyPage'
import { compositionReferences, referenceName, replaceCompositionNode } from '../compositionReferences'
import ConditionWorkspaceDrawer from './ConditionWorkspaceDrawer'
import './composition-reference-settings.css'

const relations: Record<string, string> = { all: '全部满足', any: '任一满足', not: '排除' }

export default function CompositionRankingSettings({ tree, catalog, disabled, onApply, onClose }: {
  tree: Node; catalog: Asset[]; disabled: boolean; onApply: (next: Node) => void; onClose: () => void
}) {
  const [draft, setDraft] = useState(() => structuredClone(tree))
  const references = compositionReferences(draft)
  const invalid = references.some(({ node }) => !Number.isFinite(node.score_weight ?? 1) || (node.score_weight ?? 1) < 0 || (node.score_weight ?? 1) > 100)
  return <ConditionWorkspaceDrawer title="排序设置" description="按命中条件的权重合计从高到低排序，同分按股票代码排列。" closeLabel="关闭排序设置" className="composition-ranking-drawer" onClose={onClose} footer={<>
    <button type="button" className="secondary-button workspace-button" onClick={onClose}>取消</button>
    <button type="button" className="primary-button workspace-button" disabled={disabled || invalid} onClick={() => { if (JSON.stringify(draft) === JSON.stringify(tree)) onClose(); else onApply(draft) }}>应用排序设置</button>
  </>}>
    <p className="composition-settings-note">权重为 0 的条件仍参与是否入选的判断。如果所有入选股票命中同样的条件，得分会相同。</p>
    <div className="composition-ranking-list">{references.map(({ node, path, groups }, index) => <article key={path.join('.')}>
      <div><h3>{referenceName(node, catalog)}</h3><p>{groups.map(op => relations[op] ?? op).join(' / ') || '单项条件'}</p></div>
      <ParameterNumber label={`第 ${index + 1} 项评分权重`} value={node.score_weight ?? 1} min={0} max={100} step={0.25} disabled={disabled} onChange={value => {
        const next = { ...node }
        if (value == null) delete next.score_weight
        else next.score_weight = value
        setDraft(replaceCompositionNode(draft, path, next))
      }} />
    </article>)}</div>
    {!references.length && <p className="composition-settings-note">加入条件后，可以在这里设置排序权重。</p>}
    <p className="composition-settings-note">应用后随组合保存。关闭或取消将保留原设置。</p>
  </ConditionWorkspaceDrawer>
}
