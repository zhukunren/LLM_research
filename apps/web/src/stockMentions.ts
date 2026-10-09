import type { Security } from './components/StockSearch'

export type StockToken = { text: string; code?: string }
type Trie = { children: Map<string, Trie>; code?: string }
export type StockMatcher = { split: (text: string) => StockToken[]; codes: Map<string, Security> }
const cache = new WeakMap<Security[], StockMatcher>()

export function createStockMatcher(items: Security[]): StockMatcher {
  const cached = cache.get(items)
  if (cached) return cached
  const codes = new Map(items.filter(item => item.market !== '指数').map(item => [item.stock_code.toUpperCase(), item]))
  const aliases = new Map<string, Set<string>>()
  function alias(text: string, code: string) {
    if (!text) return
    const matches = aliases.get(text) || new Set<string>()
    matches.add(code); aliases.set(text, matches)
  }
  for (const [code, item] of codes) {
    alias(code, code)
    if (item.name?.trim().length >= 2) alias(item.name.trim(), code)
    const [digits, market] = code.split('.')
    if (/^\d{6}$/.test(digits)) { alias(digits, code); alias(market + digits, code) }
  }
  for (const [code, name] of [['600519.SH','茅台'], ['600809.SH','汾酒'], ['600036.SH','招行'], ['601398.SH','工行'], ['601288.SH','农行']]) {
    if (codes.has(code)) alias(name, code)
  }
  const root: Trie = { children: new Map() }
  for (const [text, matches] of aliases) {
    if (matches.size !== 1) continue
    let node = root
    for (const char of text.toUpperCase().split('')) {
      if (!node.children.has(char)) node.children.set(char, { children: new Map() })
      node = node.children.get(char)!
    }
    node.code = [...matches][0]
  }
  function split(text: string): StockToken[] {
    const tokens: StockToken[] = []
    const protectedRanges = [...text.matchAll(/(?:https?:\/\/|file:\/\/|[A-Za-z]:[\\/])\S+|\S+\.(?:xlsx|docx|pptx|pdf|csv|json)\b/gi)].map(m => [m.index, m.index + m[0].length])
    let start = 0, index = 0
    while (index < text.length) {
      const blocked = protectedRanges.find(([a, b]) => index >= a && index < b)
      if (blocked) { index = blocked[1]; continue }
      let node = root, end = index, found: { end: number; code: string } | undefined
      while (end < text.length) {
        const char = /[a-z]/.test(text[end]) ? text[end].toUpperCase() : text[end]
        const next = node.children.get(char)
        if (!next) break
        node = next; end++
        if (node.code) {
          const token = text.slice(index, end)
          const numeric = /^[0-9]|^(SH|SZ|BJ)[0-9]/i.test(token)
          const left = text[index - 1] || '', right = text[end] || ''
          const amount = /^\d{6}$/.test(token) && (/[￥$]/.test(left) || /[元股份吨家万亿%‰]/.test(right))
          const place = token.endsWith('茅台') && right === '镇'
          if (!place && !amount && (!numeric || (!/[\w./\\]/.test(left) && !/[\w./\\]/.test(right)))) found = { end, code: node.code }
        }
      }
      if (!found) { index++; continue }
      if (index > start) tokens.push({ text: text.slice(start, index) })
      tokens.push({ text: text.slice(index, found.end), code: found.code })
      index = start = found.end
    }
    if (start < text.length) tokens.push({ text: text.slice(start) })
    return tokens.length ? tokens : [{ text }]
  }
  const matcher = { split, codes }
  cache.set(items, matcher)
  return matcher
}
