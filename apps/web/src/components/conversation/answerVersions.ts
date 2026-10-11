import type { ConversationMessage } from '../../api'

export function answerVersions(messages: ConversationMessage[]) {
  const groups = new Map<string, ConversationMessage[]>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const root = message.regeneration_of || message.id
    groups.set(root, [...(groups.get(root) || []), message])
  }
  return groups
}

export function displayedMessages(messages: ConversationMessage[], selection: Record<string, string> = {}) {
  const groups = answerVersions(messages), emitted = new Set<string>()
  return messages.flatMap(message => {
    if (message.role === 'user' && message.regeneration_of) return []
    if (message.role !== 'assistant') return [message]
    const root = message.regeneration_of || message.id
    if (emitted.has(root)) return []
    emitted.add(root)
    const versions = groups.get(root)!
    return [versions.find(item => item.id === selection[root]) || versions.at(-1)!]
  })
}
