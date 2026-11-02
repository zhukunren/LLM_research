import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('keeps long question navigation outside the log with a compact narrow-screen selector', () => {
  const css = readFileSync('src/research-chat.css', 'utf8')
  expect(css).toContain('.research-question-index { flex-shrink: 0;')
  expect(css).toContain('.research-question-index details { display: none; }')
  expect(css).toContain('.research-question-select { display: flex;')
})
it('bounds the expanded source session and hides, rather than unmounts, the reader', () => {
  const css = readFileSync('src/components/library-quick-session.css', 'utf8')
  expect(css).toContain('.page-content.library-shell.library-session-expanded > :is(')
  expect(css).toContain('.library-quick-expanded { display: flex; flex: 1; flex-direction: column;')
  const view = readFileSync('src/pages/LibraryWorkspace.tsx', 'utf8')
  expect(view).toContain("expandedEntry ? ' library-session-expanded'")
  expect(view).not.toContain('!expandedEntry &&')
})
