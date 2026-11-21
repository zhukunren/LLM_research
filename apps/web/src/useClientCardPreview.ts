import { useEffect, useState } from 'react'
import { api } from './api'
import type { CardPreview } from './clientService'
import { useWorkspaceSession } from './WorkspaceSession'

export function useClientCardPreview(path: string, body: string | null) {
  const { active } = useWorkspaceSession()
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; value: CardPreview } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const key = JSON.stringify([path, body, attempt])
  useEffect(() => {
    if (!active || !body) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void api<CardPreview>(path, { method: 'POST', body, signal: controller.signal })
        .then(value => { if (!controller.signal.aborted) setResult({ key, value }) })
        .catch((reason: Error) => { if (!controller.signal.aborted) setFailure({ key, message: reason.message }) })
    }, 240)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, path, body, key])
  const preview = result?.key === key ? result.value : undefined
  return {
    preview,
    visible: body ? result?.value : undefined,
    error: !preview && failure?.key === key ? failure.message : '',
    retry: () => setAttempt(value => value + 1),
  }
}
