import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Folder, FolderOpen, GitBranch, ListFilter, Plus, Search, SlidersHorizontal } from 'lucide-react'
import type { Asset, Node } from '../pages/StrategyPage'
import { addTransferConditions, conditionAssetKey, moveTransferItems, referencedConditionKeys, removeTransferItems, transferItems, updateTransferItem, type TransferMove } from '../conditionTransfer'
import { countConditions } from '../screeningWorkflow'
import { applyConditionParameters, conditionText } from '../conditionText'
import { StockText } from './StockMentions'
import ConditionItemEditor from './ConditionItemEditor'
import './condition-transfer.css'
import './condition-compose-fit.css'

const categories = [{ key: '', label: '全部条件', icon: ListFilter }, { key: 'technical', label: '行情条件', icon: Folder }, { key: 'report', label: '研报条件', icon: Folder }, { key: 'news', label: '资讯条件', icon: Folder }, { key: 'pattern', label: '形态条件', icon: Folder }]
const kind = (asset: Asset) => asset.pattern ? 'pattern' : asset.filter!.library
const identity = (asset: Asset) => asset.filter ?? asset.pattern!
const description = (asset: Asset) => asset.filter?.contract?.summary ?? asset.filter?.description ?? `比较 ${asset.pattern?.target_bars} 根 K 线的走势形态`
const groupNames: Record<string, string> = { all: '全部满足分组', any: '任一满足分组', not: '排除分组' }

function itemLabel(node: Node, catalog: Asset[]): string {
  if (!node.op.endsWith('_ref')) return groupNames[node.op] ?? '条件分组'
  const asset = catalog.find(asset => asset.key === conditionAssetKey(node))
  return asset ? identity(asset).name : `未载入条件 · ${node.filter_id ?? node.pattern_id}`
}
function itemDescription(node: Node, catalog: Asset[]): string {
  if (node.op.endsWith('_ref')) {
    const asset = catalog.find(asset => asset.key === conditionAssetKey(node))
    return asset?.filter ? conditionText(asset.filter.library, applyConditionParameters(asset.filter.expression, node.parameter_overrides), asset.filter.contract?.summary ?? asset.filter.description) : asset ? description(asset) : '固定版本暂未载入，请核对条件目录'
  }
  return (node.children ?? []).map(child => itemLabel(child, catalog)).join('、') || '空分组，点击右侧逻辑按钮补充条件'
}

