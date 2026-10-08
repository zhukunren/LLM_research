import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const readStyle = (path) => readFileSync(resolve(process.cwd(), 'src', path), 'utf8')
const tokens = readStyle('tokens.css')
const minimalist = readStyle('minimalist-workspace.css')
const libraries = readStyle('library-minimal.css')
const chat = readStyle('chat-layout.css')
const screening = readStyle('components/conversation/screening-simple.css')

const token = (name) => {
  const value = tokens.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]
  if (!value) throw new Error(`Missing token ${name}`)
  return value.trim().toLowerCase()
}
const luminance = (hex) => {
  const channels = hex.slice(1).match(/../g).map(value => {
    const s = Number.parseInt(value, 16) / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
const contrast = (a, b) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('Soochow interaction palette', () => {
  it('uses site-derived blues without recoloring the quiet canvas or market semantics', () => {
    expect(token('ui-brand')).toBe('#00337a')
    expect(token('ui-primary')).toBe('#00337a')
    expect(token('ui-accent')).toBe('#0079c2')
    expect(token('ui-canvas')).toBe('#ffffff')
    expect(token('ui-surface')).toBe('#ffffff')
    expect(token('ui-sidebar')).toBe('#f8f8f8')
    expect(token('ui-market-up')).toBe('#be414a')
    expect(token('ui-market-down')).toBe('#208575')
    expect(token('ui-chart-line')).toBe('#32839b')
  })

  it('maintains readable primary labels, selected text and visible focus boundaries', () => {
    for (const state of ['ui-primary', 'ui-primary-hover', 'ui-primary-active']) {
      expect(contrast(token(state), token('ui-on-primary'))).toBeGreaterThanOrEqual(4.5)
    }
    for (const surface of ['ui-surface', 'ui-primary-soft', 'ui-sidebar-active']) {
      expect(contrast(token('ui-primary'), token(surface))).toBeGreaterThanOrEqual(4.5)
    }
    for (const surface of ['ui-surface', 'ui-surface-subtle', 'ui-sidebar']) {
      expect(contrast(token('ui-focus-outline'), token(surface))).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps final-layer selected, focus and pressed controls connected to brand tokens', () => {
    // Source-level cascade guards; browser QA still verifies computed styles.
    expect(minimalist).toMatch(/button\.active\s*\{[^}]*border-bottom-color: var\(--ui-primary\); color: var\(--ui-primary\)/)
    expect(minimalist).toMatch(/primary-button:active:not\(:disabled\)\s*\{[^}]*background: var\(--ui-primary-active\)/)
    expect(libraries).not.toMatch(/color:#242424/)
    expect(screening).toMatch(/button\.active\s*\{ color:var\(--ui-primary\)/)
    expect(screening).toMatch(/conversation-workspace-empty \.conversation-composer:focus-within\s*\{ border-color:var\(--ui-primary\)/)
    expect(libraries).toMatch(/button\.selected\s*\{[^}]*color:var\(--ui-primary\)/)
    expect(libraries).toMatch(/button\.selected strong\s*\{ color:var\(--ui-primary\)/)
    expect(libraries).toMatch(/:focus-within\s*\{ border-color:var\(--ui-primary\)/)
    expect(chat).toMatch(/conversation-workspace-empty \.conversation-composer:focus-within\s*\{ border-color: var\(--ui-primary\)/)
    expect(chat).toMatch(/chat-new\[aria-current=page\]\s*\{[^}]*color: var\(--ui-brand\)/)
  })
})
