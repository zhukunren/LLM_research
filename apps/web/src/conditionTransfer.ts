import { makeReference, type Asset, type Node } from './pages/StrategyPage'

export const conditionAssetKey = (node: Node) => `${node.op === 'pattern_ref' ? 'pattern' : 'filter'}:${node.filter_id ?? node.pattern_id}@${node.version}`
export function referencedConditionKeys(tree: Node): Set<string> {
  if (tree.op.endsWith('_ref')) return new Set([conditionAssetKey(tree)])
  return new Set((tree.children ?? []).flatMap(child => [...referencedConditionKeys(child)]))
}
// Nested groups remain indivisible here; their contents are edited in the logic editor.
export const transferItems = (tree: Node): Node[] => ['all', 'any'].includes(tree.op) ? tree.children ?? [] : [tree]
function replaceTransferItems(tree: Node, items: Node[]): Node {
  return ['all', 'any'].includes(tree.op) ? { ...tree, children: items } : items[0] ?? { op: 'all', children: [] }
}
export function addTransferConditions(tree: Node, assets: Asset[]): Node {
  const used = referencedConditionKeys(tree)
  const incoming = assets.filter(asset => { if (used.has(asset.key)) return false; used.add(asset.key); return true }).map(makeReference)
  if (!incoming.length) return tree
  return ['all', 'any'].includes(tree.op) ? { ...tree, children: [...transferItems(tree), ...incoming] } : { op: 'all', children: [tree, ...incoming] }
}
export function removeTransferItems(tree: Node, selected: Set<Node>): Node {
  const items = transferItems(tree)
  return items.some(item => selected.has(item)) ? replaceTransferItems(tree, items.filter(item => !selected.has(item))) : tree
}
export function updateTransferItem(tree: Node, index: number, next: Node): Node {
  const items = transferItems(tree)
  if (!items[index] || items[index] === next) return tree
  return replaceTransferItems(tree, items.map((item, position) => position === index ? next : item))
}
export type TransferMove = 'top' | 'up' | 'down' | 'bottom'
export function moveTransferItems(tree: Node, selected: Set<Node>, move: TransferMove): Node {
  const items = transferItems(tree)
  const reordered = [...items]
  if (move === 'top' || move === 'bottom') {
    const chosen = items.filter(item => selected.has(item)), rest = items.filter(item => !selected.has(item))
    reordered.splice(0, reordered.length, ...(move === 'top' ? [...chosen, ...rest] : [...rest, ...chosen]))
  } else if (move === 'up') {
    for (let i = 1; i < reordered.length; i++) if (selected.has(reordered[i]) && !selected.has(reordered[i - 1])) [reordered[i - 1], reordered[i]] = [reordered[i], reordered[i - 1]]
  } else {
    for (let i = reordered.length - 2; i >= 0; i--) if (selected.has(reordered[i]) && !selected.has(reordered[i + 1])) [reordered[i + 1], reordered[i]] = [reordered[i], reordered[i + 1]]
  }
  return reordered.every((item, index) => item === items[index]) ? tree : replaceTransferItems(tree, reordered)
}
