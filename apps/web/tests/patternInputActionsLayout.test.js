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
  expect(layout).toMatch(/\.pattern-unified-workspace \.pattern-comparison-target \.pattern-comparison-chart-content\s*\{[^}]*flex:\s*1 0 280px;[^}]*min-height:\s*280px;/)
  for (const stylesheet of [styles, layout]) {
    expect(stylesheet).not.toMatch(/\.pattern-comparison-target-focused \.pattern-comparison-chart-content\s*\{[^}]*min-height:\s*0(?:;|\s)/)
  }
})


it('uses the full width before results and reserves canvas space only for a real target or drawing', () => {
  const layout = readFileSync(resolve(process.cwd(), 'src/pages/pattern-editor-layout.css'), 'utf8')
  expect(styles).toMatch(/\.pattern-comparison\[data-has-results=false\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/)
  expect(layout).toMatch(/\.pattern-comparison-target\[data-state=empty\] \.pattern-comparison-chart-content\s*\{[^}]*flex:\s*none;[^}]*min-height:\s*0;/)
  expect(layout).toMatch(/\.pattern-comparison-target\[data-state=input\]\s*\{[^}]*flex:\s*none;/)
  expect(layout).toMatch(/\.pattern-comparison-target:not\(\.pattern-comparison-target-focused\):is\(\[data-state=target\],\s*\[data-drawing=true\]\) \.pattern-comparison-chart-content\s*\{[^}]*height:\s*clamp\(280px,\s*38dvh,\s*420px\);/)
  expect(layout).toMatch(/\.pattern-unified-workspace\[data-panel=create\] > #pattern-content\s*\{[^}]*overflow-y:\s*auto;/)
  expect(styles).toMatch(/\.pattern-target-controls\s*\{[^}]*display:\s*grid;/)
})

it('keeps market inputs in a bounded desktop row and wraps by actual panel width', () => {
  expect(styles).toMatch(/\.pattern-input-panel\s*\{[^}]*max-width:\s*960px;[^}]*container-type:\s*inline-size;[^}]*container-name:\s*pattern-input;/)
  expect(styles).toMatch(/\.pattern-comparison-studio \.pattern-market-fields\s*\{[^}]*grid-template-columns:\s*minmax\(180px,\s*1\.5fr\) repeat\(2,\s*minmax\(145px,\s*1fr\)\) auto;/)
  const narrow = styles.slice(styles.indexOf('@container pattern-input (max-width: 640px)'))
  expect(narrow).toMatch(/\.pattern-market-fields\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/)
  expect(narrow).toMatch(/\.pattern-market-fields > button\s*\{[^}]*grid-column:\s*1 \/ -1;/)
  const smallest = styles.slice(styles.indexOf('@container pattern-input (max-width: 360px)'))
  expect(smallest).toMatch(/\.pattern-market-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/)
})

it('preserves the original match-button type size after moving it beside save controls', () => {
  expect(styles).toMatch(/\.pattern-target-controls \.pattern-workbench-footer > \.primary-button\s*\{[^}]*font-size:\s*13px;/)
})
