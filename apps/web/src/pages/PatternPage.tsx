import LoadingState from '../components/LoadingState'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import EmptyState from '../components/EmptyState'
import { StockText } from '../components/StockMentions'
import { localStorage, sessionStorage } from '../authStorage'
import { PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ChartNoAxesCombined, ImageUp, RefreshCw, Library, Maximize2, MessageCircle, Minimize2, PencilLine, Plus, Save, Search, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react'
import { api, type Pattern, type PatternMarketSource } from '../api'
import { appendCombination } from '../libraryContext'
import { ResponsiveMarketIndicatorChart as MarketIndicatorChart } from '../components/MarketIndicatorChart'
import { navigateTabs, trapDialogTab } from '../keyboard'
import SearchField from '../components/SearchField'
import StockSearch, { StockName } from '../components/StockSearch'
import PatternComparison, { MiniCandles, PatternMarketChart, type PatternMatch } from './PatternComparison'
import '../pattern-matches.css'
import './pattern-editor-layout.css'
import './pattern-studio.css'
import './pattern-comparison.css'

type Point = { x: number; y: number }
type Candle = { open: number; high: number; low: number; close: number }
type Extraction = { points: number[]; target_bars: number; quality: { confidence: number; horizontal_coverage: number; requires_manual_review: boolean; limitations: string[] } }
type ShapeDraft = { id: string; prompt: string; status: string; name: string; points: number[]; target_bars: number; min_similarity: number; assumptions: string[]; issues: string[]; description: string }
type PatternSource = Pattern['input_type']
type MarketSelection = { code: string; start: string; end: string }
type EditorSnapshot = { activeId: string; version: number; name: string; mode: 'price_path' | 'ohlc_sequence'; source: PatternSource; marketSource?: PatternMarketSource | null; marketSelection?: MarketSelection; panel: 'browse' | 'create' | 'saved'; draft: ShapeDraft | null; sourceDraftId: string; minSimilarity: number; matchMode: 'current' | 'recent'; recentBars: number; dirty: boolean; targetBars: number; rawPoints: Point[]; candles: Candle[]; selectedCandle: number; imageData: string; savedImageUrl: string; imageMime: 'image/png' | 'image/jpeg' | 'image/webp'; imageName: string; crop: { x: number; y: number; width: number; height: number }; quality: Extraction['quality'] | null }
function validMarketSource(value: PatternMarketSource): boolean {
  return !!value && ['snapshot_id', 'stock_code', 'requested_start_date', 'requested_end_date', 'start_date', 'end_date', 'price_basis', 'created_at'].every(key => typeof value[key as keyof PatternMarketSource] === 'string')
    && Array.isArray(value.bars) && value.bars.length >= 10 && value.bars.length <= 250
    && value.bars.every(bar => typeof bar.trade_date === 'string' && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
}
function validShapeDraft(value: unknown): value is ShapeDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as ShapeDraft
  return ['id', 'prompt', 'name', 'status', 'description'].every(key => typeof (draft as unknown as Record<string, unknown>)[key] === 'string')
    && Array.isArray(draft.points) && draft.points.every(Number.isFinite) && Number.isInteger(draft.target_bars) && draft.target_bars >= 10 && draft.target_bars <= 250
    && Number.isFinite(draft.min_similarity) && Array.isArray(draft.assumptions) && draft.assumptions.every(value => typeof value === 'string') && Array.isArray(draft.issues) && draft.issues.every(value => typeof value === 'string')
}
function readEditor(): EditorSnapshot | null {
  try {
    const value = JSON.parse(sessionStorage.getItem('pattern.editor') || 'null') as EditorSnapshot | null
    if (!value || !['price_path', 'ohlc_sequence'].includes(value.mode) || !['drawing', 'screenshot', 'natural_language', 'market_window'].includes(value.source) || !['browse', 'create', 'saved'].includes(value.panel)) return null
    if (value.marketSource && !validMarketSource(value.marketSource)) return null
    if (value.marketSelection && ![value.marketSelection.code, value.marketSelection.start, value.marketSelection.end].every(item => typeof item === 'string')) return null
    if (!['activeId', 'name', 'sourceDraftId', 'imageData', 'savedImageUrl', 'imageName'].every(key => typeof (value as unknown as Record<string, unknown>)[key] === 'string')) return null
    if (!Number.isInteger(value.version) || value.version < 0 || !Number.isInteger(value.targetBars) || value.targetBars < (value.mode === 'ohlc_sequence' && value.source === 'drawing' ? 1 : 10) || value.targetBars > 250 || !Number.isFinite(value.minSimilarity) || !['current', 'recent'].includes(value.matchMode) || !Number.isInteger(value.recentBars) || typeof value.dirty !== 'boolean') return null
    if (!Array.isArray(value.rawPoints) || value.rawPoints.length > 10000 || !value.rawPoints.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return null
    if (!Array.isArray(value.candles) || value.candles.length > 250 || !value.candles.every(candle => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))) return null
    if (!Number.isInteger(value.selectedCandle) || !['image/png', 'image/jpeg', 'image/webp'].includes(value.imageMime) || !value.crop || !Object.values(value.crop).every(Number.isFinite) || (value.draft && !validShapeDraft(value.draft))) return null
    return value
  } catch { return null }
}

export default function PatternPage({ onCompose, onDiscuss }: { onCompose?: () => void; onDiscuss?: (id: string, version: number, name: string) => void }) {
  const [restored] = useState(readEditor)
  const [drawingFocused, setDrawingFocused] = useState(false)
  const focusButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!drawingFocused) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    focusButton.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [drawingFocused])
  const [items, setItems] = useState<Pattern[]>([])
  const [query, setQuery] = useState('')
  const [representation, setRepresentation] = useState('')
  const [visibleCount, setVisibleCount] = useState(6)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  useEffect(() => setVisibleCount(6), [query, representation])
  const [activeId, setActiveId] = useState(restored?.activeId || '')
  const [version, setVersion] = useState(restored?.version || 0)
  const [name, setName] = useState(restored?.name || '新形态')
  const [mode, setMode] = useState<'price_path' | 'ohlc_sequence'>(restored?.mode || 'ohlc_sequence')
  const [source, setSource] = useState<PatternSource>(restored?.source || 'market_window')
  const [marketSource, setMarketSource] = useState<PatternMarketSource | null>(restored?.marketSource || null)
  const [marketSelection, setMarketSelection] = useState<MarketSelection>(restored?.marketSelection || { code: '', start: '', end: '' })
  const marketRequest = useRef(0)
  const [panel, setPanel] = useState<'browse' | 'create' | 'saved'>(restored?.panel === 'saved' ? 'saved' : 'create')
  useEffect(() => { if (panel !== 'create') setDrawingFocused(false) }, [panel])
  const [prompt, setPrompt] = useState(() => { try { return localStorage.getItem('library.pattern.prompt') ?? '' } catch { return '' } })
  const [draft, setDraft] = useState<ShapeDraft | null>(restored?.draft || null)
  const [sourceDraftId, setSourceDraftId] = useState(restored?.sourceDraftId || '')
  const [minSimilarity, setMinSimilarity] = useState(restored?.minSimilarity ?? 80)
  const [matchMode, setMatchMode] = useState<'current' | 'recent'>(restored?.matchMode || 'current')
  const [recentBars, setRecentBars] = useState(restored?.recentBars ?? 20)
  const [dirty, setDirty] = useState(restored?.dirty || false)
  const [targetBars, setTargetBars] = useState(restored?.targetBars ?? 40)
  const [rawPoints, setRawPoints] = useState<Point[]>(restored?.rawPoints || [])
  const [candles, setCandles] = useState<Candle[]>(restored?.candles || [])
  const [selectedCandle, setSelectedCandle] = useState(restored?.selectedCandle || 0)
  const [imageData, setImageData] = useState(restored?.imageData || '')
  const [savedImageUrl, setSavedImageUrl] = useState(restored?.savedImageUrl || '')
  const [imageMime, setImageMime] = useState<'image/png' | 'image/jpeg' | 'image/webp'>(restored?.imageMime || 'image/png')
  const [imageName, setImageName] = useState(restored?.imageName || '')
  const [crop, setCrop] = useState(restored?.crop || { x: 0, y: 0, width: 100, height: 100 })
  const [quality, setQuality] = useState<Extraction['quality'] | null>(restored?.quality || null)
  const [recentDescriptions, setRecentDescriptions] = useState<string[]>(() => { try { const value = JSON.parse(localStorage.getItem('library.pattern.recent') ?? '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [] } catch { return [] } })
  const [notice, setNotice] = useState('')
  const [noticeArea, setNoticeArea] = useState<'source' | 'footer'>('source')
  const [busy, setBusy] = useState(false)
  const [inputMatch, setInputMatch] = useState<PatternMatch | null>(null)
  const [selectedMatchKey, setSelectedMatchKey] = useState('')
  const [matchLoading, setMatchLoading] = useState(false)
  const [matchError, setMatchError] = useState('')
  const [savedPreview, setSavedPreview] = useState<{ id: string; version: number } | null>(restored?.activeId && !restored.dirty ? { id: restored.activeId, version: restored.version } : null)
  const matchRequest = useRef(0)
  const pointerRef = useRef(false)

  const refresh = async () => {
    setCatalogLoading(true); setCatalogError('')
    try { const result = await api<{ items: Pattern[] }>('/patterns'); setItems(result.items) }
    catch (error) { setCatalogError((error as Error).message) }
    finally { setCatalogLoading(false) }
  }
  useEffect(() => { refresh(); if (!restored) { try { const raw = JSON.parse(localStorage.getItem('library.pattern.draft') || 'null'); if (validShapeDraft(raw)) acceptDraft(raw) } catch { /* Invalid saved data must not break the editor. */ } } }, [])
  useEffect(() => { try { localStorage.setItem('library.pattern.prompt', prompt) } catch { /* Storage failure should not block drafting. */ } }, [prompt])

  const pointValues = useMemo(() => source === 'market_window' ? marketSource?.bars.map(bar => bar.close) ?? [] : resample(rawPoints, targetBars), [source, marketSource, rawPoints, targetBars])
  const selected = candles[selectedCandle]
  const filteredItems = items.filter(item => (!representation || item.representation === representation) && item.name.toLowerCase().includes(query.trim().toLowerCase()))
  function clearPatternFilters() { setQuery(''); setRepresentation('') }
  const geometry = JSON.stringify([source, marketSource?.snapshot_id, mode, targetBars, pointValues, candles])
  const geometryRef = useRef(geometry)
  const editorRef = useRef<EditorSnapshot | null>(null)
  editorRef.current = { activeId, version, name, mode, source, marketSource, marketSelection, panel, draft, sourceDraftId, minSimilarity, matchMode, recentBars, dirty, targetBars, rawPoints, candles, selectedCandle, imageData, savedImageUrl, imageMime, imageName, crop, quality }
  useEffect(() => {
    const save = () => { try { sessionStorage.setItem('pattern.editor', JSON.stringify(editorRef.current)) } catch { /* Editing and explicit template saving remain available. */ } }
    const timer = setTimeout(save, 300)
    return () => clearTimeout(timer)
  }, [activeId, version, name, mode, source, marketSource, marketSelection, panel, draft, sourceDraftId, minSimilarity, matchMode, recentBars, dirty, targetBars, rawPoints, candles, selectedCandle, imageData, savedImageUrl, imageMime, imageName, crop, quality])
  useEffect(() => {
    const save = () => { try { sessionStorage.setItem('pattern.editor', JSON.stringify(editorRef.current)) } catch { /* Explicit saved templates are independent of browser storage. */ } }
    window.addEventListener('pagehide', save)
    return () => { window.removeEventListener('pagehide', save); save() }
  }, [])
  geometryRef.current = geometry
  useEffect(() => { matchRequest.current += 1; setInputMatch(null); setSelectedMatchKey(''); setMatchError(''); setMatchLoading(false) }, [geometry])
  useEffect(() => {
    if (!savedPreview) return
    const request = ++matchRequest.current
    let active = true
    const requestedGeometry = geometryRef.current
    setMatchLoading(true); setMatchError('')
    requestPatternExamples(savedPreview.id, savedPreview.version, true).then(result => {
      if (active && request === matchRequest.current && requestedGeometry === geometryRef.current) setInputMatch(result)
    }).catch(error => { if (active && request === matchRequest.current) setMatchError((error as Error).message) })
      .finally(() => { if (active && request === matchRequest.current) setMatchLoading(false) })
    return () => { active = false }
  }, [savedPreview])
  useEffect(() => () => { marketRequest.current += 1 }, [])

  function changeMarketSelection(next: MarketSelection) {
    marketRequest.current += 1
    setMarketSelection(next); setMarketSource(null); setCandles([]); setRawPoints([]); setInputMatch(null); setDirty(true); setNotice('')
  }

  function chooseMarketSource() {
    marketRequest.current += 1
    if (source !== 'market_window') { setMarketSource(null); setCandles([]); setRawPoints([]) }
    setSource('market_window'); setMode('ohlc_sequence')
    setDraft(null); setSourceDraftId(''); setImageData(''); setSavedImageUrl(''); setQuality(null); setNotice(''); setDirty(true)
  }

  async function loadMarketWindow() {
    setNoticeArea('source')
    if (!marketSelection.code || !marketSelection.start || !marketSelection.end) { setNotice('请选择股票并填写起止日期'); return }
    if (marketSelection.start > marketSelection.end) { setNotice('开始日期不能晚于结束日期'); return }
    const request = ++marketRequest.current
    setBusy(true); setNotice(''); setInputMatch(null)
    try {
      const result = await api<PatternMarketSource>('/patterns/market-window', { method: 'POST', body: JSON.stringify({ stock_code: marketSelection.code, start_date: marketSelection.start, end_date: marketSelection.end }) })
      if (request !== marketRequest.current) return
      if (!validMarketSource(result)) throw new Error('返回的行情区间无效，请重新载入')
      setMarketSource(result); setSource('market_window'); setTargetBars(result.bars.length)
      setCandles(result.bars.map(({ open, high, low, close }) => ({ open, high, low, close }))); setRawPoints([])
      setName(`${result.stock_code} ${result.start_date} 至 ${result.end_date}`); setDirty(true)
      setNotice(`已载入 ${result.bars.length} 根真实日线，可保存模板或匹配相似 K 线。`)
    } catch (error) { if (request === marketRequest.current) setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  function reset() {
    marketRequest.current += 1; setMarketSource(null); setMarketSelection({ code: '', start: '', end: '' }); setInputMatch(null)
    setDrawingFocused(false); setSavedPreview(null)
    setActiveId(''); setVersion(0); setName('新形态'); setMode('ohlc_sequence'); setSource('market_window'); setTargetBars(40)
    setRawPoints([]); setCandles([]); setSelectedCandle(0); setImageData(''); setSavedImageUrl(''); setQuality(null); setNotice('')
    setDraft(null); setSourceDraftId(''); setMinSimilarity(80); setMatchMode('current'); setRecentBars(20); setDirty(false); setPanel('create')
    localStorage.removeItem('library.pattern.draft')
  }

  function acceptDraft(result: ShapeDraft) {
    marketRequest.current += 1; setMarketSource(null)
    setDraft(result); setActiveId(''); setVersion(0); setSource('natural_language'); setSourceDraftId(result.status === 'ready' ? result.id : '')
    setName(result.name); setMode('price_path'); setTargetBars(result.target_bars); setMinSimilarity(result.min_similarity); setMatchMode('current'); setRecentBars(20)
    setRawPoints(result.points.map((y, i) => ({ x: i / Math.max(1, result.points.length - 1), y })))
    setImageData(''); setSavedImageUrl(''); setQuality(null); setCandles([]); setDirty(true); setPanel('create')
  }

  async function describePattern() {
    setNoticeArea('source')
    setBusy(true); setNotice('')
    try {
      const result = await api<ShapeDraft>('/patterns/draft', { method: 'POST', body: JSON.stringify({ prompt }) })
      acceptDraft(result); localStorage.setItem('library.pattern.draft', JSON.stringify(result))
      const recent = [prompt, ...recentDescriptions.filter(text => text !== prompt)].slice(0, 8)
      setRecentDescriptions(recent); localStorage.setItem('library.pattern.recent', JSON.stringify(recent))
    } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) }
  }

  function usePattern(item?: Pattern) {
    const id = item?.id ?? activeId, savedVersion = item?.version ?? version
    if (!id) return
    appendCombination({ op: 'pattern_ref', pattern_id: id, version: savedVersion, min_similarity: Number(item?.params.min_similarity ?? minSimilarity), match_mode: item ? (item.params.match_mode === 'recent' ? 'recent' : 'current') : matchMode, recent_bars: Number(item?.params.recent_bars ?? recentBars), score_weight: 1 })
    onCompose?.()
  }

  function addCandle() {
    setDirty(true)
    const previous = candles.at(-1)?.close ?? 100
    const next = [...candles, { open: previous, high: previous + 1, low: Math.max(0.01, previous - 1), close: previous }]
    setCandles(next); setMode('ohlc_sequence'); setTargetBars(next.length); setSelectedCandle(next.length - 1); setSource('drawing')
  }

  function changeCandle(field: keyof Candle, value: number) {
    setDirty(true)
    if (!selected) return
    const next = [...candles]
    const updated = { ...selected, [field]: value }
    if (field === 'open' || field === 'close') {
      updated.high = Math.max(updated.high, updated.open, updated.close)
      updated.low = Math.min(updated.low, updated.open, updated.close)
    } else if (field === 'high') updated.high = Math.max(value, updated.open, updated.close)
    else updated.low = Math.min(value, updated.open, updated.close)
    next[selectedCandle] = updated
    setCandles(next)
  }

  function pointerPoint(event: PointerEvent<SVGSVGElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height)) }
  }
  function startDraw(event: PointerEvent<SVGSVGElement>) {
    if (mode !== 'price_path' || busy || source === 'market_window') return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = true
    setDirty(true)
    setSource('drawing'); setSourceDraftId(''); setDraft(null)
    setRawPoints([pointerPoint(event)])
    setQuality(null)
  }
  function continueDraw(event: PointerEvent<SVGSVGElement>) {
    if (!pointerRef.current) return
    const point = pointerPoint(event)
    setRawPoints((previous) => {
      const last = previous.at(-1)
      if (last && point.x - last.x < 0.002) return previous
      return [...previous, point]
    })
  }
  function stopDraw() { pointerRef.current = false }

  async function selectImage(file?: File) {
    if (!file) return
    setNoticeArea('source')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setNotice('请选择 PNG、JPEG 或 WebP 图片'); return }
    if (file.size > 10 * 1024 * 1024) { setNotice('图片不能超过 10 MB'); return }
    setBusy(true); setNotice('')
    try {
      const dataUrl = await readDataUrl(file)
      marketRequest.current += 1; setMarketSource(null)
      setImageData(dataUrl.split(',')[1] ?? '')
      setSavedImageUrl('')
      setImageMime(file.type as typeof imageMime)
      setImageName(file.name)
      setSource('screenshot'); setMode('price_path'); setQuality(null)
      setDirty(true); setSourceDraftId('')
      setNotice('截图已载入。')
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  async function extract() {
    setNoticeArea('source')
    let sourceData = imageData
    if (!sourceData && savedImageUrl) {
      try {
        const response = await fetch(savedImageUrl)
        if (!response.ok) { setNotice('无法读取模板来源截图'); return }
        const blob = await response.blob()
        sourceData = (await readDataUrl(new File([blob], imageName || 'pattern-image', { type: blob.type }))).split(',')[1] ?? ''
        setImageData(sourceData)
      } catch { setNotice('无法读取模板来源截图'); return }
    }
    if (!sourceData) { setNotice('先选择一张走势图截图'); return }
    setBusy(true); setNotice('')
    try {
      const result = await api<Extraction>('/patterns/extract', {
        method: 'POST', body: JSON.stringify({ filename: imageName, mime_type: imageMime, image_base64: sourceData,
          crop: { x: crop.x / 100, y: crop.y / 100, width: crop.width / 100, height: crop.height / 100 } }),
      })
      setRawPoints(result.points.map((y, index) => ({ x: index / Math.max(1, result.points.length - 1), y })))
      setTargetBars(result.target_bars); setQuality(result.quality); setSource('screenshot')
      setNotice(result.quality.requires_manual_review ? '已提取候选走势，请检查并校正曲线。' : '已提取走势候选，请确认裁剪和路径。')
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  function load(item: Pattern) {
    marketRequest.current += 1; setMarketSource(item.market_source ?? null); setInputMatch(null)
    if (item.market_source) setMarketSelection({ code: item.market_source.stock_code, start: item.market_source.requested_start_date, end: item.market_source.requested_end_date })
    setSavedPreview({ id: item.id, version: item.version })
    setActiveId(item.id); setVersion(item.version); setName(item.name); setMode(item.representation); setSource(item.input_type)
    setSourceDraftId(item.provenance?.draft_id ?? ''); setMinSimilarity(Number(item.params.min_similarity ?? 80)); setMatchMode(item.params.match_mode === 'recent' ? 'recent' : 'current'); setRecentBars(Number(item.params.recent_bars ?? 20)); setDraft(null); setDirty(false); setPanel('create')
    if (item.provenance?.prompt) setPrompt(item.provenance.prompt)
    setTargetBars(item.target_bars); setCandles(item.candlesticks ?? []); setRawPoints(item.points.map((y, index) => ({ x: index / Math.max(1, item.points.length - 1), y })))
    setImageData('')
    setSavedImageUrl(item.source_image ? `/api/v1/patterns/${item.id}/source-image?version=${item.version}` : '')
    if (item.source_image) { setImageMime(item.source_image.mime_type); setImageName(item.source_image.filename) }
    setSelectedCandle(0); setQuality(null); setNotice('')
  }

  async function save() {
    setNoticeArea('footer')
    if (mode === 'price_path' && pointValues.length < 10) { setNotice('先手绘至少两个点，或上传截图完成走势提取'); return }
    if (mode === 'ohlc_sequence' && candles.length < 10) { setNotice('蜡烛模板至少需要 10 根已编辑 OHLC'); return }
    if (mode === 'ohlc_sequence' && candles.length !== targetBars) { setNotice('当前蜡烛数与目标交易日数不一致'); return }
    setBusy(true); setNotice('')
    try {
      const saved = await api<Pattern>('/patterns', { method: 'POST', body: JSON.stringify({
        id: activeId || undefined, name, input_type: source, representation: mode, target_bars: mode === 'ohlc_sequence' ? candles.length : targetBars,
        source_draft_id: sourceDraftId || undefined,
        source_window_id: source === 'market_window' ? marketSource?.snapshot_id : undefined,
        points: mode === 'ohlc_sequence' ? candles.map((item) => item.close) : pointValues,
        candlesticks: mode === 'ohlc_sequence' ? candles : [], params: { min_similarity: minSimilarity, match_mode: matchMode, recent_bars: recentBars, screenshot_quality: quality },
        source_image_base64: source === 'screenshot' && imageData ? imageData : undefined,
        source_image_mime: source === 'screenshot' && imageData ? imageMime : undefined,
        source_image_filename: source === 'screenshot' ? imageName : undefined,
      }) })
      setActiveId(saved.id); setVersion(saved.version); await refresh(); setNotice(`已保存 ${saved.name} v${saved.version}`)
      setDirty(false); localStorage.removeItem('library.pattern.draft')
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  const svgPoints = rawPoints.map((point) => `${point.x * 900},${(1 - point.y) * 280}`).join(' ')
  async function matchInput() {
    const request = ++matchRequest.current
    setBusy(true); setMatchLoading(true); setMatchError(''); setNotice(''); setInputMatch(null)
    const requestedGeometry = geometryRef.current
    try {
      const result = await api<PatternMatch>('/patterns/match?limit=12', { method: 'POST', body: JSON.stringify({ name, input_type: source, source_window_id: source === 'market_window' ? marketSource?.snapshot_id : undefined, representation: mode, target_bars: targetBars, points: mode === 'ohlc_sequence' ? candles.map(item => item.close) : pointValues, candlesticks: mode === 'ohlc_sequence' ? candles : [] }) })
      if (request === matchRequest.current && geometryRef.current === requestedGeometry) setInputMatch(result)
    } catch (error) { if (request === matchRequest.current) setMatchError((error as Error).message) } finally { setBusy(false); if (request === matchRequest.current) setMatchLoading(false) }
  }
  const selectedValue = (field: keyof Candle) => selected?.[field] ?? 0
  function chooseSource(next: PatternSource) {
    if (source === next) return
    if (next === 'market_window') { chooseMarketSource(); return }
    marketRequest.current += 1
    setMarketSource(null); setSource(next); setMode('price_path'); setSourceDraftId(''); setDraft(null)
    setRawPoints([]); setCandles([]); setQuality(null); setNotice(''); setDirty(true)
  }
  function retryMatch() {
    if (activeId && !dirty) {
      exampleRequests.delete(`${activeId}@${version}@similar`)
      setSavedPreview({ id: activeId, version })
    } else void matchInput()
  }
  const canMatch = !(source === 'market_window' && !marketSource) && (mode === 'price_path' ? pointValues.length >= 10 : candles.length >= 10)
  const screeningSettings = <details className="pattern-workbench-settings" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
    <summary><SlidersHorizontal size={14} />选股设置</summary>
    <div className="pattern-settings-popover">
      <label className="field workspace-field-label"><span>最低相似度</span><input aria-label="最低相似度" type="number" min={0} max={100} step={1} value={minSimilarity} onChange={event => { setMinSimilarity(Number(event.target.value)); setDirty(true) }} className="workspace-field" /></label>
      <label className="field workspace-field-label"><span>选股匹配窗口</span><select aria-label="形态匹配窗口" value={matchMode} onChange={event => { setMatchMode(event.target.value as 'current' | 'recent'); setDirty(true) }} className="workspace-field workspace-select"><option value="current">当前窗口</option><option value="recent">近期最相近窗口</option></select></label>
      {matchMode === 'recent' && <label className="field workspace-field-label"><span>近期回看（根）</span><input aria-label="近期回看交易日数" type="number" min={1} max={120} value={recentBars} onChange={event => { setRecentBars(Number(event.target.value)); setDirty(true) }} className="workspace-field" /></label>}
      <p>设置随模板保存，在组合选股时生效。</p>
    </div>
  </details>
  const targetChart = <section className={'pattern-comparison-target' + (drawingFocused ? ' pattern-comparison-target-focused' : '')} aria-label={drawingFocused ? '专注绘图' : '目标形态'} role={drawingFocused ? 'dialog' : 'region'} aria-modal={drawingFocused ? true : undefined} onKeyDown={event => {
    if (!drawingFocused) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDrawingFocused(false) }
    else trapDialogTab(event)
  }}>
    <header className="pattern-comparison-chart-heading">
      <div><h2>目标形态</h2><span>{source === 'market_window' && marketSource ? <><StockName code={marketSource.stock_code} /> · {marketSource.bars.length} 根 · {marketSource.price_basis === 'unadjusted' ? '未复权日线' : marketSource.price_basis}</> : `${name} · ${targetBars} 个交易日`}</span></div>
      <div className="pattern-target-actions">
        <label className="pattern-target-duration workspace-field-label"><span>交易日数</span><input aria-label="目标交易日数" type="number" min={10} max={250} value={targetBars} disabled={busy || mode === 'ohlc_sequence' || source === 'market_window'} onChange={event => { setTargetBars(Number(event.target.value)); setDirty(true) }} className="workspace-field" /></label>
        <div className="segmented"><button aria-pressed={mode === 'price_path'} disabled={busy} className={'workspace-button' + (mode === 'price_path' ? ' selected' : '')} onClick={() => { setMode('price_path'); setDirty(true) }}>走势曲线</button><button aria-pressed={mode === 'ohlc_sequence'} disabled={busy} className={'workspace-button' + (mode === 'ohlc_sequence' ? ' selected' : '')} onClick={() => { setMode('ohlc_sequence'); if (source !== 'market_window') { setSource('drawing'); setSourceDraftId('') }; setDirty(true) }}>蜡烛图</button></div>
        <button ref={focusButton} type="button" className="text-button workspace-button" aria-pressed={drawingFocused} aria-label={drawingFocused ? '退出专注绘图' : '专注绘图'} data-tooltip={drawingFocused ? '退出专注绘图' : '专注绘图'} onClick={() => setDrawingFocused(value => !value)}>{drawingFocused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      </div>
    </header>
    <div className="pattern-comparison-chart-content">
      {source === 'market_window' ? <div className="pattern-market-preview" aria-label="来源 K 线预览">{marketSource ? <PatternMarketChart bars={marketSource.bars} closePath={mode === 'price_path'} /> : <div className="pattern-comparison-placeholder"><ChartNoAxesCombined size={24} /><p>选择股票与区间，载入目标 K 线。</p></div>}</div> : <div className={'pattern-target-drawing' + (mode === 'price_path' ? ' draw-enabled' : '')}>
        <svg role="img" viewBox="0 0 900 280" preserveAspectRatio="none" aria-label={mode === 'price_path' ? '走势曲线编辑区' : '蜡烛形态预览'} onPointerDown={startDraw} onPointerMove={continueDraw} onPointerUp={stopDraw} onPointerCancel={stopDraw}>
          {[0, 1, 2, 3, 4].map(line => <line key={`h${line}`} x1="0" x2="900" y1={line * 70} y2={line * 70} className="chart-grid" />)}
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(line => <line key={`v${line}`} x1={line * 112.5} x2={line * 112.5} y1="0" y2="280" className="chart-grid vertical" />)}
          {mode === 'price_path' ? rawPoints.length > 1 && <polyline points={svgPoints} className={source === 'screenshot' ? 'price-line extracted-line' : 'price-line'} /> : <CandleSvg candles={candles} onSelect={setSelectedCandle} />}
          {mode === 'price_path' && rawPoints.length < 2 && <text x="450" y="144" textAnchor="middle" className="chart-placeholder">{source === 'drawing' ? '从左向右拖动，绘制目标走势' : source === 'screenshot' ? '上传截图后提取走势' : '输入文字并生成形态草稿'}</text>}
        </svg>
        <div className="chart-axis"><span>第 1 日</span><span>{targetBars} 个交易日</span><span>第 {targetBars} 日</span></div>
      </div>}
    </div>
    {source === 'market_window' && marketSource && <p className="pattern-comparison-dates">{marketSource.start_date} — {marketSource.end_date} · 行情快照已保留</p>}
    {source === 'drawing' && mode === 'price_path' && <div className="pattern-target-edit-tools"><span>从左向右拖动绘图</span><button className="text-button workspace-button" disabled={busy} onClick={() => { setRawPoints([]); setQuality(null); setDirty(true) }}><Trash2 size={13} />清除走势</button></div>}
    {source !== 'market_window' && mode === 'ohlc_sequence' && <details className="pattern-candle-controls"><summary>编辑蜡烛 · {candles.length} 根</summary><div className="candle-strip">{candles.map((candle, index) => <button key={index} className={'workspace-button candle-chip' + (selectedCandle === index ? ' active' : '') + (candle.close >= candle.open ? ' up' : ' down')} onClick={() => setSelectedCandle(index)} aria-label={`选择第 ${index + 1} 根蜡烛`} aria-pressed={selectedCandle === index}><i /><small>{index + 1}</small></button>)}</div>{selected && <div className="form-grid four-col candle-fields">{(['open', 'high', 'low', 'close'] as const).map(field => <label className="field workspace-field-label" key={field}><span>{field.toUpperCase()}</span><input type="number" step="0.01" value={selectedValue(field)} onChange={event => changeCandle(field, Number(event.target.value))} className="workspace-field" /></label>)}</div>}<button className="secondary-button workspace-button" disabled={busy || candles.length >= 250} onClick={addCandle}><Plus size={13} />添加蜡烛</button></details>}
  </section>
  return (
    <StockText><div className="page-content workspace-tool-page library-shell library-redesign pattern-library pattern-studio pattern-comparison-studio" data-panel={panel}>
      <WorkspacePageHeading actionsClassName="library-heading-actions" actions={<button className="secondary-button workspace-button" onClick={reset} disabled={busy}><Plus size={15} />新建形态</button>}><h1>形态库</h1><p className="page-description">目标形态与真实样本，同屏对照。</p></WorkspacePageHeading>
      <div className="pattern-studio-navigation"><nav className="library-tabs" role="tablist" aria-label="形态库功能" onKeyDown={event => navigateTabs(event, ['create', 'saved'] as const, panel === 'saved' ? 'saved' : 'create', setPanel)}><button role="tab" id="pattern-create-tab" aria-controls="pattern-content" aria-selected={panel !== 'saved'} tabIndex={panel !== 'saved' ? 0 : -1} className={'workspace-button' + (panel !== 'saved' ? ' active' : '')} onClick={() => setPanel('create')}><ChartNoAxesCombined size={16} />形态匹配</button><button role="tab" id="pattern-saved-tab" aria-controls="pattern-content" aria-selected={panel === 'saved'} tabIndex={panel === 'saved' ? 0 : -1} className={'workspace-button' + (panel === 'saved' ? ' active' : '')} onClick={() => setPanel('saved')}><Library size={16} />我的形态</button></nav><span className="pattern-studio-nav-note">{activeId ? `v${version} · ${dirty ? '有未保存修改' : '已保存'}` : '选择来源，匹配相似 K 线'}</span></div>
      <section id="pattern-content" role="tabpanel" aria-labelledby={`pattern-${panel === 'saved' ? 'saved' : 'create'}-tab`}>
      {panel === 'saved' ? <>
        <div className="workspace-filter-bar pattern-filter-bar workspace-filters"><SearchField label="搜索形态" placeholder="搜索形态名称" value={query} onChange={setQuery} /><select aria-label="形态类型筛选" value={representation} onChange={event => setRepresentation(event.target.value)} className="workspace-field workspace-select"><option value="">全部形态类型</option><option value="price_path">走势曲线</option><option value="ohlc_sequence">蜡烛图</option></select><span className="workspace-result-count">{filteredItems.length} / {items.length} 个形态</span>{(query || representation) && <button className="text-button workspace-button" onClick={clearPatternFilters}>重置形态筛选</button>}</div>
        {catalogLoading ? <LoadingState compact label="正在加载形态…" /> : catalogError ? <div className="workspace-error" role="alert">{catalogError}<button className="text-button workspace-button" onClick={() => void refresh()}>重新加载形态</button></div> : !filteredItems.length ? <EmptyState icon={Search} titleAs="h3" title={items.length ? '没有找到匹配的形态' : '暂无形态'} description="保存的目标形态会显示在这里，可随时载入对照。" actions={<button className="secondary-button workspace-button" onClick={items.length ? clearPatternFilters : reset}>{items.length ? '查看全部形态' : '创建形态'}</button>} /> : <div className="shape-gallery">{filteredItems.slice(0, visibleCount).map(item => <article className="saved-condition-card" key={item.id}><div className="pattern-gallery-meta"><span>{item.representation === 'ohlc_sequence' ? '蜡烛图' : '走势曲线'}</span><span>v{item.version}</span></div><div className="condition-card-title"><h3>{item.name}</h3><span className="condition-category">{item.target_bars} 个交易日</span></div><PatternExample key={item.id + '@' + item.version} item={item} allowCurve compact />{item.market_source && <p className="pattern-source-caption">来源 {item.market_source.stock_code} · {item.market_source.start_date} 至 {item.market_source.end_date}</p>}<div className="card-actions"><button className="secondary-button workspace-button" onClick={() => load(item)}><PencilLine size={14} />载入对照</button><button className="text-button workspace-button" onClick={() => usePattern(item)}>加入组合<ArrowRight size={14} /></button></div></article>)}{visibleCount < filteredItems.length && <div className="gallery-more"><button className="secondary-button workspace-button" onClick={() => setVisibleCount(value => value + 6)}>显示更多形态（还有 {filteredItems.length - visibleCount} 个）</button></div>}</div>}
      </> : <div className="pattern-workbench">
        <div className="pattern-source-controls" role="region" aria-label="形态来源设置">
          <div className="pattern-source-toolbar"><div className="pattern-source-methods" role="group" aria-label="形态来源">{([{ value: 'market_window', label: '行情区间', Icon: ChartNoAxesCombined }, { value: 'drawing', label: '手绘', Icon: PencilLine }, { value: 'screenshot', label: '截图', Icon: ImageUp }, { value: 'natural_language', label: '文字', Icon: Sparkles }] as const).map(({ value, label, Icon }) => <button type="button" className={'workspace-button' + (source === value ? ' selected' : '')} aria-pressed={source === value} disabled={busy} key={value} onClick={() => chooseSource(value)}><Icon size={14} />{label}</button>)}</div>
          </div>
          {source === 'market_window' && <section className="pattern-market-fields" aria-label="行情区间来源"><div className="field"><span>来源股票</span><StockSearch value={marketSelection.code} onChange={code => changeMarketSelection({ ...marketSelection, code })} onSelectionPending={() => changeMarketSelection({ ...marketSelection, code: '' })} disabled={busy} label="来源股票" /></div><label className="field workspace-field-label"><span>开始日期</span><input type="date" value={marketSelection.start} disabled={busy} onChange={event => changeMarketSelection({ ...marketSelection, start: event.target.value })} className="workspace-field" /></label><label className="field workspace-field-label"><span>结束日期</span><input type="date" value={marketSelection.end} disabled={busy} onChange={event => changeMarketSelection({ ...marketSelection, end: event.target.value })} className="workspace-field" /></label><button className="secondary-button workspace-button" disabled={busy || !marketSelection.code || !marketSelection.start || !marketSelection.end} onClick={loadMarketWindow}>载入 K 线</button></section>}
          {source === 'drawing' && <p className="pattern-source-hint">直接在目标图中手绘走势，或切换蜡烛图逐根编辑。</p>}
          {source === 'screenshot' && <div className="pattern-screenshot-input"><label className="upload-label secondary-button workspace-button"><ImageUp size={14} />上传截图<input type="file" disabled={busy} accept="image/png,image/jpeg,image/webp" onChange={event => selectImage(event.target.files?.[0])} /></label><span>{imageName || 'PNG、JPEG 或 WebP，最大 10 MB'}</span><button className="secondary-button workspace-button" disabled={busy || (!imageData && !savedImageUrl)} onClick={extract}>提取走势候选</button><details className="pattern-crop-details"><summary>裁剪与来源</summary><div className="pattern-crop-popover">{(imageData || savedImageUrl) && <img src={imageData ? `data:${imageMime};base64,${imageData}` : savedImageUrl} alt="待识别行情图截图" />}<span>主图裁剪范围（百分比）</span><div className="crop-controls">{([{ key: 'x', label: '左', min: 0, max: 95 }, { key: 'y', label: '上', min: 0, max: 95 }, { key: 'width', label: '宽', min: 5, max: 100 }, { key: 'height', label: '高', min: 5, max: 100 }] as const).map(item => <label className="workspace-field-label" key={item.key}>{item.label}<input type="number" min={item.min} max={item.max} value={crop[item.key]} onChange={event => setCrop({ ...crop, [item.key]: Number(event.target.value) })} className="workspace-field" /></label>)}</div>{quality && <p>候选置信度 {Math.round(quality.confidence * 100)}% · 横向覆盖 {Math.round(quality.horizontal_coverage * 100)}%{quality.requires_manual_review ? ' · 请检查路径' : ''}{quality.limitations.join('；')}</p>}</div></details></div>}
          {source === 'natural_language' && <div className="pattern-language-input"><textarea aria-label="形态需求描述" rows={2} placeholder="例如：20 个交易日内先下跌后回升，形成 V 形反转" value={prompt} disabled={busy} maxLength={2000} onChange={event => setPrompt(event.target.value)} className="workspace-field" /><button className="secondary-button workspace-button" disabled={busy || !prompt.trim()} onClick={describePattern}><Sparkles size={14} />生成形态草稿</button><details className="pattern-description-examples"><summary>最近描述与示例</summary><div>{(recentDescriptions.length ? recentDescriptions : ['20 个交易日内先下跌后回升，形成 V 形反转', '30 个交易日内形成双底，第二个低点略高', '40 个交易日内先横盘整理，再向上突破']).map(text => <button className="text-button workspace-button" key={text} disabled={busy} onClick={() => setPrompt(text)}>{text}</button>)}{sourceDraftId && <p>原始描述：{draft?.prompt ?? prompt} · 草稿 {sourceDraftId}</p>}</div></details>{draft?.issues.map(issue => <p className="workspace-feedback-warning" key={issue}>{issue}</p>)}</div>}
          {notice && noticeArea === 'source' && <p className="pattern-source-feedback" role="status">{notice}</p>}
        </div>
        <PatternComparison target={targetChart} matchAction={<button className="primary-button workspace-button" disabled={busy || !canMatch} onClick={matchInput}><Search size={14} />{matchLoading && busy ? '匹配中…' : '匹配相似形态'}</button>} result={inputMatch} loading={matchLoading} error={matchError} selectedKey={selectedMatchKey} onSelect={setSelectedMatchKey} onRetry={retryMatch} />
        <footer className="pattern-workbench-footer">
          <label className="pattern-template-name workspace-field-label"><span>模板名称</span><input value={name} onChange={event => { setName(event.target.value); setDirty(true) }} className="workspace-field" /></label>
          {screeningSettings}
          <button className="text-button workspace-button" disabled={busy || !canMatch || (!dirty && !!activeId)} onClick={save}><Save size={14} />保存模板</button>
          {onDiscuss && activeId && <button className="text-button workspace-button" disabled={dirty} onClick={() => onDiscuss(activeId, version, name)}><MessageCircle size={14} />研究此形态</button>}
          <button className="secondary-button workspace-button" disabled={busy || !activeId || dirty} onClick={() => usePattern()}>用于组合<ArrowRight size={14} /></button>
          <span className="pattern-workbench-status" role={notice && noticeArea === 'footer' ? 'status' : undefined}>{notice && noticeArea === 'footer' ? notice : dirty && activeId ? '有未保存修改，保存后可用于组合。' : activeId ? `已保存 v${version}` : source === 'market_window' && !marketSource ? '选择含 10–250 根日线的区间' : '保存后可在“我的形态”中复用'}</span>
        </footer>
      </div>}
      </section>
    </div></StockText>
  )
}

const exampleRequests = new Map<string, { expires: number; request: Promise<PatternMatch> }>()
function requestPatternExamples(id: string, version: number, similar = false) {
  const key = `${id}@${version}${similar ? '@similar' : ''}`
  if (!exampleRequests.has(key) || exampleRequests.get(key)!.expires < Date.now()) {
    if (exampleRequests.size >= 80) exampleRequests.delete(exampleRequests.keys().next().value!)
    const request = api<PatternMatch>(`/patterns/${id}/best-match?version=${version}${similar ? '&limit=12' : ''}`).catch(error => { exampleRequests.delete(key); throw error })
    exampleRequests.set(key, { expires: Date.now() + 5 * 60000, request })
  }
  return exampleRequests.get(key)!.request
}
function PatternExample({ item, allowCurve = false, showSimilar = false, compact = false }: { item: Pattern; allowCurve?: boolean; showSimilar?: boolean; compact?: boolean }) {
  const [curve, setCurve] = useState(false)
  const [result, setResult] = useState<PatternMatch | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const key = item.id + '@' + item.version + (showSimilar ? '@similar' : '')
  useEffect(() => {
    let active = true
    setResult(null); setError(''); setSelectedIndex(0)
    if (!exampleRequests.has(key) || exampleRequests.get(key)!.expires < Date.now()) {
      if (exampleRequests.size >= 80) exampleRequests.delete(exampleRequests.keys().next().value!)
      const request = api<PatternMatch>('/patterns/' + item.id + '/best-match?version=' + item.version + (showSimilar ? '&limit=12' : '')).catch(error => { exampleRequests.delete(key); throw error })
      exampleRequests.set(key, { expires: Date.now() + 5 * 60000, request })
    }
    exampleRequests.get(key)!.request.then(value => { if (active) setResult(value) }).catch(error => { if (active) setError(error.message) })
    return () => { active = false }
  }, [item.id, item.version, retry, showSimilar, key])
  const matches = result?.items?.length ? result.items : result?.bars.length ? [result] : []
  const selectedMatch = matches[selectedIndex] || matches[0]
  return <StockText><div className={'pattern-example' + (showSimilar ? ' pattern-match-browser' : '')}>
    {allowCurve && <div className="pattern-chart-toolbar">{showSimilar && <span><ChartNoAxesCombined size={14} />{curve ? '原始目标走势' : '真实行情对照'}</span>}<div className="pattern-chart-tools"><div className="segmented"><button aria-pressed={!curve} className={["workspace-button", !curve ? 'selected' : ''].filter(Boolean).join(' ')} onClick={() => setCurve(false)}>K线</button><button aria-pressed={curve} className={["workspace-button", curve ? 'selected' : ''].filter(Boolean).join(' ')} onClick={() => setCurve(true)}>原始曲线</button></div>{!curve && result && <button className="text-button pattern-refresh workspace-button" aria-label="刷新形态匹配" onClick={() => { exampleRequests.delete(key); setRetry(value => value + 1) }}><RefreshCw size={13} /><span>刷新匹配</span></button>}</div></div>}
    <div className="pattern-match-layout">
    <div className="pattern-match-preview">
    {curve ? <><svg className="pattern-original-curve" viewBox="0 0 600 160" role="img" aria-label={item.name + '原始曲线'}>{[40, 80, 120].map(y => <line key={y} x1="10" x2="590" y1={y} y2={y} className="pattern-thumbnail-grid" />)}<polyline points={galleryPoints(item.points)} fill="none" stroke="var(--ui-chart-line)" strokeWidth="2.5" /></svg><p className="pattern-example-caption">目标走势 · {item.target_bars} 个交易日 · 已保存 v{item.version}</p></> : error ? <p role="alert" className="workspace-error">{error}<button className="text-button workspace-button" onClick={() => setRetry(value => value + 1)}>重试</button></p> : !result ? <LoadingState label="正在寻找相似的真实 K 线…" skeleton /> : selectedMatch ? <>
      {showSimilar && <div className="pattern-selected-company"><div className="pattern-selected-identity">{selectedMatch.stock_code && <StockName code={selectedMatch.stock_code} />}<span className="pattern-selected-dates">{selectedMatch.start_date} — {selectedMatch.end_date}</span></div><span className="pattern-selected-score"><small>形态相似度</small><span><strong>{selectedMatch.similarity?.toFixed(1)}</strong><small> 分</small></span></span></div>}
      <MarketIndicatorChart chart={{ bars: selectedMatch.bars, placement: 'overlay', lines: [], histogram: null, reference_lines: [] }} height={showSimilar ? 220 : compact ? 150 : undefined} showLegend={false} />
      <p className="pattern-example-caption">{selectedMatch.stock_code} · {selectedMatch.start_date} 至 {selectedMatch.end_date} · 形态相似度 {selectedMatch.similarity?.toFixed(1)} 分</p>
    </> : <p className="workbench-help">{result.reason}</p>}
    </div>
      {showSimilar && matches.length > 0 && <section className="pattern-similar-section" aria-label="相似K线样本">
        <div className="pattern-similar-heading"><h3>相似样本 <span>{matches.length}</span></h3><span>点击对照行情</span></div>

        <div className="pattern-similar-grid">{matches.map((match, index) => <button type="button" data-stock-ignore key={match.stock_code + '@' + match.start_date} className={["workspace-button", 'pattern-similar-card' + (selectedIndex === index ? ' selected' : '')].filter(Boolean).join(' ')} aria-pressed={selectedIndex === index} aria-label={`查看 ${match.stock_code} 相似K线，相似度 ${match.similarity?.toFixed(1)} 分`} onClick={() => { setSelectedIndex(index); setCurve(false) }}>
          <span className="pattern-similar-card-heading"><span className="pattern-match-rank">{String(index + 1).padStart(2, '0')}</span>{match.stock_code && <StockName code={match.stock_code} interactive={false} />}<span className="pattern-match-score">{match.similarity?.toFixed(1)}<small>分</small></span></span>
          <MiniCandles bars={match.bars} />
          <span className="pattern-similar-dates">{match.start_date} — {match.end_date}</span>
        </button>)}</div>
        {matches.length === 1 && <p className="workbench-help">本地行情暂时只有一个可用样本。</p>}
      </section>}
    </div>
    {result && showSimilar && <div className="pattern-match-footnote">{result.as_of && <span>行情截至 {result.as_of}</span>}{result.scope && <details className="pattern-match-scope"><summary>匹配范围与口径</summary><p>{result.scope}</p></details>}</div>}
    {result?.scope && !showSimilar && <details className="pattern-match-scope"><summary>匹配范围与口径</summary><p>{result.scope}</p></details>}
  </div></StockText>
}

function galleryPoints(points: number[]) {
  const low = Math.min(...points), span = Math.max(...points) - low || 1
  return comparisonPoints(points.map(value => (value - low) / span))
}

function comparisonPoints(points: number[]) {
  return points.map((value, index) => `${10 + index * 580 / Math.max(1, points.length - 1)},${150 - value * 140}`).join(' ')
}

function CandleSvg({ candles, onSelect }: { candles: Candle[]; onSelect: (index: number) => void }) {
  if (!candles.length) return <text x="450" y="144" textAnchor="middle" className="chart-placeholder">暂无蜡烛</text>
  const all = candles.flatMap((item) => [item.high, item.low])
  const min = Math.min(...all); const max = Math.max(...all); const span = max - min || 1
  const width = 900 / candles.length
  return <g>{candles.map((item, index) => {
    const center = index * width + width / 2
    const y = (value: number) => 270 - ((value - min) / span) * 260
    const top = Math.min(y(item.open), y(item.close)); const bodyHeight = Math.max(2, Math.abs(y(item.open) - y(item.close)))
    return <g key={index} onPointerDown={(event) => { event.stopPropagation(); onSelect(index) }} className="candle-mark">
      <line x1={center} x2={center} y1={y(item.high)} y2={y(item.low)} className={item.close >= item.open ? 'candle-wick up' : 'candle-wick down'} />
      <rect x={center - Math.max(2, width * 0.26)} y={top} width={Math.max(4, width * 0.52)} height={bodyHeight} className={item.close >= item.open ? 'candle-body up' : 'candle-body down'} />
    </g>
  })}</g>
}

function resample(points: Point[], count: number): number[] {
  if (points.length < 2) return []
  const sorted = [...points].sort((a, b) => a.x - b.x)
  const output: number[] = []
  for (let index = 0; index < count; index += 1) {
    const x = index / (count - 1)
    const right = sorted.findIndex((point) => point.x >= x)
    if (right < 0) output.push(sorted[sorted.length - 1].y)
    else if (right === 0) output.push(sorted[0].y)
    else {
      const left = sorted[right - 1]; const next = sorted[right]
      const ratio = (x - left.x) / Math.max(1e-8, next.x - left.x)
      output.push(left.y + (next.y - left.y) * ratio)
    }
  }
  return output
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片'))
    reader.onerror = () => reject(new Error('无法读取图片'))
    reader.readAsDataURL(file)
  })
}
