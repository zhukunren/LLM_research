export function tooltipPosition(anchor: { left: number; top: number; width: number; height: number }, size: { width: number; height: number }, viewport: { left: number; top: number; width: number; height: number }) {
  const edge = 12, gap = 8
  const minX = viewport.left + edge, minY = viewport.top + edge
  const maxX = Math.max(minX, viewport.left + viewport.width - size.width - edge)
  const maxY = Math.max(minY, viewport.top + viewport.height - size.height - edge)
  const above = anchor.top - size.height - gap
  return {
    left: Math.max(minX, Math.min(maxX, anchor.left + anchor.width / 2 - size.width / 2)),
    top: Math.max(minY, Math.min(maxY, above >= minY ? above : anchor.top + anchor.height + gap)),
  }
}
