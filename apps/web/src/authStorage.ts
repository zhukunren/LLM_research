// Storage values belong to the authenticated user, never to a provider token.
let namespace = ''

export function setStorageIdentity(user: string, tenant: string) {
  const identity = `${tenant}:${user}`
  try {
    if (window.localStorage.getItem('llmr.identity') !== identity) {
      window.localStorage.clear()
      window.sessionStorage.clear()
    } else if (window.sessionStorage.getItem('llmr.identity') !== identity) {
      // A new tab has its own empty session store but shares this user's drafts.
      window.sessionStorage.clear()
    }
    window.sessionStorage.setItem('llmr.identity', identity)
    window.localStorage.setItem('llmr.identity', identity)
  } catch { /* Browser storage is optional; the in-memory namespace still applies. */ }
  namespace = `llmr:${identity}:`
}

export function clearIdentityStorage(clearShared = true) {
  try { if (clearShared) window.localStorage.clear() } catch { /* Storage is optional. */ }
  try { window.sessionStorage.clear() } catch { /* Storage is optional. */ }
  namespace = ''
}

function scoped(kind: 'localStorage' | 'sessionStorage') {
  return {
    getItem: (key: string) => window[kind].getItem(namespace + key),
    setItem: (key: string, value: string) => window[kind].setItem(namespace + key, value),
    removeItem: (key: string) => window[kind].removeItem(namespace + key),
  }
}

export const localStorage = scoped('localStorage')
export const sessionStorage = scoped('sessionStorage')
