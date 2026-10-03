import type { KeyboardEvent } from 'react'

export function navigateTabs<T extends string>(event: KeyboardEvent<HTMLElement>, ids: readonly T[], selected: T, select: (value: T) => void) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !(event.target as Element).closest('[role="tab"]')) return
  event.preventDefault()
  const current = ids.indexOf(selected)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length
  select(ids[index])
  event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus()
}

export function trapDialogTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const root = event.currentTarget
  const elements = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]')].filter(element => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false
    const closed = element.closest('details:not([open])')
    if (closed && element.closest('summary') !== closed.querySelector('summary')) return false
    let parent: Element | null = element
    while (parent && parent !== root) {
      const style = getComputedStyle(parent)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      parent = parent.parentElement
    }
    return true
  })
  const first = elements[0], last = elements.at(-1), focused = root.ownerDocument.activeElement
  if (!first) { event.preventDefault(); root.focus(); return }
  if (event.shiftKey && (focused === first || focused === root || !root.contains(focused))) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && (focused === last || !root.contains(focused))) { event.preventDefault(); first.focus() }
}
