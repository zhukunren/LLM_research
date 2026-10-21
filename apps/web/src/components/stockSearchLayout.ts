export function placeStockOptions(control: { top: number; bottom: number }, bounds: { top: number; bottom: number }, contentHeight: number) {
  const aboveSpace = Math.max(0, control.top - bounds.top - 6)
  const belowSpace = Math.max(0, bounds.bottom - control.bottom - 6)
  const desired = Math.min(320, contentHeight)
  const above = belowSpace < desired && aboveSpace > belowSpace
  return { above, maxHeight: Math.min(320, above ? aboveSpace : belowSpace) }
}
