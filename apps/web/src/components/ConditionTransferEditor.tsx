import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpToLine, Check, Ellipsis, Folder, GitBranch, ListFilter, Plus, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
import type { Asset, Node } from '../pages/StrategyPage'
import { addTransferConditions, conditionAssetKey, moveTransferItems, referencedConditionKeys, removeTransferItems, transferItems, updateTransferItem, type TransferMove } from '../conditionTransfer'
import { countConditions } from '../screeningWorkflow'
import { applyConditionParameters, conditionText, distinctConditionDescription } from '../conditionText'
import { StockText } from './StockMentions'
import ConditionItemEditor from './ConditionItemEditor'
import InlineConditionParameters from './InlineConditionParameters'
import './condition-transfer.css'
import './condition-compose-fit.css'

const categories = [{ key: '', label: '全部条件', icon: ListFilter }, { key: 'technical', label: '行情条件', icon: Folder }, { key: 'report', label: '研报条件', icon: Folder }, { key: 'news', label: '资讯条件', icon: Folder }, { key: 'pattern', label: '形态条件', icon: Folder }]
const kind = (asset: Asset) => asset.pattern ? 'pattern' : asset.filter!.library
const identity = (asset: Asset) => asset.filter ?? asset.pattern!
const description = (asset: Asset) => asset.filter?.contract?.summary ?? asset.filter?.description ?? `比较 ${asset.pattern?.target_bars} 根 K 线的走势形态`
const groupNames: Record<string, string> = { all: '全部满足分组', any: '任一满足分组', not: '排除分组' }
const kindNames: Record<string, string> = { technical: '行情', report: '研报', news: '资讯', pattern: '形态' }
const relationNames: Record<string, string> = { all: '全部满足', any: '任一满足', not: '排除以下条件' }

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

function ConditionGroupPreview({ node, catalog, path, disabled, onInspectReference }: { node: Node; catalog: Asset[]; path: number[]; disabled: boolean; onInspectReference?: (path: number[]) => void }) {
  return <div className="condition-group-preview">{(node.children ?? []).map((child, index) => <div className="condition-group-child" key={index}>
    {child.op.endsWith('_ref') ? <>{onInspectReference ? <button type="button" className="condition-reference-open workspace-button" disabled={disabled} aria-label={`查看 ${itemLabel(child, catalog)} 详情`} onClick={() => onInspectReference([...path, index])}>{itemLabel(child, catalog)}</button> : <strong>{itemLabel(child, catalog)}</strong>}<small>{itemDescription(child, catalog)}</small></> : <><span className="condition-group-relation">{relationNames[child.op] ?? '条件组'}</span><ConditionGroupPreview node={child} catalog={catalog} path={[...path, index]} disabled={disabled} onInspectReference={onInspectReference} /></>}
  </div>)}</div>
}

