import { useEffect, useState } from 'react'
import { api } from './api'

/** A changed request never exposes the previous resource under a new label. */
export function useRemoteResource<T>(path: string | null) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ path: string | null; data: T | null; loading: boolean; error: string }>({ path, data: null, loading: !!path, error: '' })
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setState({ path, data: null, loading: !!path, error: '' })
    if (path) {
      api<T>(path, { signal: controller.signal }).then(data => {
        if (active && !controller.signal.aborted) setState({ path, data, loading: false, error: '' })
      }).catch(reason => {
        if (active && !controller.signal.aborted) setState({ path, data: null, loading: false, error: (reason as Error).message })
      })
    }
    return () => { active = false; controller.abort() }
  }, [path, revision])
  const current = state.path === path ? state : { path, data: null, loading: !!path, error: '' }
  return { ...current, retry: () => { setState({ path, data: null, loading: !!path, error: '' }); setRevision(value => value + 1) } }
}
