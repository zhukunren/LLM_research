import type { ConversationSourceReference } from './api'
import type { WorkspaceRoute } from './workspaceRoute'

export type DraftSource = { reference: ConversationSourceReference; label: string }
export type DraftContent = { prompt: string; sources: DraftSource[] }
export type ComposerDraft = DraftContent & { key: string }
export type TabLocation = { id: string; route: WorkspaceRoute }

export type ScreeningResultLocation = {
  conversationId: string
  runId: string
  stockCode: string
  state: string
  query: string
  offset: number
}

export type DraftTransfer =
  | { kind: 'new'; draft: DraftContent }
  | { kind: 'add'; key: string; draft: DraftContent }

export type WorkspaceReturn =
  | { kind: 'question'; from: TabLocation; draft: DraftContent }
  | { kind: 'report'; from: TabLocation }
  | { kind: 'result'; from: TabLocation; result: ScreeningResultLocation }

export type WorkspaceHandoff = {
  reportPicker?: { from: TabLocation; draft: ComposerDraft }
  returnTo?: WorkspaceReturn
  transfer?: DraftTransfer
  screeningResult?: ScreeningResultLocation
}

export type ConversationHandoff = {
  transfer?: DraftTransfer
  onTransferApplied: (transfer: DraftTransfer) => void
  pickReport: (draft: ComposerDraft) => void
  returnAction?: { label: string; onClick: () => void }
  screeningResult?: ScreeningResultLocation
  onReleaseScreeningResult: () => void
}

export const MAX_DRAFT_SOURCES = 8

export function draftSourceKey({ reference }: DraftSource) {
  return JSON.stringify([reference.kind, reference.source_id, reference.page_number, reference.version, reference.stock_code])
}

export function mergeDraftSources(current: DraftSource[], additions: DraftSource[]) {
  const result = new Map(current.map(item => [draftSourceKey(item), item]))
  for (const source of additions) {
    const key = draftSourceKey(source)
    if (!result.has(key)) result.set(key, source)
  }
  return [...result.values()]
}
