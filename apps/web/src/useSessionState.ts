import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import { sessionStorage } from './authStorage'
import { useWorkspaceSession } from './WorkspaceSession'

// Session storage restores a reading position without carrying it to another browser session.
export function useSessionState<T>(key: string, initial: T, valid: (value: unknown) => value is T) {
  const session = useWorkspaceSession()
  const legacyKey = key
  key = session.id ? `tab.${session.id}.${key}` : key
  const read = () => {
    let value = initial
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? (session.legacy ? sessionStorage.getItem(legacyKey) : null) ?? 'null')
      if (valid(saved)) value = saved
    } catch { /* Reading still works when storage is unavailable. */ }
    return { key, value, persisted: false }
  }
  const [state, setState] = useState(read)
  const current = useRef(state)
  // A different workspace/key owns a different draft. Never persist the old
  // key's value under the new key before its restoration effect runs.
  if (current.current.key !== key) current.current = read()
  const setValue = useCallback((next: SetStateAction<T>) => {
    if (current.current.key !== key) return // A stale owner cannot edit a new key.
    const value = typeof next === 'function' ? (next as (value: T) => T)(current.current.value) : next
    let persisted = false
    // A save may close its editor in the same batch. Persist before that unmount.
    try { sessionStorage.setItem(key, JSON.stringify(value)); persisted = true } catch { /* Editing still works without storage. */ }
    current.current = { key, value, persisted }
    setState(current.current)
  }, [key])
  useEffect(() => {
    if (current.current.key !== key) return
    // Use the latest synchronous update, including clears from layout effects.
    setValue(value => value)
  }, [key, setValue])
  return [current.current.value, setValue, { persisted: current.current.persisted }] as const
}

export const isText = (value: unknown): value is string => typeof value === 'string'
export const isPageOffset = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
