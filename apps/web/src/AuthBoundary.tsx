import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, setCsrfToken } from './api'
import { clearIdentityStorage, setStorageIdentity } from './authStorage'

type Me = { user_id: string; tenant_id: string; role: string; csrf_token: string }

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
  if (!user) return <main style={{ maxWidth: 460, margin: '80px auto', padding: 24 }}>
    <h1>投研工作台</h1><p>{message}</p><a href="/auth/login">登录</a>
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
  return <div key={`${user.tenant_id}:${user.user_id}`}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 16px', borderBottom: '1px solid var(--border)' }}>
      <span>{user.role === 'viewer' ? '当前账户仅可查看资料' : '已登录'}</span>
      <button type="button" onClick={() => { void logout() }} className="workspace-button">退出登录</button>
      {message && <span role="status">{message}</span>}
    </div>{children}
  </div>
}
