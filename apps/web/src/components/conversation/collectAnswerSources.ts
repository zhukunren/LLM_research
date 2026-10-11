import type { ConversationMessage } from '../../api'

/** Collect references actually supplied with this answer. */
export function answerSources(message: ConversationMessage): Record<string, unknown>[] {
  const references = [...message.source_refs]
  const body = message.content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const links = /(?<!!)\[([^\]\n]+)\]\(\s*(https?:\/\/(?:[^\s()]|\([^()]*\))+)(?:\s+["'][^"']*["'])?\s*\)/gi
  for (const match of body.matchAll(links)) references.push({ kind: 'web', title: match[1], url: match[2] })
  // Reference-style links and standalone source URLs are also common in research answers.
  for (const match of body.matchAll(/^\s*\[([^\]]+)\]:\s*<?(https?:\/\/[^\s>]+)>?/gm)) references.push({ kind: 'web', title: match[1], url: match[2] })
  for (const match of body.matchAll(/https?:\/\/[^\s<>\]"']+/gi)) {
    const url = match[0].replace(/[.,;，。；）]+$/, '').replace(/\)+$/, '')
    if (!references.some(ref => ref.url === url || typeof ref.url === 'string' && match[0].startsWith(ref.url))) references.push({ kind: 'web', title: url, url })
  }
  const seen = new Set<string>()
  return references.filter(ref => {
    const key = ref.url ? String(ref.url) : `${ref.kind}:${ref.source_id}:${ref.page_number || ''}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}
