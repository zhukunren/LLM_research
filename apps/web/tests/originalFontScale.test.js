import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'postcss'

const readStyle = path => readFileSync(resolve(process.cwd(), 'src', path), 'utf8')
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fontSize = (path, selector) => {
  const styles = readStyle(path)
  const rules = [...styles.matchAll(new RegExp(`(?:^|\\n)\\s*${escape(selector)}\\s*\\{([^}]*)\\}`, 'g'))]
  const sizes = rules.flatMap(rule => [...rule[1].matchAll(/(?:^|;)\s*font-size:\s*([^;]+);/g)].map(match => match[1].trim()))
  if (!sizes.length) throw new Error(`Missing font-size: ${path} ${selector}`)
  return sizes.at(-1)
}

// Source-level guards complement the desktop layout checks in Edge.
describe('workbench typography scale', () => {
  it('keeps navigation and archived-history labels at their original sizes', () => {
    expect(fontSize('chat-layout.css', '.chat-nav-button')).toBe('13px')
    expect(fontSize('components/conversation-history.css', '.chat-history-archive-toggle')).toBe('11px')
  })

  it('uses the VI title and reading sizes with inherited research prose', () => {
    expect(readStyle('tokens.css')).toContain('--ui-page-title: 24px;')
    expect(readStyle('tokens.css')).toContain('--ui-reading-size: 15px;')
    expect(readStyle('tokens.css')).toContain('--ui-reading-leading: 26px;')
    expect(fontSize('research-chat.css', '.chat-page .chat-empty-heading h1')).toBe('var(--ui-page-title)')
    expect(fontSize('research-chat.css', '.chat-page .research-studio .research-answer')).toBe('var(--ui-reading-size)')
    expect(fontSize('research-chat.css', '.chat-page .research-studio .research-answer :is(p, li, blockquote)')).toBe('inherit')
    expect(fontSize('research-chat.css', '.chat-page .research-studio .conversation-message-meta')).toBe('12px')
    // The final title/prose declarations continue to own the scale on small
    // screens; later responsive rules only alter layout and control dimensions.
    const protectedSelectors = [
      '.chat-page .chat-empty-heading h1',
      '.chat-page .research-studio .research-answer',
      '.chat-page .research-studio .research-answer :is(p, li, blockquote)',
      '.chat-page .research-studio .conversation-message-meta',
    ]
    const responsiveFontOverrides = []
    parse(readStyle('research-chat.css')).walkRules(rule => {
      if (!protectedSelectors.includes(rule.selector.trim())) return
      let parent = rule.parent
      while (parent && !(parent.type === 'atrule' && parent.name === 'media')) parent = parent.parent
      if (parent) rule.walkDecls('font-size', declaration => responsiveFontOverrides.push(`${rule.selector}: ${declaration.value}`))
    })
    expect(responsiveFontOverrides).toEqual([])
  })

  it('retains the original research-shortcut title and secondary-text scale', () => {
    expect(fontSize('components/conversation/research-starters.css', '.research-start-option strong')).toBe('14px')
    expect(fontSize('components/conversation/research-starters.css', '.research-start-option small')).toBe('12px')
    expect(fontSize('components/conversation/screening-templates.css', '.screening-template-starter-label')).toBe('13px')
    expect(fontSize('components/conversation/screening-templates.css', '.screening-templates > p')).toBe('inherit')
  })

  it('keeps the current inline research-method controls at a compact readable scale', () => {
    const path = 'components/conversation/composer-attachments.css'
    expect(fontSize(path, '.composer-assistant-pill')).toBe('12px')
    expect(fontSize(path, '.composer-menu-label')).toBe('11px')
    expect(fontSize(path, '.composer-menu-back')).toBe('12px')
  })

  it('uses readable VI coverage and keeps compact run-history details', () => {
    const path = 'components/screening-result-list.css'
    expect(fontSize(path, '.screening-compact-table')).toBe('12px')
    expect(fontSize(path, '.screening-compact-table .stock-identity small, .screening-compact-table td > small')).toBe('10px')
    expect(fontSize(path, '.viewport-workspace .screening-list-compact .conversation-coverage-note')).toBe('var(--ui-meta-size)')
    for (const selector of ['.screening-list-toolbar > span', '.conversation-history-result .history-run-context', '.conversation-history-result .history-run-context .history-date-notice']) {
      expect(fontSize(path, selector)).toBe('11px')
    }
  })

  it('keeps the redesigned layout and touch targets independently of font scale', () => {
    expect(readStyle('components/conversation/screening-templates.css')).toContain('grid-template-columns:repeat(3,minmax(0,1fr))')
    expect(readStyle('components/conversation-history.css')).toContain('width: 44px; height: 44px; flex-basis: 44px;')
    expect(readStyle('components/screening-result-list.css')).toContain('min-height: 44px;')
  })
})
