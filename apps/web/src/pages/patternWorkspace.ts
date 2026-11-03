import type { Pattern, PatternMarketSource } from '../api'

export type Point = { x: number; y: number }
export type Candle = { open: number; high: number; low: number; close: number }
export type PatternSource = Pattern['input_type']
export type ShapeDraft = { id: string; prompt: string; status: string; name: string; points: number[]; target_bars: number; min_similarity: number; assumptions: string[]; issues: string[]; description: string }
export type Quality = { confidence: number; horizontal_coverage: number; requires_manual_review: boolean; limitations: string[] }
export type Extraction = { points: number[]; target_bars: number; quality: Quality }
export type MarketSelection = { code: string; start: string; end: string }
export type ImageInput = { data: string; url: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; name: string; crop: { x: number; y: number; width: number; height: number } }
// Only references are sent back to the API. Resolved provenance is display data, never authority.
export type Derivation = { origin_type: PatternSource; source_window_id?: string; source_draft_id?: string; source_pattern_id?: string; source_pattern_version?: number }
export type OriginMarket = Pick<PatternMarketSource, 'stock_code' | 'start_date' | 'end_date' | 'price_basis'>
export type Target = {
  activeId: string; version: number; name: string; note: string; mode: Pattern['representation']; source: PatternSource
  marketSource: PatternMarketSource | null; draft: ShapeDraft | null; sourceDraftId: string; sourcePrompt?: string; originMarket?: OriginMarket | null; derivation: Derivation | null
  sourceImagePattern: { id: string; version: number } | null
  minSimilarity: number; matchMode: 'current' | 'recent'; recentBars: number; dirty: boolean; targetBars: number
  rawPoints: Point[]; candles: Candle[]; selectedCandle: number; image: ImageInput; quality: Quality | null
}
export type Candidate = { target: Target; tool: Exclude<PatternSource, 'drawing'> }
export type Workspace = { schemaVersion: 2; target: Target; activeTool: PatternSource | null; market: MarketSelection; image: ImageInput; prompt: string; candidate: Candidate | null; undo: Target | null; panel: 'create' | 'saved' }
export const sourceLabels: Record<PatternSource, string> = { market_window: '行情区间', drawing: '手绘', screenshot: '截图', natural_language: '文字' }
export const emptyImage = (): ImageInput => ({ data: '', url: '', mime: 'image/png', name: '', crop: { x: 0, y: 0, width: 100, height: 100 } })
export const emptyTarget = (): Target => ({ activeId: '', version: 0, name: '新形态', note: '', mode: 'price_path', source: 'drawing', marketSource: null, draft: null, sourceDraftId: '', sourcePrompt: '', originMarket: null, derivation: null, sourceImagePattern: null, minSimilarity: 80, matchMode: 'current', recentBars: 20, dirty: false, targetBars: 40, rawPoints: [], candles: [], selectedCandle: 0, image: emptyImage(), quality: null })
const sources = ['drawing', 'screenshot', 'natural_language', 'market_window']
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const integer = (value: unknown, min: number, max: number) => Number.isInteger(value) && Number(value) >= min && Number(value) <= max
const validCandles = (value: unknown): value is Candle[] => Array.isArray(value) && value.length <= 250 && value.every(candle => record(candle) && [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
export function validMarketSource(value: unknown): value is PatternMarketSource {
  return record(value) && ['snapshot_id', 'stock_code', 'requested_start_date', 'requested_end_date', 'start_date', 'end_date', 'price_basis', 'created_at'].every(key => text(value[key]))
    && validCandles(value.bars) && value.bars.length >= 10 && value.bars.every(bar => text((bar as Candle & { trade_date?: string }).trade_date))
}
export function validShapeDraft(value: unknown): value is ShapeDraft {
  return record(value) && ['id', 'prompt', 'name', 'status', 'description'].every(key => text(value[key]))
    && Array.isArray(value.points) && value.points.length <= 10000 && value.points.every(Number.isFinite) && integer(value.target_bars, 10, 250)
    && Number.isFinite(value.min_similarity) && Array.isArray(value.assumptions) && value.assumptions.every(text) && Array.isArray(value.issues) && value.issues.every(text)
}
function validQuality(value: unknown): value is Quality {
  return record(value) && Number.isFinite(value.confidence) && Number.isFinite(value.horizontal_coverage) && typeof value.requires_manual_review === 'boolean' && Array.isArray(value.limitations) && value.limitations.every(text)
}
export function validExtraction(value: unknown): value is Extraction {
  return record(value) && Array.isArray(value.points) && value.points.length >= 2 && value.points.length <= 10000 && value.points.every(Number.isFinite) && integer(value.target_bars, 10, 250) && validQuality(value.quality)
}
function validImage(value: unknown): value is ImageInput {
  return record(value) && text(value.data) && value.data.length <= 14 * 1024 * 1024 && text(value.url) && (!value.url || /^\/api\/v1\/patterns\/[^/?#]+\/source-image\?version=\d+$/.test(value.url))
    && ['image/png', 'image/jpeg', 'image/webp'].includes(String(value.mime)) && text(value.name) && record(value.crop) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite((value.crop as Record<string, unknown>)[key]) && Number((value.crop as Record<string, unknown>)[key]) >= 0 && Number((value.crop as Record<string, unknown>)[key]) <= 100)
}
export function referenceDerivation(value: unknown): Derivation | null {
  if (!record(value) || !sources.includes(String(value.origin_type))) return null
  const result: Derivation = { origin_type: value.origin_type as PatternSource }
  if (value.source_window_id !== undefined) {
    if (!text(value.source_window_id) || !value.source_window_id || result.origin_type !== 'market_window') return null
    result.source_window_id = value.source_window_id
  }
  if (value.source_draft_id !== undefined) {
    if (!text(value.source_draft_id) || !value.source_draft_id || result.origin_type !== 'natural_language') return null
    result.source_draft_id = value.source_draft_id
  }
  if (value.source_pattern_id !== undefined || value.source_pattern_version !== undefined) {
    if (!text(value.source_pattern_id) || !value.source_pattern_id || !integer(value.source_pattern_version, 1, Number.MAX_SAFE_INTEGER)) return null
    result.source_pattern_id = value.source_pattern_id; result.source_pattern_version = Number(value.source_pattern_version)
  }
  const routes = [result.source_window_id, result.source_draft_id, result.source_pattern_id].filter(Boolean).length
  return routes > 1 || !routes && result.origin_type !== 'screenshot' ? null : result
}
export function validTarget(value: unknown): value is Target {
  if (!record(value) || !['activeId', 'name', 'note', 'sourceDraftId'].every(key => text(value[key])) || value.sourcePrompt !== undefined && !text(value.sourcePrompt)) return false
  return ['price_path', 'ohlc_sequence'].includes(String(value.mode)) && sources.includes(String(value.source))
    && integer(value.version, 0, Number.MAX_SAFE_INTEGER) && integer(value.targetBars, value.mode === 'ohlc_sequence' && value.source === 'drawing' ? 0 : 10, 250)
    && Number.isFinite(value.minSimilarity) && Number(value.minSimilarity) >= 0 && Number(value.minSimilarity) <= 100 && ['current', 'recent'].includes(String(value.matchMode)) && integer(value.recentBars, 1, 120) && typeof value.dirty === 'boolean'
    && Array.isArray(value.rawPoints) && value.rawPoints.length <= 10000 && value.rawPoints.every(point => record(point) && Number.isFinite(point.x) && Number.isFinite(point.y))
    && validCandles(value.candles) && integer(value.selectedCandle, 0, 249) && validImage(value.image)
    && (value.originMarket == null || record(value.originMarket) && ['stock_code', 'start_date', 'end_date', 'price_basis'].every(key => text((value.originMarket as Record<string, unknown>)[key])))
    && (value.quality === null || validQuality(value.quality)) && (value.draft === null || validShapeDraft(value.draft))
    && (value.marketSource === null || validMarketSource(value.marketSource))
    && (value.derivation === null || !!referenceDerivation(value.derivation))
    && (value.sourceImagePattern === null || record(value.sourceImagePattern) && text(value.sourceImagePattern.id) && integer(value.sourceImagePattern.version, 1, Number.MAX_SAFE_INTEGER))
}
const validMarketSelection = (value: unknown): value is MarketSelection => record(value) && [value.code, value.start, value.end].every(text)
export function restoreWorkspace(raw: string | null): Workspace | null {
  try {
    const value: unknown = JSON.parse(raw || 'null')
    if (!record(value)) return null
    if (value.schemaVersion === 2) {
      if (!validTarget(value.target) || !(value.activeTool === null || sources.includes(String(value.activeTool))) || !validMarketSelection(value.market) || !validImage(value.image) || !text(value.prompt) || !['create', 'saved'].includes(String(value.panel))) return null
      const candidate = record(value.candidate) && ['market_window', 'screenshot', 'natural_language'].includes(String(value.candidate.tool)) && validTarget(value.candidate.target) ? value.candidate as Candidate : null
      return { schemaVersion: 2, target: { ...value.target, derivation: referenceDerivation(value.target.derivation) }, activeTool: value.activeTool as PatternSource | null, market: value.market, image: value.image, prompt: value.prompt, candidate, undo: validTarget(value.undo) ? value.undo : null, panel: value.panel as Workspace['panel'] }
    }
    // Legacy session migration deliberately drops asOf. New searches always use latest data.
    const image = { data: value.imageData ?? '', url: value.savedImageUrl ?? '', mime: value.imageMime ?? 'image/png', name: value.imageName ?? '', crop: value.crop ?? emptyImage().crop }
    const target: Record<string, unknown> = { ...emptyTarget() }
    for (const key of Object.keys(target)) if (key in value) target[key] = value[key]
    Object.assign(target, { note: value.note ?? '', marketSource: value.marketSource ?? null, image, derivation: null, sourceImagePattern: value.savedImageUrl && value.activeId ? { id: value.activeId, version: value.version } : null, quality: value.quality ?? null })
    if (!validTarget(target)) return null
    return { schemaVersion: 2, target, activeTool: target.source, market: validMarketSelection(value.marketSelection) ? value.marketSelection : { code: '', start: '', end: '' }, image: target.image, prompt: validShapeDraft(value.draft) ? value.draft.prompt : '', candidate: null, undo: null, panel: value.panel === 'saved' ? 'saved' : 'create' }
  } catch { return null }
}
