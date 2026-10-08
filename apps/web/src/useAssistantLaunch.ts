import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiRequestError } from './api'
import { readModelPreference } from './modelSelection'

export type AssistantLaunchResult = {
  request_id: string
  assistant_id: string
  conversation_id: string
  turn_id: string
  job_id: string | null
  state: string
  job_state: string | null
  as_of_date: string
  started_at: string
  timezone: string
  assistant_revision: number
  skill_hash: string
  idempotent_replay: boolean
}

type LaunchPayload = { request_id: string; model_id?: string; reasoning_effort?: string }
type Attempt = { assistantId: string; name: string; payload: LaunchPayload; createdAt: number }
type Pending = Record<string, Attempt>
export type AssistantLaunchState = {
  loading: boolean; error: string; name: string; recoverable: boolean; assistantId: string | null
}

const STORAGE_KEY = 'llmr.assistant-launches.v1'
const EMPTY: AssistantLaunchState = { loading: false, error: '', name: '', recoverable: false, assistantId: null }

function readPending(): Pending {
  const pending: Pending = Object.create(null)
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return pending
    for (const [key, value] of Object.entries(saved)) {
      if (!value || typeof value !== 'object') continue
      const item = value as Partial<Attempt>
      if (item.assistantId !== key || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(key)
        || typeof item.name !== 'string' || !item.payload || typeof item.payload !== 'object'
        || typeof item.payload.request_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(item.payload.request_id)
        || (item.payload.model_id !== undefined && typeof item.payload.model_id !== 'string')
        || (item.payload.reasoning_effort !== undefined && typeof item.payload.reasoning_effort !== 'string')
        || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)) continue
      // Rebuild allowed fields so damaged storage cannot add launch arguments.
      pending[key] = { assistantId: key, name: item.name, createdAt: item.createdAt, payload: {
        request_id: item.payload.request_id,
        ...(item.payload.model_id ? { model_id: item.payload.model_id } : {}),
        ...(item.payload.reasoning_effort ? { reasoning_effort: item.payload.reasoning_effort } : {}),
      } }
    }
  } catch { /* An unavailable store does not prevent launching in this page. */ }
  return pending
}

function persist(pending: Pending) {
  try {
    if (Object.keys(pending).length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch { /* The in-memory attempt still protects retries in this page. */ }
}

function newest(pending: Pending) {
  return Object.values(pending).sort((a, b) => b.createdAt - a.createdAt)[0]
}

export function useAssistantLaunch() {
  const pending = useRef<Pending | null>(null)
  if (!pending.current) pending.current = readPending()
  const initial = newest(pending.current)
  const selected = useRef<string | null>(initial?.assistantId ?? null)
  const inFlight = useRef(new Map<string, Promise<AssistantLaunchResult | null>>())
  const generation = useRef(0)
  const mounted = useRef(true)
  const [state, setState] = useState<AssistantLaunchState>(() => initial ? {
    loading: false, error: '上次启动尚未确认，可以继续。', name: initial.name,
    recoverable: true, assistantId: initial.assistantId,
  } : EMPTY)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const launch = useCallback((id: string, name?: string): Promise<AssistantLaunchResult | null> => {
    const running = inFlight.current.get(id)
    if (running) return running
    const stored = pending.current![id]
    const attempt: Attempt = stored ?? {
      assistantId: id, name: name || '研究助手', createdAt: Date.now(),
      payload: { request_id: crypto.randomUUID(), ...(readModelPreference() ?? {}) },
    }
    pending.current![id] = attempt
    // Save before transport: a refresh or lost response must reuse this intent.
    persist(pending.current!)
    selected.current = id
    const current = ++generation.current
    setState({ loading: true, error: '', name: attempt.name, recoverable: false, assistantId: id })
    const request = (async () => {
      try {
        const result = await api<AssistantLaunchResult>(`/research-assistants/${encodeURIComponent(id)}/launch`, {
          method: 'POST', body: JSON.stringify(attempt.payload),
        })
        if (!result || !result.conversation_id || !result.turn_id
          || result.request_id !== attempt.payload.request_id || result.assistant_id !== id) {
          throw new Error('暂未确认启动结果，请重试。')
        }
        if (pending.current![id]?.payload.request_id === attempt.payload.request_id) {
          delete pending.current![id]
          persist(pending.current!)
        }
        if (mounted.current && generation.current === current) {
          selected.current = null
          setState({ ...EMPTY, name: attempt.name, assistantId: id })
        }
        return result
      } catch (error) {
        const details = error instanceof ApiRequestError ? error.details : null
        const hasExistingTask = !!details && typeof details === 'object'
          && ('conversation_id' in details || 'turn_id' in details || 'recoverable' in details)
        const rejectedBeforeCreation = error instanceof ApiRequestError && error.status === 422
          && ['validation_error', 'conversation_error', 'research_assistant_error', 'research_assistant_launch_error'].includes(error.code ?? '')
          && !hasExistingTask
        if (rejectedBeforeCreation && pending.current![id]?.payload.request_id === attempt.payload.request_id) {
          delete pending.current![id]
          persist(pending.current!)
        }
        if (mounted.current && generation.current === current) {
          const message = error instanceof Error && error.message ? error.message.slice(0, 240) : '暂时无法启动，请重试。'
          if (rejectedBeforeCreation) selected.current = null
          setState({ loading: false, error: rejectedBeforeCreation ? `${message} 请调整选择后重新启动。` : message,
            name: attempt.name, recoverable: !rejectedBeforeCreation, assistantId: id })
        }
        return null
      } finally {
        inFlight.current.delete(id)
      }
    })()
    inFlight.current.set(id, request)
    return request
  }, [])

  const retry = useCallback(() => selected.current ? launch(selected.current) : Promise.resolve(null), [launch])
  const dismiss = useCallback(() => {
    generation.current += 1
    selected.current = null
    setState(EMPTY)
  }, [])
  return { launch, retry, dismiss, state }
}
