import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const readStyle = path => readFileSync(resolve(process.cwd(), 'src', path), 'utf8')
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fontSize = (path, selector) => {
  const styles = readStyle(path)
  const rules = [...styles.matchAll(new RegExp(`(?:^|\\n)\\s*${escape(selector)}\\s*\\{([^}]*)\\}`, 'g'))]
  const sizes = rules.flatMap(rule => [...rule[1].matchAll(/(?:^|;)\s*font-size:\s*([^;]+);/g)].map(match => match[1].trim()))
  if (!sizes.length) throw new Error(`Missing font-size: ${path} ${selector}`)
  return sizes.at(-1)
}

// Source-level regression guards for the pre-redesign rendered scale. These do
// not replace browser layout QA. Inherited sizes and the last owning stylesheet
// matter: the old token was 16px, but conversation prose rendered at 15px.
describe('original typography scale', () => {
  it('keeps navigation and archived-history labels at their original sizes', () => {
    expect(fontSize('chat-layout.css', '.chat-nav-button')).toBe('13px')
    expect(fontSize('components/conversation-history.css', '.chat-history-archive-toggle')).toBe('11px')
  })

  it('restores the exact responsive title clamp and inherited research prose', () => {
    expect(fontSize('research-chat.css', '.chat-page .chat-empty-heading h1')).toBe('clamp(28px, 3vw, 34px)')
    expect(fontSize('research-chat.css', '.chat-page .research-studio .research-answer')).toBe('15px')
    expect(fontSize('research-chat.css', '.chat-page .research-studio .research-answer :is(p, li, blockquote)')).toBe('inherit')
    expect(fontSize('research-chat.css', '.chat-page .research-studio .conversation-message-meta')).toBe('12px')
    // The final title/prose declarations continue to own the scale on small
    // screens; later responsive rules only alter layout and control dimensions.
    const responsive = readStyle('research-chat.css').split('@media (max-width: 700px)')[1]
    expect(responsive).not.toMatch(/font-size\s*:/)
  })

  it('retains the original research-shortcut title and secondary-text scale', () => {
    expect(fontSize('components/conversation/research-starters.css', '.research-start-option strong')).toBe('14px')
    expect(fontSize('components/conversation/research-starters.css', '.research-start-option small')).toBe('12px')
    expect(fontSize('components/conversation/screening-templates.css', '.screening-template-starter-label')).toBe('13px')
    expect(fontSize('components/conversation/screening-templates.css', '.screening-templates > p')).toBe('inherit')
  })

  it('maps the renamed assistant cards to the former workspace font sizes', () => {
    const path = 'pages/research-assistants.css'
    expect(fontSize(path, '.assistant-option h3')).toBe('14px')
    expect(fontSize(path, '.assistant-option-heading p')).toBe('12px')
    expect(fontSize(path, '.assistant-option-start')).toBe('13px')
    expect(fontSize(path, '.assistant-option-immediate .assistant-option-start')).toBe('12px')
    expect(fontSize(path, '.assistant-section-heading h2')).toBe('13px')
    expect(fontSize(path, '.assistant-option-details > summary')).toBe('12px')
    expect(fontSize(path, '.assistant-option-method')).toBe('13px')
  })

  it('restores compact result-table labels, coverage and run-history details', () => {
    const path = 'components/screening-result-list.css'
    expect(fontSize(path, '.screening-compact-table')).toBe('12px')
    expect(fontSize(path, '.screening-compact-table .stock-identity small, .screening-compact-table td > small')).toBe('10px')
    for (const selector of ['.screening-list-toolbar > span', '.viewport-workspace .screening-list-compact .conversation-coverage-note', '.conversation-history-result .history-run-context', '.conversation-history-result .history-run-context .history-date-notice']) {
      expect(fontSize(path, selector)).toBe('11px')
    }
  })

  it('keeps the redesigned layout and touch targets independently of font scale', () => {
    expect(readStyle('pages/research-assistants.css')).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))')
    expect(readStyle('components/conversation/screening-templates.css')).toContain('grid-template-columns:repeat(3,minmax(0,1fr))')
    expect(readStyle('components/conversation-history.css')).toContain('width: 44px; height: 44px; flex-basis: 44px;')
    expect(readStyle('components/screening-result-list.css')).toContain('min-height: 44px;')
  })
})
