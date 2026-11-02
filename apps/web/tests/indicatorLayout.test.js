import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Structural CSS checks only; this environment cannot run browser layout QA.
it('reserves a non-scrolling action row and hides the whole detail pane on mobile list view', () => {
  const indicatorStyles = readFileSync(resolve(process.cwd(), 'src/components/indicators/my-indicators.css'), 'utf8')
  expect(indicatorStyles).toMatch(/\.my-indicators-detail-pane \{[^}]*display:flex;[^}]*min-height:0;[^}]*overflow:hidden;/)
  expect(indicatorStyles).toMatch(/\.my-indicators-detail \{[^}]*flex:1;[^}]*overflow:auto;/)
  expect(indicatorStyles).toMatch(/\.my-indicators-stage-bar \{[^}]*flex-shrink:0;/)
  const mobile = indicatorStyles.split('@media(max-width:700px)')[1]
  expect(mobile).toContain('.my-indicators-detail-pane { display:none; }')
  expect(mobile).toContain('.my-indicators-detail-open .my-indicators-detail-pane { display:flex; }')
})
