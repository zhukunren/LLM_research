import type { Asset, Node } from './pages/StrategyPage'
import { conditionAssetKey } from './conditionTransfer'

export type CompositionReference = { node: Node; path: number[]; groups: string[] }

export function compositionReferences(tree: Node, path: number[] = [], groups: string[] = []): CompositionReference[] {
  if (tree.op.endsWith('_ref')) return [{ node: tree, path, groups }]
  return (tree.children ?? []).flatMap((child, index) => compositionReferences(child, [...path, index], [...groups, tree.op]))
}

export function compositionNode(tree: Node, path: number[]): Node | undefined {
  let node: Node | undefined = tree
  for (const index of path) node = node?.children?.[index]
  return node
}

export function replaceCompositionNode(tree: Node, path: number[], next: Node): Node {
  if (!path.length) return next
  const [index, ...rest] = path
  const child = tree.children?.[index]
  if (!child) return tree
  const updated = replaceCompositionNode(child, rest, next)
  return updated === child ? tree : { ...tree, children: tree.children!.map((item, position) => position === index ? updated : item) }
}

export function referenceAsset(node: Node, catalog: Asset[]): Asset | undefined {
  return catalog.find(asset => asset.key === conditionAssetKey(node))
}

export function referenceName(node: Node, catalog: Asset[]): string {
  const asset = referenceAsset(node, catalog)
  return (asset?.filter ?? asset?.pattern)?.name ?? `未载入条件 · ${node.filter_id ?? node.pattern_id}`
}

export function latestReferenceAsset(node: Node, catalog: Asset[]): Asset | undefined {
  return catalog.filter(asset => node.op === 'filter_ref' ? asset.filter?.id === node.filter_id : asset.pattern?.id === node.pattern_id)
    .sort((a, b) => (b.filter ?? b.pattern!).version - (a.filter ?? a.pattern!).version)[0]
}

export function updatedReference(node: Node, current: Asset | undefined, latest: Asset): Node {
  const next: Node = { ...node, version: (latest.filter ?? latest.pattern!).version }
  // Older saved shapes may inherit these values from the referenced template.
  // Keep the effective matching settings when updating the shape geometry.
  if (node.op === 'pattern_ref' && current?.pattern) {
    next.min_similarity = node.min_similarity ?? Number(current.pattern.params.min_similarity ?? 80)
    next.match_mode = node.match_mode ?? (current.pattern.params.match_mode === 'recent' ? 'recent' : 'current')
    next.recent_bars = node.recent_bars ?? Number(current.pattern.params.recent_bars ?? 20)
  }
  return next
}
