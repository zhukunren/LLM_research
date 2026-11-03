import { expect, it } from 'vitest'
import { emptyImage, emptyTarget, referenceDerivation, restoreWorkspace, type Workspace } from './patternWorkspace'

function workspace(): Workspace { return { schemaVersion: 2, target: emptyTarget(), activeTool: null, market: { code: '600000.SH', start: '2026-09-01', end: '2026-09-30' }, image: emptyImage(), prompt: '保留输入', candidate: null, undo: null, panel: 'create' } }
it('round-trips a closed tool, separate inputs, pending candidate and complete undo snapshot', () => {
  const state = workspace()
  state.target = { ...state.target, activeId: 'saved-id', version: 5, name: '当前目标', note: '备注', minSimilarity: 88, matchMode: 'recent', recentBars: 12, rawPoints: [{ x: 0, y: .2 }, { x: 1, y: .8 }] }
  state.undo = { ...state.target, source: 'natural_language', sourceDraftId: 'draft-id' }
  state.candidate = { tool: 'screenshot', target: { ...emptyTarget(), source: 'screenshot', image: { ...emptyImage(), name: 'capture.png', data: 'aW1hZ2U=' } } }
  expect(restoreWorkspace(JSON.stringify(state))).toEqual(state)
})
it('migrates an old editor without preserving any cutoff or unrelated payload fields', () => {
  const target = emptyTarget(), image = emptyImage()
  const legacy = { ...target, asOf: '2025-01-01', panel: 'create', marketSelection: { code: '', start: '', end: '' }, imageData: image.data, savedImageUrl: image.url, imageMime: image.mime, imageName: image.name, crop: image.crop, unrelated: 'discard' }
  const restored = restoreWorkspace(JSON.stringify(legacy))!
  expect(restored.target).toEqual(target)
  expect(JSON.stringify(restored)).not.toContain('asOf')
  expect(JSON.stringify(restored)).not.toContain('2025-01-01')
  expect(JSON.stringify(restored)).not.toContain('unrelated')
})
it('rejects malformed nested values without crashing the editor', () => {
  expect(restoreWorkspace('{broken')).toBeNull()
  expect(restoreWorkspace(JSON.stringify({ ...workspace(), target: { ...emptyTarget(), rawPoints: [null] } }))).toBeNull()
  expect(restoreWorkspace(JSON.stringify({ ...workspace(), target: { ...emptyTarget(), candles: [null] } }))).toBeNull()
  expect(restoreWorkspace(JSON.stringify({ ...workspace(), image: { ...emptyImage(), url: 'https://foreign.example/image' } }))).toBeNull()
  expect(restoreWorkspace(JSON.stringify({ ...workspace(), candidate: { tool: 'screenshot', target: { ...emptyTarget(), image: null } }, undo: false }))).toMatchObject({ candidate: null, undo: null })
})
it('drops resolved provenance from the reference sent to the server', () => {
  expect(referenceDerivation({ origin_type: 'market_window', source_window_id: 'snapshot', market_source: { stock_code: 'untrusted' }, provenance: { prompt: 'untrusted' } })).toEqual({ origin_type: 'market_window', source_window_id: 'snapshot' })
  expect(referenceDerivation({ origin_type: 'screenshot', source_pattern_id: 'saved', source_pattern_version: 3, source_image: { filename: 'untrusted' } })).toEqual({ origin_type: 'screenshot', source_pattern_id: 'saved', source_pattern_version: 3 })
})