export default function ConditionTransferEditor({ tree, catalog, logicSummary, disabled = false, onChange, onCreateCondition }: { tree: Node; catalog: Asset[]; logicSummary?: string; disabled?: boolean; onChange: (tree: Node) => void; onCreateCondition: () => void }) {
  const [category, setCategory] = useState('')
  const [query, setQuery] = useState('')
  const [history, setHistory] = useState(false)
  const [mobilePane, setMobilePane] = useState<'available' | 'selected'>('available')
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [chosen, setChosen] = useState<Set<Node>>(new Set())
  const [message, setMessage] = useState('')
  const [editing, setEditing] = useState<{ node: Node; index: number | null; parameters: boolean; baseTree: Node } | null>(null)
  const lastTransfer = useRef<Node | null>(null)
  const used = useMemo(() => referencedConditionKeys(tree), [tree])
  const items = useMemo(() => transferItems(tree), [tree])
  const versionCatalog = useMemo(() => {
    const latest = new Map<string, number>()
    catalog.forEach(asset => { const item = identity(asset), key = kind(asset) + ':' + item.id; latest.set(key, Math.max(latest.get(key) ?? 0, item.version)) })
    return history ? catalog : catalog.filter(asset => { const item = identity(asset); return latest.get(kind(asset) + ':' + item.id) === item.version })
  }, [catalog, history])
  const categoryCatalog = versionCatalog.filter(asset => !category || kind(asset) === category)
  const available = categoryCatalog.filter(asset => !used.has(asset.key) && [identity(asset).name, description(asset), asset.filter?.provenance?.prompt].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const selectedAvailable = available.filter(asset => pending.has(asset.key))
  const selectedItems = items.filter(item => chosen.has(item))
  useEffect(() => { setChosen(previous => new Set([...previous].filter(item => items.includes(item)))); setPending(previous => new Set([...previous].filter(key => !used.has(key)))) }, [items, used])
  useEffect(() => { if (tree !== lastTransfer.current) setMessage(''); lastTransfer.current = null }, [tree])
  useEffect(() => { if (editing && tree !== editing.baseTree) setEditing(null) }, [tree, editing])
  function commit(next: Node, text: string) { if (next === tree) return; lastTransfer.current = next; onChange(next); setMessage(text) }
  function togglePending(key: string) { setPending(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next }) }
  function toggleChosen(node: Node) { setChosen(previous => { const next = new Set(previous); if (next.has(node)) next.delete(node); else next.add(node); return next }) }
  function add(assets: Asset[]) {
    if (disabled || !assets.length) return
    const next = addTransferConditions(tree, assets)
    commit(next, `已加入 ${assets.length} 个条件。`)
    setMobilePane('selected')
    setPending(new Set())
  }
  function remove(nodes: Node[]) {
    if (disabled || !nodes.length) return
    commit(removeTransferItems(tree, new Set(nodes)), `已移除 ${nodes.length} 个条目。`); setChosen(new Set())
  }
  function move(direction: TransferMove) {
    if (disabled) return
    const next = moveTransferItems(tree, chosen, direction)
    commit(next, '已调整条目顺序。')
  }
  function edit(index: number | null, parameters: boolean) {
    if (disabled) return
    setEditing({ node: index == null ? tree : items[index], index, parameters, baseTree: tree })
  }
  function applyEdit(next: Node) {
    if (!editing || disabled || tree !== editing.baseTree) return
    commit(editing.index == null ? next : updateTransferItem(tree, editing.index, next), editing.parameters ? '已更新条件参数。' : '已更新组合逻辑。')
    setEditing(null)
  }
  const moves = [{ key: 'top', label: '置顶', icon: ArrowUpToLine }, { key: 'up', label: '上移', icon: ArrowUp }, { key: 'down', label: '下移', icon: ArrowDown }, { key: 'bottom', label: '置底', icon: ArrowDownToLine }] as const
  return <StockText><div className="condition-transfer" data-mobile-pane={mobilePane}>
    <div className="condition-transfer-heading"><div><h3>选择并排列条件</h3></div><span>在已选条件右侧调整参数与逻辑</span><button type="button" className="condition-mobile-create" aria-label="新增可选条件" disabled={disabled} onClick={onCreateCondition}><Plus size={12} />新增条件</button></div>
    <div className="condition-transfer-grid">
      <aside className="condition-categories"><h4><FolderOpen size={16} />条件目录</h4><nav aria-label="条件分类">{categories.map(({ key, label, icon: Icon }) => <button type="button" key={key} disabled={disabled} aria-pressed={category === key} className={category === key ? 'active' : ''} onClick={() => { setCategory(key); setMobilePane('available'); setPending(new Set()) }}><Icon size={15} /><span>{label}</span><b>{versionCatalog.filter(asset => !key || kind(asset) === key).length}</b></button>)}</nav><div className="condition-categories-footer"><p>从已保存的条件中选择</p><button type="button" disabled={disabled} onClick={onCreateCondition}><Plus size={14} />新增条件</button></div></aside>
      <div className="condition-transfer-mobile-switch" role="group" aria-label="切换条件列表"><button type="button" disabled={disabled} aria-pressed={mobilePane === 'available'} aria-controls="condition-transfer-available" onClick={() => setMobilePane('available')}>待选 {available.length}</button><button type="button" disabled={disabled} aria-pressed={mobilePane === 'selected'} aria-controls="condition-transfer-selected" onClick={() => setMobilePane('selected')}>已选 {countConditions(tree)}</button></div>
      <section id="condition-transfer-available" className="condition-transfer-panel condition-transfer-available" aria-label="待选条件"><header><h4>待选条件 <b>{available.length}</b></h4><span>{selectedAvailable.length ? `已勾选 ${selectedAvailable.length} 项` : '勾选后加入'}</span></header><label className="condition-transfer-search"><Search size={15} /><input aria-label="搜索待选条件" placeholder="搜索名称或判断口径" value={query} disabled={disabled} onChange={event => { setQuery(event.target.value); setPending(new Set()) }} /></label><div className="condition-transfer-list-options"><label><input type="checkbox" aria-label="勾选全部待选条件" disabled={disabled || !available.length} checked={available.length > 0 && selectedAvailable.length === available.length} onChange={event => setPending(event.target.checked ? new Set(available.map(asset => asset.key)) : new Set())} />全选</label><label><input type="checkbox" checked={history} disabled={disabled} onChange={event => { setHistory(event.target.checked); setPending(new Set()) }} />历史版本</label></div>
        <div className="condition-transfer-list">{available.map(asset => { const item = identity(asset); return <label key={asset.key} className={'condition-transfer-row ' + (pending.has(asset.key) ? 'checked' : '')}><input type="checkbox" aria-label={`选择待选条件 ${item.name} 第 ${item.version} 版`} disabled={disabled} checked={pending.has(asset.key)} onChange={() => togglePending(asset.key)} /><span className="condition-transfer-row-content"><strong>{item.name}</strong><small>{description(asset)}</small></span><span className="condition-transfer-version">v{item.version}</span></label> })}{!available.length && <div className="condition-transfer-empty"><ListFilter size={26} /><strong>{query ? '没有匹配的条件' : categoryCatalog.length ? '当前分类已全部加入' : '当前分类暂无条件'}</strong><p>{query ? '试试其他名称或判断口径' : categoryCatalog.length ? '可切换分类或查看历史版本' : '可切换分类，或创建并保存一个条件'}</p></div>}</div>
      </section>
      <div className="condition-transfer-actions" aria-label="条件批量移动"><button type="button" aria-label="加入勾选条件" title="加入勾选条件" disabled={disabled || !selectedAvailable.length} onClick={() => add(selectedAvailable)}><ChevronRight size={19} /><span>加入勾选</span></button><button type="button" aria-label="加入全部待选条件" title="加入全部待选条件" disabled={disabled || !available.length} onClick={() => add(available)}><ChevronsRight size={19} /><span>全部加入</span></button><button type="button" aria-label="移除勾选条目" title="移除勾选条目" disabled={disabled || !selectedItems.length} onClick={() => remove(selectedItems)}><ChevronLeft size={19} /><span>移除勾选</span></button><button type="button" aria-label="移除全部条目" title="移除全部条目" disabled={disabled || !items.length} onClick={() => remove(items)}><ChevronsLeft size={19} /><span>全部移除</span></button></div>
      <section id="condition-transfer-selected" className="condition-transfer-panel condition-transfer-selected" aria-label="已选条件"><header><h4>已选条件 <b>{countConditions(tree)}</b></h4><button type="button" disabled={disabled} onClick={() => edit(null, false)}><GitBranch size={13} />组合逻辑</button></header><div className="condition-transfer-selected-tools"><label><input type="checkbox" aria-label="勾选全部已选条目" disabled={disabled || !items.length} checked={items.length > 0 && selectedItems.length === items.length} onChange={event => setChosen(event.target.checked ? new Set(items) : new Set())} />全选</label><div aria-label="已选条目排序">{moves.map(({ key, label, icon: Icon }) => <button type="button" key={key} aria-label={label} title={label} disabled={disabled || !selectedItems.length || moveTransferItems(tree, chosen, key) === tree} onClick={() => move(key)}><Icon size={15} /></button>)}</div></div>
        <div className="condition-transfer-list">{items.map((node, index) => <div key={index} className={'condition-transfer-row ' + (chosen.has(node) ? 'checked' : '')}><label className="condition-transfer-row-main"><input type="checkbox" aria-label={`选择已选条目 ${index + 1} ${itemLabel(node, catalog)}`} disabled={disabled} checked={chosen.has(node)} onChange={() => toggleChosen(node)} /><span className="condition-transfer-order">{String(index + 1).padStart(2, '0')}</span><span className="condition-transfer-row-content"><strong>{itemLabel(node, catalog)}</strong><small>{itemDescription(node, catalog)}</small><em>{node.op.endsWith('_ref') ? `v${node.version} · 权重 ${node.score_weight ?? 1}${Object.keys(node.parameter_overrides ?? {}).length ? ' · 已调整参数' : ''}` : `${countConditions(node)} 项条件 · 整组保留`}</em></span></label><div className="condition-transfer-row-actions"><button type="button" disabled={disabled} aria-label={`编辑第 ${index + 1} 项参数`} title={itemLabel(node, catalog) + ' · 参数'} onClick={() => edit(index, true)}><SlidersHorizontal size={12} />参数</button><button type="button" disabled={disabled} aria-label={`编辑第 ${index + 1} 项逻辑`} title={itemLabel(node, catalog) + ' · 逻辑'} onClick={() => edit(index, false)}><GitBranch size={12} />逻辑</button></div></div>)}{!items.length && <div className="condition-transfer-empty"><Plus size={26} /><strong>从左侧加入条件</strong><p>勾选多个条件，一次加入组合</p></div>}</div><footer title={logicSummary}>{logicSummary || '参数与分组逻辑均可通过条目右侧按钮调整'}</footer>
      </section>
    </div><div className="condition-transfer-feedback" role="status">{message || '勾选条目后，可批量移动或调整顺序。'}</div>
    {editing && <ConditionItemEditor key={`${editing.index ?? 'root'}:${editing.parameters}`} node={editing.node} catalog={catalog} title={editing.index == null ? '组合逻辑' : `${itemLabel(editing.node, catalog)} · ${editing.parameters ? '条件参数' : '条件逻辑'}`} parameters={editing.parameters} depth={editing.index == null || !['all', 'any'].includes(tree.op) ? 0 : 1} disabled={disabled} onApply={applyEdit} onClose={() => setEditing(null)} />}
  </div></StockText>
}
