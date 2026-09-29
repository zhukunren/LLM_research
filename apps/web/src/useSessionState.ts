import { useEffect, useState } from 'react'

// Session storage restores a reading position without carrying it to another browser session.
export function useSessionState<T>(key: string, initial: T, valid: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
      return valid(saved) ? saved : initial
    } catch { return initial }
  })
  useEffect(() => {
    try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* Reading still works when storage is unavailable. */ }
  }, [key, value])
  return [value, setValue] as const
}

export const isText = (value: unknown): value is string => typeof value === 'string'
export const isPageOffset = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
