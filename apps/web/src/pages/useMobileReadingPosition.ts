import { useLayoutEffect, useRef } from 'react'
import { useMobileWorkspace } from '../useMobileWorkspace'

export function useMobileReadingPosition(view: 'catalog' | 'reader', ready = true) {
  const mobile = useMobileWorkspace()
  const catalog = useRef<HTMLElement>(null)
  const reader = useRef<HTMLElement>(null)
  const catalogScroll = useRef(0)
  const trigger = useRef<HTMLButtonElement | null>(null)

  function rememberCatalog(button?: HTMLButtonElement) {
    if (!mobile || view !== 'catalog') return
    catalogScroll.current = catalog.current?.closest<HTMLElement>('.workspace-tool-page')?.scrollTop ?? 0
    trigger.current = button ?? null
  }

  useLayoutEffect(() => {
    if (!mobile || !catalog.current?.isConnected) return
    if (view === 'reader') {
      if (!ready) return
      reader.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
      reader.current?.querySelector<HTMLButtonElement>('.reader-back')?.focus({ preventScroll: true })
    } else {
      const page = catalog.current.closest<HTMLElement>('.workspace-tool-page')
      page?.scrollTo?.({ top: catalogScroll.current, behavior: 'instant' })
      if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true })
    }
  }, [mobile, ready, view])

  return { mobile, catalog, reader, catalogScroll, rememberCatalog }
}
