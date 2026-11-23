import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, setCsrfToken } from './api'
import { clearIdentityStorage, setStorageIdentity } from './authStorage'

type Me = { user_id: string; tenant_id: string; role: string; csrf_token: string }
const AccountContext = createContext<{ label: string; message: string; logout: () => Promise<void> } | null>(null)

export function WorkspaceAccount({ mobile = false }: { mobile?: boolean }) {
  const account = useContext(AccountContext)
  if (!account) return null
  return <div className={mobile ? 'mobile-workspace-account' : 'workspace-account-bar'}>
    <span>{account.label}</span>
    <button type="button" onClick={() => void account.logout()} className="secondary-button compact workspace-button">退出登录</button>
    {account.message && <span role="status">{account.message}</span>}
  </div>
}

export default function AuthBoundary({ children }: { children: ReactNode }) {
  const [required, setRequired] = useState((window as Window & { __LLMR_AUTH_REQUIRED__?: boolean }).__LLMR_AUTH_REQUIRED__ === true)
  const [user, setUser] = useState<Me | null>(null)
  const [message, setMessage] = useState('正在检查登录状态…')
  const generation = useRef(0)
  const loggingOut = useRef(false)
  useEffect(() => {
    const expired = () => { generation.current += 1; setCsrfToken(''); clearIdentityStorage(); setUser(null); setRequired(true); setMessage('登录已失效，请重新登录。') }
    window.addEventListener('llmr-auth-required', expired)
    return () => window.removeEventListener('llmr-auth-required', expired)
  }, [])
  useEffect(() => {
    if (!required) return
    let active = true
    const expectedGeneration = generation.current
    const controller = new AbortController()
    api<Me>('/me', { signal: controller.signal }).then(me => {
      if (!active || expectedGeneration !== generation.current) return
      setStorageIdentity(me.user_id, me.tenant_id)
      setCsrfToken(me.csrf_token)
      setUser(me)
      setMessage('')
    }).catch(() => { if (active && expectedGeneration === generation.current) setMessage('请登录后使用投研工作台。') })
    return () => { active = false; controller.abort() }
  }, [required])
  useEffect(() => {
    if (!user) return
    const identity = `${user.tenant_id}:${user.user_id}`
    let active = true
    const requests = new Set<AbortController>()
    const changed = (event: StorageEvent) => {
      if (event.key === null || (event.key === 'llmr.identity' && event.newValue !== identity)) {
        generation.current += 1
        setCsrfToken(''); clearIdentityStorage(false); setUser(null); setMessage('账户已切换，请重新登录。')
      }
    }
    const focused = () => {
      if (loggingOut.current) return
      const expectedGeneration = generation.current
      const controller = new AbortController()
      requests.add(controller)
      void api<Me>('/me', { signal: controller.signal }).then(me => {
        if (!active || expectedGeneration !== generation.current) return
        setStorageIdentity(me.user_id, me.tenant_id)
        setCsrfToken(me.csrf_token)
        setUser(me)
      }).catch(() => {}).finally(() => requests.delete(controller))
    }
    window.addEventListener('storage', changed)
    window.addEventListener('focus', focused)
    return () => { active = false; requests.forEach(controller => controller.abort()); window.removeEventListener('storage', changed); window.removeEventListener('focus', focused) }
  }, [user])
  if (!required) return <>{children}</>
  if (!user) return <main className="workspace-sign-in">
    <section className="workspace-sign-in-panel" aria-labelledby="workspace-sign-in-title">
      <img src="/brand/soochow-blue.png" alt="东吴证券" width={134} />
      <h1 id="workspace-sign-in-title">投研工作台</h1>
      <p role="status">{message}</p>
      <a className="primary-button workspace-button" href="/auth/login">登录</a>
    </section>
  </main>
  async function logout() {
    if (loggingOut.current) return
    loggingOut.current = true
    const expectedGeneration = ++generation.current
    try {
      const response = await fetch('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': user!.csrf_token } })
      if (expectedGeneration !== generation.current) return
      if (!response.ok && response.status !== 401) { setMessage('退出登录失败，请重试。'); return }
      generation.current += 1
      setCsrfToken(''); clearIdentityStorage(); setUser(null); setMessage('已退出登录。')
    } catch { if (expectedGeneration === generation.current) setMessage('退出登录失败，请重试。') }
    finally { loggingOut.current = false }
  }
  return <AccountContext.Provider value={{ label: user.role === 'viewer' ? '当前账户仅可查看资料' : '已登录', message, logout }}>
    <div className="workspace-authenticated" key={`${user.tenant_id}:${user.user_id}`}>
      <WorkspaceAccount />{children}
    </div>
  </AccountContext.Provider>
}
