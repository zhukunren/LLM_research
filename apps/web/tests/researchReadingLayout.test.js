import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps answer reading navigation scoped to narrow screens', () => {
  const answer = readFileSync('src/visual-polish.css', 'utf8')
  expect(answer).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.research-answer-section-list \{ display: none;/)
  expect(answer).toContain('.research-answer-section-picker { display: none; }')
})
