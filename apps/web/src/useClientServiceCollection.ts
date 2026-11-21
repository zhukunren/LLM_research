import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api, ApiRequestError } from './api'
import { useWorkspaceSession } from './WorkspaceSession'

type CollectionRequest = { id: string; accepted: boolean }
type CollectionStatus = { request_id: string; state: string }
type CollectionError = { id: string; message: string; retry: boolean }
const pending = (status: CollectionStatus) => status.state === 'awaiting_agent' || status.state === 'running'

export function useClientServiceCollection<Request extends CollectionRequest, Status extends CollectionStatus>(
  endpoint: string,
  request: Request | null,
  setRequest: Dispatch<SetStateAction<Request | null>>,
  submission: (request: Request) => object,
  onResult: (status: Status) => void,
) {
  const { active } = useWorkspaceSession()
  const [status, setStatus] = useState<Status | null>(null)
  const [failure, setFailure] = useState<CollectionError | null>(null)
  const [cancelFailure, setCancelFailure] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const polling = useRef<AbortController | null>(null)
  const requestId = useRef<string | undefined>(request?.id)
  requestId.current = request?.id
  const current = status?.request_id === request?.id ? status : null
  const error = failure?.id === request?.id ? failure : null
  const busy = !!request && !error && (!current || pending(current))
  const stopping = stoppingId === request?.id

  useEffect(() => {
    if (!active || !request) return
    const submitted = request
    const { id, accepted } = submitted
    const controller = new AbortController()
    polling.current = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    setFailure(null)

    async function read() {
      if (controller.signal.aborted) return
      try {
        const value = accepted
          ? await api<Status>(endpoint + '/' + encodeURIComponent(id), { signal: controller.signal })
          : await api<Status>(endpoint, {
            method: 'POST', signal: controller.signal, body: JSON.stringify(submission(submitted)),
          })
        if (controller.signal.aborted) return
        if (value.request_id !== id) throw new Error('服务返回的采集请求不匹配，请重试。')
        setStatus(value)
        onResult(value)
        if (!accepted) setRequest(current => current?.id === id ? { ...current, accepted: true } : current)
        else if (pending(value)) timer = setTimeout(() => void read(), 2000)
      } catch (cause) {
        if (!controller.signal.aborted) setFailure({
          id, message: cause instanceof Error ? cause.message : '暂时无法读取采集结果。',
          retry: !(cause instanceof ApiRequestError) || cause.status >= 500,
        })
      }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, endpoint, request, attempt, setRequest, submission, onResult])

  function begin(next: Request) {
    setStatus(null)
    setFailure(null)
    setCancelFailure(null)
    setRequest(next)
  }

  async function stop() {
    if (!request?.accepted || stopping) return
    const { id } = request
    const controller = polling.current
    setStoppingId(id)
    setCancelFailure(null)
    try {
      const value = await api<Status>(endpoint + '/' + encodeURIComponent(id) + '/cancel', { method: 'POST' })
      if (requestId.current === id) {
        controller?.abort()
        setStatus(value)
        setFailure(null)
        onResult(value)
      }
    } catch {
      if (requestId.current === id) setCancelFailure(id)
    } finally {
      setStoppingId(current => current === id ? null : current)
    }
  }

  return {
    current, error, busy, stopping, begin, stop,
    retry: () => setAttempt(value => value + 1),
    stopError: cancelFailure === request?.id ? '暂时无法停止采集，请稍后重试。' : '',
  }
}
