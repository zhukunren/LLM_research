import { useCallback, useRef, useState, type SetStateAction } from 'react'
import { sessionStorage } from '../../authStorage'
import { useWorkspaceSession } from '../../WorkspaceSession'
import { indicatorComparisons, type IndicatorComparison } from '../../dynamicIndicators'

export type IndicatorDraft = {
  selection: { kind: 'trial'; id: string } | { kind: 'saved'; id: string; version: number } | null
  newIndicator: boolean
  description: string
  descriptionOpen: boolean
  stock: string
  asOf: string
  limit: number | null
  parameters: Record<string, number | null>
  saveName: string
  saveTarget: string
  output: string
  operator: IndicatorComparison
  threshold: string
  common: boolean
  mobileDetail: boolean
}

const MAX_BYTES = 32 * 1024
const MAX_AGE = 7 * 24 * 60 * 60 * 1000
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max
const numeric = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value)

function valid(value: unknown): value is IndicatorDraft {
  if (!object(value)) return false
  const selection = value.selection
  if (selection !== null && (!object(selection) || !text(selection.id, 256) || !selection.id || !(selection.kind === 'trial' || selection.kind === 'saved' && Number.isInteger(selection.version) && Number(selection.version) > 0))) return false
  if (!object(value.parameters) || Object.keys(value.parameters).length > 100 || !Object.entries(value.parameters).every(([key, item]) => key.length <= 100 && numeric(item))) return false
  return typeof value.newIndicator === 'boolean' && text(value.description, 4000) && typeof value.descriptionOpen === 'boolean'
    && text(value.stock, 32) && text(value.asOf, 32) && numeric(value.limit)
    && text(value.saveName, 100) && text(value.saveTarget, 256) && text(value.output, 256)
    && typeof value.operator === 'string' && Object.hasOwn(indicatorComparisons, value.operator)
    && text(value.threshold, 100) && typeof value.common === 'boolean' && typeof value.mobileDetail === 'boolean'
}

// Explicit projection: never store server definitions, source code, trial results or validation.
function editable(value: IndicatorDraft): IndicatorDraft {
  return {
    selection: value.selection?.kind === 'saved' ? { kind: 'saved', id: value.selection.id, version: value.selection.version } : value.selection ? { kind: 'trial', id: value.selection.id } : null,
    newIndicator: value.newIndicator, description: value.description, descriptionOpen: value.descriptionOpen,
    stock: value.stock, asOf: value.asOf, limit: Number.isFinite(value.limit) ? value.limit : null,
    parameters: Object.fromEntries(Object.entries(value.parameters).map(([key, item]) => [key, Number.isFinite(item) ? item : null])),
    saveName: value.saveName, saveTarget: value.saveTarget, output: value.output,
    operator: value.operator, threshold: value.threshold, common: value.common, mobileDetail: value.mobileDetail,
  }
}

function read(key: string, initial: IndicatorDraft): IndicatorDraft {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw || new TextEncoder().encode(raw).length > MAX_BYTES) return initial
    const saved: unknown = JSON.parse(raw)
    if (!object(saved) || saved.version !== 1 || typeof saved.savedAt !== 'number' || !Number.isFinite(saved.savedAt) || saved.savedAt > Date.now() || Date.now() - saved.savedAt > MAX_AGE || !valid(saved.draft)) return initial
    return editable(saved.draft)
  } catch { return initial }
}

/** Keep this hook above the drawer so storage failures still preserve closed drafts in memory. */
export function useIndicatorDraft(key: string, initial: IndicatorDraft) {
  const workspace = useWorkspaceSession()
  const storageKey = `dynamicIndicators.draft.${JSON.stringify([workspace.id, key])}`
  const [state, setState] = useState(() => ({ key: storageKey, value: read(storageKey, initial) }))
  const current = useRef(state)
  let selected = state
  if (state.key !== storageKey) {
    selected = { key: storageKey, value: read(storageKey, initial) }
    setState(selected)
  }
  current.current = selected
  const setDraft = useCallback((next: SetStateAction<IndicatorDraft>) => {
    // A callback retained by the previous context must not overwrite the new one.
    if (current.current.key !== storageKey) return
    const value = typeof next === 'function' ? next(current.current.value) : next
    const updated = { key: storageKey, value }
    current.current = updated
    try {
      const draft = editable(value)
      if (valid(draft)) {
        const raw = JSON.stringify({ version: 1, savedAt: Date.now(), draft })
        if (new TextEncoder().encode(raw).length <= MAX_BYTES) sessionStorage.setItem(storageKey, raw)
      }
    } catch { /* Storage is optional. Keep the live draft editable. */ }
    setState(updated)
  }, [storageKey])
  return [selected.value, setDraft] as const
}
