import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps reading navigation and matrix single-question layout scoped to narrow screens', () => {
  const answer = readFileSync('src/visual-polish.css', 'utf8')
  const matrix = readFileSync('src/research-workbench.css', 'utf8')
  expect(answer).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.research-answer-section-list \{ display: none;/)
  expect(answer).toContain('.research-answer-section-picker { display: none; }')
  expect(matrix).toContain('.research-matrix-question-picker { display:none; }')
  expect(matrix).toMatch(/@media\(max-width:720px\)[\s\S]*?td:not\(\[data-active-question="true"\]\) \{ display:none;/)
  expect(matrix).toContain('.research-matrix-panel .research-matrix-table.workspace-data-table :is(th,td) { display:block; min-width:0; width:auto; position:static;')
})