export default function ConditionTransferEditor({ tree, catalog, logicSummary, disabled = false, onChange, onCreateCondition, onInspectReference }: { tree: Node; catalog: Asset[]; logicSummary?: string; disabled?: boolean; onChange: (tree: Node) => void; onCreateCondition: () => void; onInspectReference?: (path: number[]) => void }) {
  const paneId = useId()
  const availableId = `${paneId}-available`, selectedId = `${paneId}-selected`, summaryId = `${paneId}-summary`
  const conditionCount = countConditions(tree)
  const previousConditionCount = useRef(conditionCount)
  const [libraryOpen, setLibraryOpen] = useState(() => !conditionCount)
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const [category, setCategory] = useState('')
  const [query, setQuery] = useState('')
  const [mobilePane, setMobilePane] = useState<'available' | 'selected'>(() => countConditions(tree) ? 'selected' : 'available')
  useEffect(() => {
    if (previousConditionCount.current > 0 && conditionCount === 0) { setLibraryOpen(true); setMobilePane('available') }
    previousConditionCount.current = conditionCount
  }, [conditionCount])
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [chosen, setChosen] = useState<Set<Node>>(new Set())
  const [message, setMessage] = useState('')
  const [editing, setEditing] = useState<{ node: Node; index: number | null; parameters: boolean; baseTree: Node } | null>(null)
  const [inline, setInline] = useState<{ node: Node; index: number } | null>(null)
  const lastTransfer = useRef<Node | null>(null)
  const used = useMemo(() => referencedConditionKeys(tree), [tree])
  const items = useMemo(() => transferItems(tree), [tree])
  const versionCatalog = useMemo(() => {
    const latest = new Map<string, number>()
    catalog.forEach(asset => { const item = identity(asset), key = kind(asset) + ':' + item.id; latest.set(key, Math.max(latest.get(key) ?? 0, item.version)) })
    return catalog.filter(asset => { const item = identity(asset); return latest.get(kind(asset) + ':' + item.id) === item.version })
  }, [catalog])
  const categoryCatalog = versionCatalog.filter(asset => !category || kind(asset) === category)
  const available = categoryCatalog.filter(asset => !used.has(asset.key) && [identity(asset).name, description(asset), asset.filter?.provenance?.prompt].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const selectedAvailable = available.filter(asset => pending.has(asset.key))
  const selectedItems = items.filter(item => chosen.has(item))
  const itemPath = (index: number) => ['all', 'any'].includes(tree.op) ? [index] : []
  useEffect(() => { setChosen(previous => new Set([...previous].filter(item => items.includes(item)))); setPending(previous => new Set([...previous].filter(key => !used.has(key)))) }, [items, used])
  useEffect(() => { if (tree !== lastTransfer.current) setMessage(''); lastTransfer.current = null }, [tree])
  useEffect(() => { if (editing && tree !== editing.baseTree) setEditing(null) }, [tree, editing])
  useEffect(() => { if (inline && items[inline.index] !== inline.node) setInline(null) }, [items, inline])
  function commit(next: Node, text: string) { if (next === tree) return; lastTransfer.current = next; onChange(next); setMessage(text) }
  function togglePending(key: string) { setPending(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next }) }
  function toggleChosen(node: Node) { setChosen(previous => { const next = new Set(previous); if (next.has(node)) next.delete(node); else next.add(node); return next }) }
  function add(assets: Asset[]) {
    if (disabled || !assets.length) return
    const next = addTransferConditions(tree, assets)
    commit(next, `已加入 ${assets.length} 个条件。`)
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
    if (index != null && parameters && items[index]?.op.endsWith('_ref')) {
      setInline(current => current?.index === index ? null : { node: items[index], index })
      return
    }
    setEditing({ node: index == null ? tree : items[index], index, parameters, baseTree: tree })
  }
  function updateInline(index: number, next: Node) {
    if (disabled) return
    commit(updateTransferItem(tree, index, next), '已更新本组合的条件参数。')
    setInline({ node: next, index })
  }
  function changeRelation(op: string) {
    if (disabled || op === tree.op) return
    const base = tree.op === 'not' && tree.children?.length === 1 ? tree.children[0] : tree
    const next = op === 'not' ? { op, children: [tree] } : ['all', 'any'].includes(base.op) ? { ...base, op } : { op, children: [base] }
    commit(next, `已改为${relationNames[op]}。`)
  }
  function applyEdit(next: Node) {
    if (!editing || disabled || tree !== editing.baseTree) return
    commit(editing.index == null ? next : updateTransferItem(tree, editing.index, next), editing.parameters ? '已更新条件参数。' : '已更新组合逻辑。')
    setEditing(null)
  }
  function openLibrary() { setLibraryOpen(true); setMobilePane('available'); requestAnimationFrame(() => searchInput.current?.focus()) }
  function closeLibrary() { setLibraryOpen(false); setMobilePane('selected'); requestAnimationFrame(() => addButton.current?.focus()) }
  const moves = [{ key: 'top', label: '置顶', icon: ArrowUpToLine }, { key: 'up', label: '上移', icon: ArrowUp }, { key: 'down', label: '下移', icon: ArrowDown }, { key: 'bottom', label: '置底', icon: ArrowDownToLine }] as const
  return <StockText><div className="condition-transfer" data-mobile-pane={mobilePane} data-library-open={libraryOpen}>
    <div className="condition-transfer-mobile-switch" role="group" aria-label="切换条件列表"><button type="button" disabled={disabled} aria-pressed={mobilePane === 'available'} aria-controls={availableId} onClick={openLibrary} className="workspace-button">待选条件 · {available.length}</button><button type="button" disabled={disabled} aria-pressed={mobilePane === 'selected'} aria-controls={selectedId} onClick={() => setMobilePane('selected')} className="workspace-button">返回规则 · {countConditions(tree)}</button></div>
    <div className="condition-transfer-grid">
      <section id={availableId} hidden={!libraryOpen} className="condition-transfer-panel condition-transfer-available" aria-label="待选条件" onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); closeLibrary() } }}>
        <header><div><h4>添加条件 <b>待添加 {available.length}</b></h4></div><button type="button" className="workspace-button" aria-label="收起添加条件" disabled={disabled} onClick={closeLibrary}><X size={14} /></button></header><button type="button" className="condition-create-button workspace-button" disabled={disabled} onClick={onCreateCondition}><Plus size={14} />描述新条件并核对</button>
        <label className="condition-transfer-search workspace-field-label"><Search size={15} /><input ref={searchInput} aria-label="搜索待选条件" placeholder="搜索名称或判断口径" value={query} disabled={disabled} onChange={event => { setQuery(event.target.value); setPending(new Set()) }} className="workspace-field" />{query && <button type="button" aria-label="清除条件搜索" disabled={disabled} onClick={() => { setQuery(''); setPending(new Set()) }} className="workspace-button"><X size={13} /></button>}</label>
        <nav className="condition-category-tabs" aria-label="条件分类">{categories.map(({ key, label }) => <button type="button" key={key} disabled={disabled} aria-label={label} aria-pressed={category === key} className={["workspace-button", category === key ? 'active' : ''].filter(Boolean).join(' ')} onClick={() => { setCategory(key); setPending(new Set()) }}>{key ? kindNames[key] : '全部'}</button>)}</nav>
        <div className="condition-transfer-list-options"><label className="workspace-check-label"><input type="checkbox" aria-label="勾选全部待选条件" disabled={disabled || !available.length} checked={available.length > 0 && selectedAvailable.length === available.length} onChange={event => setPending(event.target.checked ? new Set(available.map(asset => asset.key)) : new Set())} className="workspace-check" />全选{selectedAvailable.length > 0 && <span> · 已勾选 {selectedAvailable.length}</span>}</label><span>加入时自动固定版本</span></div>
        <div className="condition-transfer-list">{available.map(asset => { const item = identity(asset); const summary = distinctConditionDescription(item.name, description(asset)); return <div key={asset.key} className={'condition-transfer-row ' + (pending.has(asset.key) ? 'checked' : '')}>
          <label className="condition-transfer-row-main workspace-check-label"><input type="checkbox" aria-label={`选择待选条件 ${item.name} 第 ${item.version} 版`} disabled={disabled} checked={pending.has(asset.key)} onChange={() => togglePending(asset.key)} className="workspace-check" /><span className="condition-transfer-row-content"><strong>{item.name}</strong>{summary && <small>{summary}</small>}</span></label>
          <button type="button" className="condition-quick-add workspace-button" aria-label={`加入 ${item.name} 第 ${item.version} 版`} data-tooltip="加入组合" disabled={disabled} onClick={() => add([asset])}><Plus size={15} /></button>
        </div> })}{!available.length && <div className="condition-transfer-empty"><ListFilter size={28} /><strong>{query ? '没有匹配的条件' : categoryCatalog.length ? '当前分类已全部加入' : '当前分类暂无条件'}</strong><p>{query ? '试试其他名称或判断口径' : categoryCatalog.length ? '可切换分类或在条件详情中查看版本' : '可切换分类，或创建并保存一个条件'}</p></div>}</div>
        <footer className="condition-available-footer"><button type="button" className="secondary-button workspace-button" aria-label="加入勾选条件" disabled={disabled || !selectedAvailable.length} onClick={() => add(selectedAvailable)}>加入勾选{selectedAvailable.length > 0 ? `（${selectedAvailable.length}）` : ''}<ArrowRight size={14} /></button><button type="button" className="text-button workspace-button" aria-label="加入全部待选条件" disabled={disabled || !available.length} onClick={() => add(available)}>全部加入</button></footer>
      </section>
      <section id={selectedId} className="condition-transfer-panel condition-transfer-selected" aria-label="已选条件">
        <header><div><h4>方案规则 <b>{countConditions(tree)} 个条件</b></h4></div><div className="condition-rule-actions"><button ref={addButton} type="button" className="workspace-button" disabled={disabled} aria-expanded={libraryOpen} aria-controls={availableId} onClick={libraryOpen ? closeLibrary : openLibrary}><Plus size={14} />{libraryOpen ? '收起条件库' : '添加条件'}</button><button type="button" disabled={disabled} aria-label="组合逻辑" onClick={() => edit(null, false)} className="workspace-button"><GitBranch size={14} />编辑分组</button></div></header>
        <div className="condition-relation-bar"><label className="workspace-field-label"><span>组合关系</span><select aria-label="组合关系" disabled={disabled} value={['all', 'any', 'not'].includes(tree.op) ? tree.op : 'single'} onChange={event => changeRelation(event.target.value)} className="workspace-field workspace-select">{!['all', 'any', 'not'].includes(tree.op) && <option value="single">单项条件</option>}<option value="all">全部满足</option><option value="any">任一满足</option><option value="not">整体排除</option></select></label><span>{tree.op === 'all' ? '每个条件都需符合' : tree.op === 'any' ? '至少一个条件符合' : tree.op === 'not' ? '排除符合以下条件的股票' : '按当前条件判断'}</span></div>
        <div className="condition-transfer-selected-tools"><label className="workspace-check-label"><input type="checkbox" aria-label="勾选全部已选条目" disabled={disabled || !items.length} checked={items.length > 0 && selectedItems.length === items.length} onChange={event => setChosen(event.target.checked ? new Set(items) : new Set())} className="workspace-check" />全选{selectedItems.length > 0 && <span> · 已选 {selectedItems.length}</span>}</label>{selectedItems.length > 0 && <div className="condition-selected-batch"><button type="button" className="condition-remove-selected workspace-button" aria-label="移除勾选条目" data-tooltip="移除勾选条目" disabled={disabled} onClick={() => remove(selectedItems)}><Trash2 size={13} /><span>移除</span></button><div aria-label="已选条目排序">{moves.map(({ key, label, icon: Icon }) => <button type="button" key={key} aria-label={label} data-tooltip={label} disabled={disabled || moveTransferItems(tree, chosen, key) === tree} onClick={() => move(key)} className="workspace-button"><Icon size={14} /></button>)}</div></div>}</div>
        <div className="condition-transfer-list">{items.map((node, index) => { const summary = distinctConditionDescription(itemLabel(node, catalog), itemDescription(node, catalog)); return <div key={index} className="condition-selected-entry">
          {index > 0 && <div className="condition-logic-connector" aria-hidden="true"><span>{tree.op === 'any' ? '或' : '且'}</span></div>}
          <div className={'condition-transfer-row ' + (chosen.has(node) ? 'checked' : '')}>
            <label className="condition-transfer-row-main workspace-check-label"><input type="checkbox" aria-label={`选择已选条目 ${index + 1} ${itemLabel(node, catalog)}`} disabled={disabled} checked={chosen.has(node)} onChange={() => toggleChosen(node)} className="workspace-check" /><span className="condition-transfer-order">{String(index + 1).padStart(2, '0')}</span><span className="condition-transfer-row-content"><strong>{!node.op.endsWith('_ref') && <Folder size={13} />}{itemLabel(node, catalog)}</strong>{summary && node.op.endsWith('_ref') && <small>{summary}</small>}{node.op.endsWith('_ref') ? <em>固定 v{node.version}{Object.keys(node.parameter_overrides ?? {}).length > 0 && ' · 本方案已调参数'}</em> : <em>{countConditions(node)} 项条件</em>}</span></label>
            <button type="button" className="condition-remove-one workspace-button" aria-label={`移除第 ${index + 1} 项`} data-tooltip="移除条件" disabled={disabled} onClick={() => remove([node])}><X size={14} /></button>
            <div className="condition-transfer-row-actions">{node.op.endsWith('_ref') ? <>
              <button type="button" disabled={disabled} aria-label={`编辑第 ${index + 1} 项参数`} aria-expanded={inline?.index === index} onClick={() => edit(index, true)} className="workspace-button"><SlidersHorizontal size={12} />参数</button>
              <details className="condition-row-more"><summary aria-label={`第 ${index + 1} 项更多操作`}><Ellipsis size={15} /></summary><div>{onInspectReference && <button type="button" disabled={disabled} aria-label={`查看第 ${index + 1} 项详情`} onClick={event => { const details = event.currentTarget.closest('details'); details?.removeAttribute('open'); details?.querySelector<HTMLElement>('summary')?.focus(); onInspectReference(itemPath(index)) }} className="workspace-button">条件详情</button>}<button type="button" disabled={disabled} aria-label={`编辑第 ${index + 1} 项逻辑`} onClick={event => { const details = event.currentTarget.closest('details'); details?.removeAttribute('open'); details?.querySelector<HTMLElement>('summary')?.focus(); edit(index, false) }} className="workspace-button"><GitBranch size={12} />调整逻辑</button></div></details>
            </> : <button type="button" disabled={disabled} aria-label={`编辑第 ${index + 1} 项逻辑`} onClick={() => edit(index, false)} className="workspace-button"><GitBranch size={12} />编辑分组</button>}</div>
          </div>
          {!node.op.endsWith('_ref') && <ConditionGroupPreview node={node} catalog={catalog} path={itemPath(index)} disabled={disabled} onInspectReference={onInspectReference} />}
          {inline?.index === index && <div className="condition-inline-editor" onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('button[aria-expanded=true]')?.focus(); setInline(null) } }}><InlineConditionParameters node={node} catalog={catalog} disabled={disabled} onChange={next => updateInline(index, next)} onDetails={onInspectReference ? () => onInspectReference(itemPath(index)) : undefined} /></div>}
        </div> })}{!items.length && <div className="condition-transfer-empty condition-composition-empty"><div className="condition-empty-icon"><GitBranch size={32} /></div><strong>还没有方案规则</strong><p>从条件库添加已有条件，再核对参数和组合关系。</p><button type="button" className="primary-button workspace-button" disabled={disabled} onClick={openLibrary}><Plus size={14} />从条件库添加</button><button type="button" className="text-button workspace-button" disabled={disabled} onClick={onCreateCondition}>描述新条件并核对<ArrowRight size={14} /></button><span><Check size={12} />支持行情、研报、资讯与形态条件</span></div>}</div>
        <footer className="condition-logic-summary" data-expanded={summaryExpanded}><div><button type="button" className="text-button workspace-button" disabled={disabled || !logicSummary} aria-expanded={summaryExpanded} aria-controls={summaryId} onClick={() => setSummaryExpanded(value => !value)}>{summaryExpanded ? '收起完整逻辑' : '展开完整逻辑'}</button><button type="button" className="text-button workspace-button" aria-label="移除全部条目" disabled={disabled || !items.length} onClick={() => remove(items)}>清空条件</button></div><p id={summaryId} tabIndex={summaryExpanded ? 0 : undefined}>{logicSummary || '加入条件后，在这里查看完整的组合判断关系'}</p></footer>
      </section>
    </div>{message && <div className="condition-transfer-feedback" role="status">{message}</div>}
    {editing && <ConditionItemEditor key={`${editing.index ?? 'root'}:${editing.parameters}`} node={editing.node} catalog={catalog} title={editing.index == null ? '组合逻辑' : `${itemLabel(editing.node, catalog)} · ${editing.parameters ? '条件参数' : '条件逻辑'}`} parameters={editing.parameters} depth={editing.index == null || !['all', 'any'].includes(tree.op) ? 0 : 1} disabled={disabled} onApply={applyEdit} onClose={() => setEditing(null)} />}
  </div></StockText>
}
