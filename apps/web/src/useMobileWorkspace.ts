import { useSyncExternalStore } from 'react'

export const mobileWorkspaceQuery = '(max-width: 760px)'

function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(mobileWorkspaceQuery)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}

export function useMobileWorkspace() {
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(mobileWorkspaceQuery).matches ?? false, () => false)
}
