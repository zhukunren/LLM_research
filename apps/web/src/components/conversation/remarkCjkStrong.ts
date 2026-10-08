import type { Root, RootContent, Text } from 'mdast'
import type { Processor, Transformer } from 'unified'

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const punctuationEnd = /\p{P}$/u
const wordStart = /^[\p{L}\p{N}]/u
const protectedNodes = new Set(['code', 'inlineCode', 'html', 'link', 'linkReference', 'image', 'imageReference', 'definition'])

function escaped(source: string, offset: number): boolean {
  let slashes = 0
  while (offset > 0 && source[--offset] === '\\') slashes++
  return slashes % 2 === 1
}

/**
 * LLM prose commonly writes `**研究范围：**北京时间…`. CommonMark leaves
 * this literal because punctuation immediately before the closing delimiter
 * prevents it closing beside a word. Repair only that CJK pattern in parsed
 * text nodes, never by rewriting the full Markdown or enabling HTML rendering.
 */
export default function remarkCjkStrong(this: Processor): Transformer<Root> {
  const processor = this
  return (tree, file) => {
    const source = String(file)
    function repair(node: Text): RootContent[] | null {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined || !node.value.includes('**')) return null
      const raw = source.slice(start, end)
      const pattern = /\*\*([^*\n]+)\*\*/gu
      const insertions: number[] = []
      for (const match of raw.matchAll(pattern)) {
        const open = match.index
        const close = open + match[0].length - 2
        const after = close + 2
        const body = match[1]
        if (raw[open - 1] === '*' || raw[after] === '*' || escaped(raw, open) || escaped(raw, close)
          || body.trim() !== body || !cjk.test(body) || !punctuationEnd.test(body) || !wordStart.test(raw.slice(after))) continue
        insertions.push(after)
      }
      if (!insertions.length) return null

      // A temporary separator lets the existing parser handle escapes, entities
      // and inline syntax. Remove only those generated separators from its AST.
      let fragment = '', previous = 0
      const generatedSpaces = new Set<number>()
      for (const offset of insertions) {
        fragment += raw.slice(previous, offset)
        generatedSpaces.add(fragment.length)
        fragment += ' '
        previous = offset
      }
      fragment += raw.slice(previous)
      const parsed = processor.parse(fragment) as Root
      if (parsed.children.length !== 1 || parsed.children[0].type !== 'paragraph') return null
      const children = parsed.children[0].children
      let removed = 0
      function clean(node: RootContent) {
        if (node.type === 'text' && generatedSpaces.has(node.position?.start.offset ?? -1) && node.value.startsWith(' ')) {
          node.value = node.value.slice(1)
          removed++
        }
        // Synthesized fragment offsets are not positions in the saved answer.
        delete node.position
        if ('children' in node) node.children.forEach(clean)
      }
      children.forEach(clean)
      return removed === insertions.length ? children : null
    }

    function visit(node: Root | RootContent) {
      if (protectedNodes.has(node.type) || !('children' in node)) return
      const children: RootContent[] = []
      for (const child of node.children) {
        const replacement = child.type === 'text' ? repair(child) : null
        if (replacement) children.push(...replacement)
        else { visit(child); children.push(child) }
      }
      // Replacements contain only phrasing nodes and stay within their original
      // paragraph/heading/table cell; structural Markdown remains unchanged.
      node.children = children as typeof node.children
    }
    visit(tree)
  }
}
