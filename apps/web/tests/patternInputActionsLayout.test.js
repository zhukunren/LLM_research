import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const styles = readFileSync(resolve(process.cwd(), 'src/pages/pattern-comparison.css'), 'utf8')

// Structural CSS checks only: jsdom does not verify rendered browser geometry.
it('uses a two-column canvas starter grid and a vertical replacement menu', () => {
  expect(styles).toMatch(/\.pattern-start-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  const menu = styles.match(/\.pattern-input-action-menu\s*\{([^}]*)\}/)?.[1]
  expect(menu).toMatch(/display:\s*grid;/)
  expect(menu).not.toMatch(/grid-template-columns:|grid-auto-flow:\s*column/)
  expect(styles).not.toContain('.pattern-source-methods')
  expect(styles).not.toContain('.pattern-source-toolbar')
})

it('retains compact small-screen starters and visible keyboard focus cues', () => {
  const mobile = styles.slice(styles.indexOf('@media (max-width: 760px)'))
  expect(mobile).toMatch(/\.pattern-start-actions\s*\{[^}]*gap:\s*8px/)
  expect(styles).toMatch(/\.pattern-input-action-menu > button:focus-visible[^}]*\.pattern-start-actions > button:focus-visible[^}]*outline:\s*2px solid/)
})

it('lets focused targets scroll at every width without shrinking candidate review or the chart away', () => {
  const layout = readFileSync(resolve(process.cwd(), 'src/pages/pattern-editor-layout.css'), 'utf8')
  const desktop = styles.slice(0, styles.indexOf('@media'))
  expect(desktop).toMatch(/\.pattern-comparison-target-focused\s*\{[^}]*overflow-y:\s*auto;/)
  expect(layout).toMatch(/\.pattern-input-candidate\s*\{[^}]*flex-shrink:\s*0;/)
  expect(layout).toMatch(/\.pattern-unified-workspace \.pattern-comparison-target \.pattern-comparison-chart-content\s*\{[^}]*flex:\s*1 0 170px;[^}]*min-height:\s*170px;/)
  for (const stylesheet of [styles, layout]) {
    expect(stylesheet).not.toMatch(/\.pattern-comparison-target-focused \.pattern-comparison-chart-content\s*\{[^}]*min-height:\s*0(?:;|\s)/)
  }
})
