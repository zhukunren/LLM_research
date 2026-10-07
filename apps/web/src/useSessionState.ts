import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'

// Session storage restores a reading position without carrying it to another browser session.
export function useSessionState<T>(key: string, initial: T, valid: (value: unknown) => value is T) {
  const [value, setState] = useState<T>(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
      return valid(saved) ? saved : initial
    } catch { return initial }
  })
  const current = useRef(value)
  const setValue = useCallback((next: SetStateAction<T>) => {
    const resolved = typeof next === 'function' ? (next as (value: T) => T)(current.current) : next
    current.current = resolved
    // A save may close its editor in the same batch. Persist before that unmount.
    try { sessionStorage.setItem(key, JSON.stringify(resolved)) } catch { /* Editing still works without storage. */ }
    setState(resolved)
  }, [key])
  useEffect(() => {
    // A previously scheduled effect must not restore an older draft after a
    // synchronous save/clear, including layout effects and StrictMode mounts.
    try { sessionStorage.setItem(key, JSON.stringify(current.current)) } catch { /* Reading still works when storage is unavailable. */ }
  }, [key])
  return [value, setValue] as const
}

export const isText = (value: unknown): value is string => typeof value === 'string'
export const isPageOffset = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
