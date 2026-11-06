import LoadingState from '../components/LoadingState'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import EmptyState from '../components/EmptyState'
import { StockText } from '../components/StockMentions'
import { localStorage, sessionStorage } from '../authStorage'
import { PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ChartNoAxesCombined, ImageUp, RefreshCw, Library, Maximize2, MessageCircle, Minimize2, PencilLine, Plus, Save, Search, SlidersHorizontal, Sparkles, Undo2, X } from 'lucide-react'
import { api, type Pattern, type PatternMarketSource } from '../api'
import { appendCombination } from '../libraryContext'
import { ResponsiveMarketIndicatorChart as MarketIndicatorChart } from '../components/MarketIndicatorChart'
import { navigateTabs, trapDialogTab } from '../keyboard'
import SearchField from '../components/SearchField'
import StockSearch, { StockName } from '../components/StockSearch'
import PatternComparison, { MiniCandles, PatternMarketChart, type PatternMatch } from './PatternComparison'
import PatternResearchRecords from './PatternResearchRecords'
import PatternInputMenu, { patternInputActions } from './PatternInputMenu'
import { emptyImage, emptyTarget, referenceDerivation, restoreWorkspace, sourceLabels, validExtraction, validMarketSource, validShapeDraft, type Candidate, type Candle, type Derivation, type Extraction, type ImageInput, type MarketSelection, type PatternSource, type Point, type ShapeDraft, type Target, type Workspace } from './patternWorkspace'
import './PatternResearch.css'
import '../pattern-matches.css'
import './pattern-studio.css'
import './pattern-comparison.css'
import './pattern-editor-layout.css'

function readEditor() { try { return restoreWorkspace(sessionStorage.getItem('pattern.editor')) } catch { return null } }
function readPrompt() { try { return localStorage.getItem('library.pattern.prompt') || '' } catch { return '' } }
function marketOrigin(value?: PatternMarketSource | null) { return value ? { stock_code: value.stock_code, start_date: value.start_date, end_date: value.end_date, price_basis: value.price_basis } : null }
function pointsFrom(values: number[]): Point[] { return values.map((y, index) => ({ x: index / Math.max(1, values.length - 1), y })) }
function plotPoints(points: Point[]): string {
  if (!points.length) return ''
  const low = Math.min(...points.map(point => point.y)), high = Math.max(...points.map(point => point.y))
  const normalize = low < 0 || high > 1
  return points.map(point => `${point.x * 900},${(1 - (normalize ? (point.y - low) / (high - low || 1) : point.y)) * 280}`).join(' ')
}

export default function PatternPage({ onCompose, onDiscuss, screeningMode = false, onScreeningHistory }: { onCompose?: () => void; onDiscuss?: (id: string, version: number, name: string) => void; screeningMode?: boolean; onScreeningHistory?: () => void }) {
  const [restored] = useState(readEditor)
  const [target, setTarget] = useState<Target>(() => restored?.target ?? emptyTarget())
  const { activeId, version, name, note, mode, source, marketSource, draft, sourceDraftId, minSimilarity, matchMode, recentBars, dirty, targetBars, rawPoints, candles, selectedCandle, quality } = target
  const [activeTool, setActiveTool] = useState<PatternSource | null>(restored ? restored.activeTool : null)
  const [marketSelection, setMarketSelection] = useState<MarketSelection>(restored?.market ?? { code: '', start: '', end: '' })
  const [imageTool, setImageTool] = useState<ImageInput>(() => restored?.image ?? emptyImage())
  const [prompt, setPrompt] = useState(restored?.prompt || readPrompt())
  const [candidate, setCandidate] = useState<Candidate | null>(restored?.candidate ?? null)
  const [undo, setUndo] = useState<Target | null>(restored?.undo ?? null)
  const [panel, setPanel] = useState<'create' | 'saved'>(restored?.panel ?? 'create')
  const [drawingFocused, setDrawingFocused] = useState(false)
  const inputMenuButton = useRef<HTMLButtonElement>(null)
  const candidateApplyButton = useRef<HTMLButtonElement>(null)
  const starterButtons = useRef<Partial<Record<PatternSource, HTMLButtonElement | null>>>({})
  const returnFocus = useRef<PatternSource | 'target' | null>(null)
  const [returnFocusRequest, setReturnFocusRequest] = useState(0)
  const inputPanel = useRef<HTMLElement>(null)
  const drawingCanvas = useRef<SVGSVGElement>(null)
  const [toolFocusRequest, setToolFocusRequest] = useState(0)
  const focusButton = useRef<HTMLButtonElement>(null)
  const [items, setItems] = useState<Pattern[]>([])
  const [query, setQuery] = useState('')
  const [representation, setRepresentation] = useState('')
  const [visibleCount, setVisibleCount] = useState(6)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [versions, setVersions] = useState<Pattern[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const [selectionError, setSelectionError] = useState('')
  const [recentDescriptions, setRecentDescriptions] = useState<string[]>(() => { try { const value = JSON.parse(localStorage.getItem('library.pattern.recent') ?? '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [] } catch { return [] } })
  const [notice, setNotice] = useState('')
  const [noticeArea, setNoticeArea] = useState<'source' | 'footer'>('source')
  const [toolBusy, setToolBusy] = useState<PatternSource | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [inputMatch, setInputMatch] = useState<PatternMatch | null>(null)
  const [selectedMatchKey, setSelectedMatchKey] = useState('')
  const [matchLoading, setMatchLoading] = useState(false)
  const [matchBusy, setMatchBusy] = useState(false)
  const [matchError, setMatchError] = useState('')
  const [savedPreview, setSavedPreview] = useState<{ id: string; version: number } | null>(restored?.target.activeId && !restored.target.dirty ? { id: restored.target.activeId, version: restored.target.version } : null)
  const requestEpoch = useRef(0)
  const matchRequest = useRef(0)
  const historyRequest = useRef(0)
  const catalogRequest = useRef(0)
  const selectionRequest = useRef(0)
  const selectionQueue = useRef<Promise<unknown>>(Promise.resolve())
  const mounted = useRef(true)
  const pointerRef = useRef(false)
  const editorRef = useRef<Workspace | null>(null)
  editorRef.current = { schemaVersion: 2, target, activeTool, market: marketSelection, image: imageTool, prompt, candidate, undo, panel }
  const pointValues = useMemo(() => source === 'market_window' ? marketSource?.bars.map(bar => bar.close) ?? [] : resample(rawPoints, targetBars), [source, marketSource, rawPoints, targetBars])
  const selected = candles[selectedCandle]
  const filteredItems = items.filter(item => (!representation || item.representation === representation) && item.name.toLowerCase().includes(query.trim().toLowerCase()))
  const geometry = JSON.stringify([source, sourceDraftId, target.derivation, marketSource?.snapshot_id, mode, targetBars, pointValues, candles])
  const geometryRef = useRef(geometry)
  geometryRef.current = geometry
  const canMatch = !(source === 'market_window' && !marketSource) && (mode === 'price_path' ? pointValues.length >= 10 : candles.length >= 10 && candles.length === targetBars)
  const hasTarget = source === 'market_window' ? !!marketSource : rawPoints.length > 1 || candles.length > 0
  const editable = source === 'drawing' && activeTool === 'drawing' && !saving
  const showCanvas = hasTarget || activeTool === 'drawing'
  const showStarters = !hasTarget && !activeTool && !candidate
  const workspaceState = hasTarget ? 'target' : activeTool || candidate ? 'input' : 'empty'

  useEffect(() => {
    if (!returnFocusRequest || !returnFocus.current) return
    const destination = inputMenuButton.current ?? candidateApplyButton.current ?? (returnFocus.current === 'target' ? null : starterButtons.current[returnFocus.current]) ?? starterButtons.current.market_window ?? (editable ? drawingCanvas.current : null)
    destination?.focus()
    returnFocus.current = null
  }, [returnFocusRequest])
  useEffect(() => {
    if (!toolFocusRequest || !activeTool) return
    if (activeTool === 'drawing' && source === 'drawing') drawingCanvas.current?.focus()
    else {
      const selector = activeTool === 'natural_language' ? 'textarea' : activeTool === 'market_window' ? (marketSelection.code ? 'input[type=date]' : 'input[role=combobox]') : '[data-input-focus]'
      const firstControl = inputPanel.current?.querySelector<HTMLElement>(selector) ?? inputPanel.current?.querySelector<HTMLElement>('button')
      firstControl?.focus()
    }
  }, [toolFocusRequest, activeTool, source])
  useEffect(() => setVisibleCount(6), [query, representation])
  useEffect(() => { if (panel !== 'create') setDrawingFocused(false) }, [panel])
  useEffect(() => {
    if (!drawingFocused) return
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; focusButton.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [drawingFocused])
  useEffect(() => {
    mounted.current = true
    void refresh()
    if (!restored) {
      try { const value: unknown = JSON.parse(localStorage.getItem('library.pattern.draft') || 'null'); if (validShapeDraft(value) && value.status === 'ready' && value.points.length >= 2) setCandidate(textCandidate(value)) } catch { /* Invalid legacy drafts do not block the workspace. */ }
    }
    return () => { mounted.current = false; requestEpoch.current++; matchRequest.current++; historyRequest.current++; catalogRequest.current++; selectionRequest.current++; pointerRef.current = false }
  }, [])
  useEffect(() => { try { localStorage.setItem('library.pattern.prompt', prompt) } catch { /* Optional browser persistence. */ } }, [prompt])
  useEffect(() => { const timer = setTimeout(persistEditor, 300); return () => clearTimeout(timer) }, [target, activeTool, marketSelection, imageTool, prompt, candidate, undo, panel])
  useEffect(() => { window.addEventListener('pagehide', persistEditor); return () => { window.removeEventListener('pagehide', persistEditor); persistEditor() } }, [])
  useEffect(() => { matchRequest.current++; selectionRequest.current++; setSelectionError(''); setInputMatch(null); setSelectedMatchKey(''); setMatchError(''); setMatchLoading(false); setMatchBusy(false) }, [geometry])
  useEffect(() => {
    // A restored editing session must not grow a result sidebar during the next stroke.
    if (!savedPreview || dirty || activeTool === 'drawing' && source === 'drawing') return
    const request = ++matchRequest.current, requestedGeometry = geometryRef.current
    let active = true
    setMatchLoading(true); setMatchError('')
    requestPatternExamples(savedPreview.id, savedPreview.version, true).then(result => {
      if (active && request === matchRequest.current && requestedGeometry === geometryRef.current) setInputMatch(result)
    }).catch(error => { if (active && request === matchRequest.current) setMatchError((error as Error).message) })
      .finally(() => { if (active && request === matchRequest.current) setMatchLoading(false) })
    return () => { active = false }
  }, [savedPreview])

  function persistEditor() { try { sessionStorage.setItem('pattern.editor', JSON.stringify(editorRef.current)) } catch { /* Explicit saving remains available if browser quota is full. */ } }
  function cancelRequest() { requestEpoch.current++; setToolBusy(null); pointerRef.current = false }
  function currentRequest(epoch: number) { return mounted.current && epoch === requestEpoch.current && !savingRef.current }
  function beginRequest(tool: PatternSource) { const epoch = ++requestEpoch.current; setToolBusy(tool); setNoticeArea('source'); setNotice(''); return epoch }
  function finishRequest(epoch: number) { if (currentRequest(epoch)) setToolBusy(null) }
  function invalidateTarget() { cancelRequest(); matchRequest.current++; selectionRequest.current++; setSelectionError(''); setMatchLoading(false); setMatchBusy(false); setSavedPreview(null) }
  function editTarget(patch: Partial<Target>) { if (savingRef.current) return; invalidateTarget(); setTarget(previous => ({ ...previous, ...patch, dirty: true })) }
  function editTool(tool: PatternSource, change: () => void) { if (savingRef.current) return; cancelRequest(); setCandidate(previous => previous?.tool === tool ? null : previous); setNotice(''); change() }
  function chooseTool(tool: PatternSource | null) {
    if (savingRef.current) return
    cancelRequest(); setActiveTool(tool); setNotice('')
    if (tool) {
      // Remove result columns before editing begins, never halfway through a pointer stroke.
      if (tool === 'drawing' && (source === 'drawing' || !hasTarget)) { invalidateTarget(); setInputMatch(null); setSelectedMatchKey(''); setMatchError('') }
      // A restored empty source has no geometry to convert; explicitly choosing drawing starts its canvas.
      if (tool === 'drawing' && !hasTarget && source !== 'drawing') setTarget(previous => ({ ...previous, source: 'drawing', mode: 'price_path' }))
      setToolFocusRequest(value => value + 1)
    } else {
      if (!hasTarget) setDrawingFocused(false)
      returnFocus.current = activeTool ?? 'target'
      setReturnFocusRequest(value => value + 1)
    }
  }
  function clearPatternFilters() { setQuery(''); setRepresentation('') }
  async function refresh() {
    const request = ++catalogRequest.current
    setCatalogLoading(true); setCatalogError('')
    try { const result = await api<{ items: Pattern[] }>('/patterns'); if (mounted.current && request === catalogRequest.current) setItems(Array.isArray(result.items) ? result.items : []) }
    catch (error) { if (mounted.current && request === catalogRequest.current) setCatalogError((error as Error).message) }
    finally { if (mounted.current && request === catalogRequest.current) setCatalogLoading(false) }
  }
  function reset() {
    if (savingRef.current) return
    invalidateTarget(); historyRequest.current++; setHistoryBusy(false); setVersions([])
    setTarget(emptyTarget()); setActiveTool(null); setCandidate(null); setUndo(null); setInputMatch(null); setDrawingFocused(false); setNotice(''); setPanel('create')
    // Tool inputs deliberately survive a new target.
    try { localStorage.removeItem('library.pattern.draft') } catch { /* Optional browser persistence. */ }
  }
  function applyCandidate() {
    if (savingRef.current || !candidate) return
    invalidateTarget(); setUndo(target)
    setTarget({ ...candidate.target, activeId, version, note, minSimilarity: candidate.tool === 'natural_language' ? candidate.target.minSimilarity : minSimilarity, matchMode, recentBars, dirty: true })
    setCandidate(null); setActiveTool(null); setNotice(''); setDrawingFocused(false)
    returnFocus.current = 'target'; setReturnFocusRequest(value => value + 1)
    try { localStorage.removeItem('library.pattern.draft') } catch { /* Optional browser persistence. */ }
  }
  function cancelCandidate() { if (savingRef.current) return; cancelRequest(); returnFocus.current = candidate?.tool ?? 'target'; setCandidate(null); setNotice(''); if (activeTool) setToolFocusRequest(value => value + 1); else setReturnFocusRequest(value => value + 1); try { localStorage.removeItem('library.pattern.draft') } catch { /* Optional browser persistence. */ } }
  function undoApply() { if (savingRef.current || !undo) return; invalidateTarget(); if (!(undo.source === 'market_window' ? undo.marketSource : undo.rawPoints.length > 1 || undo.candles.length > 0)) setDrawingFocused(false); returnFocus.current = source; setTarget(undo); setUndo(null); setCandidate(null); setNotice(''); setReturnFocusRequest(value => value + 1) }
  function changeMarketSelection(next: MarketSelection) { editTool('market_window', () => setMarketSelection(next)) }
  async function loadMarketWindow() {
    if (savingRef.current) return
    setNoticeArea('source')
    if (!marketSelection.code || !marketSelection.start || !marketSelection.end) { setNotice('请选择股票并填写起止日期'); return }
    if (marketSelection.start > marketSelection.end) { setNotice('开始日期不能晚于结束日期'); return }
    const epoch = beginRequest('market_window')
    try {
      const result = await api<PatternMarketSource>('/patterns/market-window', { method: 'POST', body: JSON.stringify({ stock_code: marketSelection.code, start_date: marketSelection.start, end_date: marketSelection.end }) })
      if (!currentRequest(epoch)) return
      if (!validMarketSource(result)) throw new Error('返回的行情区间无效，请重新载入')
      setCandidate({ tool: 'market_window', target: { ...emptyTarget(), name: `${result.stock_code} ${result.start_date} 至 ${result.end_date}`, source: 'market_window', mode: 'ohlc_sequence', targetBars: result.bars.length, marketSource: result, candles: result.bars.map(({ open, high, low, close }) => ({ open, high, low, close })) } })
    } catch (error) { if (currentRequest(epoch)) setNotice((error as Error).message) }
    finally { finishRequest(epoch) }
  }
  function textCandidate(result: ShapeDraft): Candidate { return { tool: 'natural_language', target: { ...emptyTarget(), name: result.name, source: 'natural_language', draft: result, sourceDraftId: result.id, sourcePrompt: result.prompt, targetBars: result.target_bars, minSimilarity: result.min_similarity, rawPoints: pointsFrom(result.points) } } }
  async function describePattern() {
    if (savingRef.current || !prompt.trim()) return
    const epoch = beginRequest('natural_language'), requestedPrompt = prompt
    try {
      const result = await api<ShapeDraft>('/patterns/draft', { method: 'POST', body: JSON.stringify({ prompt: requestedPrompt }) })
      if (!currentRequest(epoch)) return
      if (!validShapeDraft(result)) throw new Error('返回的形态草稿无效，请重试')
      if (result.status !== 'ready' || result.points.length < 2) { setNotice(result.issues.join('；') || '请补充形态描述后重试'); return }
      setCandidate(textCandidate(result))
      const recent = [requestedPrompt, ...recentDescriptions.filter(text => text !== requestedPrompt)].slice(0, 8)
      setRecentDescriptions(recent)
      try { localStorage.setItem('library.pattern.draft', JSON.stringify(result)); localStorage.setItem('library.pattern.recent', JSON.stringify(recent)) } catch { /* Generated candidates remain usable. */ }
    } catch (error) { if (currentRequest(epoch)) setNotice((error as Error).message) }
    finally { finishRequest(epoch) }
  }
  async function selectImage(file?: File) {
    if (!file || savingRef.current) return
    editTool('screenshot', () => undefined); setNoticeArea('source')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setNotice('请选择 PNG、JPEG 或 WebP 图片'); return }
    if (file.size > 10 * 1024 * 1024) { setNotice('图片不能超过 10 MB'); return }
    const epoch = beginRequest('screenshot')
    try {
      const dataUrl = await readDataUrl(file)
      if (!currentRequest(epoch)) return
      setImageTool(previous => ({ ...previous, data: dataUrl.split(',')[1] ?? '', url: '', mime: file.type as ImageInput['mime'], name: file.name }))
    } catch (error) { if (currentRequest(epoch)) setNotice((error as Error).message) }
    finally { finishRequest(epoch) }
  }
  async function imageBytes(image: ImageInput) {
    if (image.data) return image.data
    if (!image.url) return ''
    const response = await fetch(image.url)
    if (!response.ok) throw new Error('无法读取模板来源截图，请重试')
    const blob = await response.blob()
    return (await readDataUrl(new File([blob], image.name || 'pattern-image', { type: blob.type }))).split(',')[1] ?? ''
  }
  async function extract() {
    if (savingRef.current) return
    const epoch = beginRequest('screenshot'), image = imageTool
    try {
      const data = await imageBytes(image)
      if (!currentRequest(epoch)) return
      if (!data) throw new Error('先选择一张走势图截图')
      const result = await api<Extraction>('/patterns/extract', { method: 'POST', body: JSON.stringify({ filename: image.name, mime_type: image.mime, image_base64: data, crop: { x: image.crop.x / 100, y: image.crop.y / 100, width: image.crop.width / 100, height: image.crop.height / 100 } }) })
      if (!currentRequest(epoch)) return
      if (!validExtraction(result)) throw new Error('返回的截图走势无效，请重试')
      setCandidate({ tool: 'screenshot', target: { ...emptyTarget(), name: image.name || '截图形态', source: 'screenshot', rawPoints: pointsFrom(result.points), targetBars: result.target_bars, image: { ...image, data }, quality: result.quality } })
    } catch (error) { if (currentRequest(epoch)) setNotice((error as Error).message) }
    finally { finishRequest(epoch) }
  }
  function convertToDrawing() {
    if (savingRef.current || source === 'drawing') return
    let derivation: Derivation
    if (source === 'market_window' && marketSource) derivation = { origin_type: source, source_window_id: marketSource.snapshot_id }
    else if (source === 'natural_language' && sourceDraftId) derivation = { origin_type: source, source_draft_id: sourceDraftId }
    else if (source === 'screenshot' && target.sourceImagePattern) derivation = { origin_type: source, source_pattern_id: target.sourceImagePattern.id, source_pattern_version: target.sourceImagePattern.version }
    else if (source === 'screenshot' && target.image.data) derivation = { origin_type: source }
    else { setNoticeArea('source'); setNotice('来源信息不完整，请重新载入或生成候选'); return }
    invalidateTarget(); setUndo(target); setCandidate(null); setActiveTool('drawing'); setToolFocusRequest(value => value + 1)
    setTarget({ ...target, source: 'drawing', derivation, originMarket: marketOrigin(marketSource), marketSource: null, sourceDraftId: '', rawPoints: source === 'market_window' ? pointsFrom(marketSource!.bars.map(bar => bar.close)) : rawPoints, dirty: true,
      ...(source === 'market_window' ? { activeId: '', version: 0, name: `${name} 自定义` } : {}) })
    if (source === 'market_window') { setVersions([]); historyRequest.current++; setHistoryBusy(false) }
  }
  function load(item: Pattern) {
    if (savingRef.current) return
    invalidateTarget(); historyRequest.current++; setHistoryBusy(false); if (item.id !== activeId) setVersions([])
    const image: ImageInput = { ...emptyImage(), url: item.source_image ? `/api/v1/patterns/${encodeURIComponent(item.id)}/source-image?version=${item.version}` : '', mime: item.source_image?.mime_type ?? 'image/png', name: item.source_image?.filename ?? '' }
    setTarget({ ...emptyTarget(), activeId: item.id, version: item.version, name: item.name, note: item.note || '', mode: item.representation, source: item.input_type, marketSource: item.market_source ?? null, derivation: item.derivation ? { origin_type: item.derivation.origin_type, source_pattern_id: item.id, source_pattern_version: item.version } : null, sourceDraftId: item.input_type === 'natural_language' ? item.provenance?.draft_id ?? '' : '', sourcePrompt: item.provenance?.prompt ?? item.derivation?.provenance?.prompt ?? '', originMarket: marketOrigin(item.derivation?.market_source), minSimilarity: Number(item.params.min_similarity ?? 80), matchMode: item.params.match_mode === 'recent' ? 'recent' : 'current', recentBars: Number(item.params.recent_bars ?? 20), targetBars: item.target_bars, candles: item.candlesticks ?? [], rawPoints: pointsFrom(item.points), image, sourceImagePattern: item.source_image ? { id: item.id, version: item.version } : null })
    setSavedPreview({ id: item.id, version: item.version }); setActiveTool(null); setCandidate(null); setUndo(null); setInputMatch(null); setNotice(''); setPanel('create'); setDrawingFocused(false)
  }
  async function payloadFor(current: Target) {
    const imageNeeded = current.source === 'screenshot' || current.source === 'drawing' && current.derivation?.origin_type === 'screenshot' && !current.derivation.source_pattern_id
    const data = imageNeeded ? await imageBytes(current.image) : ''
    const values = current.source === 'market_window' ? current.marketSource?.bars.map(bar => bar.close) ?? [] : resample(current.rawPoints, current.targetBars)
    return { name: current.name, note: current.note, input_type: current.source, representation: current.mode, target_bars: current.mode === 'ohlc_sequence' ? current.candles.length : current.targetBars,
      source_draft_id: current.source === 'natural_language' ? current.sourceDraftId || undefined : undefined,
      source_window_id: current.source === 'market_window' ? current.marketSource?.snapshot_id : undefined,
      derivation: current.source === 'drawing' ? referenceDerivation(current.derivation) || undefined : undefined,
      points: current.mode === 'ohlc_sequence' ? current.candles.map(candle => candle.close) : values, candlesticks: current.mode === 'ohlc_sequence' ? current.candles : [],
      params: { min_similarity: current.minSimilarity, match_mode: current.matchMode, recent_bars: current.recentBars, screenshot_quality: current.quality },
      source_image_base64: data || undefined, source_image_mime: data ? current.image.mime : undefined, source_image_filename: data ? current.image.name : undefined }
  }
  async function save(copy = false) {
    if (savingRef.current || !canMatch) return
    savingRef.current = true; invalidateTarget(); historyRequest.current++; setHistoryBusy(false); setSaving(true); setNoticeArea('footer'); setNotice('')
    const current = target
    try {
      const payload = await payloadFor(current)
      if (!mounted.current) return
      const saved = await api<Pattern>('/patterns', { method: 'POST', body: JSON.stringify({ ...payload, id: copy ? undefined : current.activeId || undefined, name: copy ? `${current.name} 副本` : current.name }) })
      if (!mounted.current) return
      setTarget(previous => ({ ...previous, activeId: saved.id, version: saved.version, name: saved.name, dirty: false, derivation: referenceDerivation(saved.derivation) || previous.derivation, sourceImagePattern: saved.source_image ? { id: saved.id, version: saved.version } : previous.sourceImagePattern }))
      setVersions([]); setUndo(null); setNotice(`已保存 ${saved.name} v${saved.version}`)
      try { localStorage.removeItem('library.pattern.draft') } catch { /* Saved server state is authoritative. */ }
      await refresh()
      return saved
    } catch (error) { if (mounted.current) setNotice((error as Error).message) }
    finally { savingRef.current = false; if (mounted.current) setSaving(false) }
  }
  async function matchInput() {
    if (savingRef.current || !canMatch) return
    // Matching leaves editing mode; re-entering drawing expands the canvas before the next stroke.
    if (activeTool === 'drawing' && source === 'drawing') setActiveTool(null)
    selectionRequest.current++; setSelectionError('')
    const request = ++matchRequest.current, requestedGeometry = geometryRef.current, current = target
    setMatchLoading(true); setMatchBusy(true); setMatchError(''); setNotice(''); setInputMatch(null)
    try {
      let result: PatternMatch
      if (current.activeId && !current.dirty) result = await api<PatternMatch>(`/patterns/${encodeURIComponent(current.activeId)}/search?version=${current.version}&limit=12`, { method: 'POST' })
      else {
        const payload = await payloadFor(current)
        if (!mounted.current || request !== matchRequest.current || geometryRef.current !== requestedGeometry) return
        result = await api<PatternMatch>('/patterns/match?limit=12', { method: 'POST', body: JSON.stringify(payload) })
      }
      if (mounted.current && request === matchRequest.current && geometryRef.current === requestedGeometry) setInputMatch(result)
    } catch (error) { if (mounted.current && request === matchRequest.current) setMatchError((error as Error).message) }
    finally { if (mounted.current && request === matchRequest.current) { setMatchLoading(false); setMatchBusy(false) } }
  }
  async function readVersions() {
    if (savingRef.current) return
    const requestedId = activeId, request = ++historyRequest.current
    setHistoryBusy(true); setNoticeArea('footer'); setNotice('')
    try { const result = await api<{ items: Pattern[] }>('/patterns?include_history=true'); if (mounted.current && request === historyRequest.current && editorRef.current?.target.activeId === requestedId) setVersions(result.items.filter(item => item.id === requestedId).sort((a, b) => b.version - a.version)) }
    catch (error) { if (mounted.current && request === historyRequest.current) setNotice((error as Error).message) }
    finally { if (mounted.current && request === historyRequest.current) setHistoryBusy(false) }
  }
  async function selectMatch(key: string) {
    setSelectedMatchKey(key); setSelectionError('')
    const runId = inputMatch?.search_run_id
    if (!runId) return
    const request = ++selectionRequest.current
    try { const update = selectionQueue.current.catch(() => undefined).then(() => api(`/patterns/search-runs/${encodeURIComponent(runId)}`, { method: 'PATCH', body: JSON.stringify({ selected_key: key }) })); selectionQueue.current = update; await update }
    catch (error) { if (mounted.current && request === selectionRequest.current) setSelectionError(`案例选择未保存：${(error as Error).message}`) }
  }
  function usePattern(item?: Pattern) {
    const id = item?.id ?? activeId, savedVersion = item?.version ?? version
    if (!id || savingRef.current) return
    appendCombination({ op: 'pattern_ref', pattern_id: id, version: savedVersion, min_similarity: Number(item?.params.min_similarity ?? minSimilarity), match_mode: item ? (item.params.match_mode === 'recent' ? 'recent' : 'current') : matchMode, recent_bars: Number(item?.params.recent_bars ?? recentBars), score_weight: 1 })
    onCompose?.()
  }
  async function preparePatternScreening() {
    if (savingRef.current || !canMatch) return
    const item = !activeId || dirty ? await save() : undefined
    if ((!activeId || dirty) && !item || !mounted.current) return
    usePattern(item)
  }
  function addCandle() {
    if (!editable || savingRef.current || candles.length >= 250) return
    const previous = candles.at(-1)?.close ?? 100, next = [...candles, { open: previous, high: previous + 1, low: Math.max(0.01, previous - 1), close: previous }]
    editTarget({ candles: next, rawPoints: pointsFrom(next.map(candle => candle.close)), mode: 'ohlc_sequence', targetBars: next.length, selectedCandle: next.length - 1 })
  }
  function changeCandle(field: keyof Candle, value: number) {
    if (!editable || !selected || !Number.isFinite(value)) return
    const next = [...candles], updated = { ...selected, [field]: value }
    if (field === 'open' || field === 'close') { updated.high = Math.max(updated.high, updated.open, updated.close); updated.low = Math.min(updated.low, updated.open, updated.close) }
    else if (field === 'high') updated.high = Math.max(value, updated.open, updated.close)
    else updated.low = Math.min(value, updated.open, updated.close)
    next[selectedCandle] = updated
    editTarget({ candles: next, rawPoints: pointsFrom(next.map(candle => candle.close)) })
  }
  function pointerPoint(event: PointerEvent<SVGSVGElement>): Point { const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1))), y: Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / (rect.height || 1))) } }
  function startDraw(event: PointerEvent<SVGSVGElement>) {
    if (mode !== 'price_path' || !editable || savingRef.current) return
    if (hasTarget) setUndo(target)
    editTarget({ rawPoints: [pointerPoint(event)], candles: [], quality: null }); pointerRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  function continueDraw(event: PointerEvent<SVGSVGElement>) {
    if (!pointerRef.current || savingRef.current || !editable) return
    const point = pointerPoint(event)
    setTarget(previous => { const last = previous.rawPoints.at(-1); return last && point.x - last.x < .002 ? previous : { ...previous, rawPoints: [...previous.rawPoints, point] } })
  }
  function stopDraw() { pointerRef.current = false }
  function changeMode(next: Target['mode']) {
    if (savingRef.current || mode === next || next === 'ohlc_sequence' && !candles.length && rawPoints.length > 1) return
    editTarget({ mode: next, ...(next === 'ohlc_sequence' && candles.length ? { targetBars: candles.length } : {}), ...(next === 'price_path' && candles.length ? { rawPoints: pointsFrom(candles.map(candle => candle.close)), targetBars: Math.max(10, candles.length) } : {}) })
  }
  const screeningSettings = <details className="pattern-workbench-settings" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
    <summary><SlidersHorizontal size={14} />选股设置</summary>
    <div className="pattern-settings-popover">
      <label className="field workspace-field-label"><span>最低相似度</span><input disabled={saving} aria-label="最低相似度" type="number" min={0} max={100} step={1} value={minSimilarity} onChange={event => editTarget({ minSimilarity: Number(event.target.value) })} className="workspace-field" /></label>
      <label className="field workspace-field-label"><span>选股匹配窗口</span><select disabled={saving} aria-label="形态匹配窗口" value={matchMode} onChange={event => editTarget({ matchMode: event.target.value as 'current' | 'recent' })} className="workspace-field workspace-select"><option value="current">当前窗口</option><option value="recent">近期最相近窗口</option></select></label>
      {matchMode === 'recent' && <label className="field workspace-field-label"><span>近期回看（根）</span><input disabled={saving} aria-label="近期回看交易日数" type="number" min={1} max={120} value={recentBars} onChange={event => editTarget({ recentBars: Number(event.target.value) })} className="workspace-field" /></label>}
    </div>
  </details>
  const inputTools = <>
    {activeTool && <section className="pattern-input-panel" ref={inputPanel} aria-label="输入工具" onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); chooseTool(null) }
    }}>
      <header className="pattern-input-panel-heading"><strong>{patternInputActions.find(action => action.value === activeTool)?.label}</strong><button type="button" className="text-button workspace-button" aria-label="关闭输入工具" title="关闭输入工具" disabled={saving} onClick={() => chooseTool(null)}><X size={15} /></button></header>
        {activeTool === 'market_window' && <section className="pattern-market-fields" aria-label="行情区间来源"><div className="field"><span>来源股票</span><StockSearch value={marketSelection.code} onChange={code => changeMarketSelection({ ...marketSelection, code })} onSelectionPending={() => changeMarketSelection({ ...marketSelection, code: '' })} disabled={saving} label="来源股票" /></div><label className="field workspace-field-label"><span>开始日期</span><input type="date" value={marketSelection.start} disabled={saving} onChange={event => changeMarketSelection({ ...marketSelection, start: event.target.value })} className="workspace-field" /></label><label className="field workspace-field-label"><span>结束日期</span><input type="date" value={marketSelection.end} disabled={saving} onChange={event => changeMarketSelection({ ...marketSelection, end: event.target.value })} className="workspace-field" /></label><button className="secondary-button workspace-button" disabled={saving || toolBusy === 'market_window' || !marketSelection.code || !marketSelection.start || !marketSelection.end} onClick={loadMarketWindow}>载入 K 线</button></section>}
        {activeTool === 'drawing' && <div className="pattern-manual-tools">{source === 'market_window' ? <span>真实行情只读，请先复制为自定义形态。</span> : source !== 'drawing' ? <span>先将当前目标转为手工编辑。</span> : <span>{mode === 'price_path' ? '重画走势' : '逐根编辑 OHLC'}</span>}</div>}
        {activeTool === 'screenshot' && <div className="pattern-screenshot-input"><label className="upload-label secondary-button workspace-button" role="button" aria-label="选择截图文件" aria-disabled={saving} tabIndex={saving ? -1 : 0} data-input-focus onKeyDown={event => { if (!saving && !event.nativeEvent.isComposing && event.keyCode !== 229 && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.currentTarget.querySelector('input')?.click() } }}><ImageUp size={14} />上传截图<input type="file" disabled={saving} accept="image/png,image/jpeg,image/webp" onChange={event => { void selectImage(event.target.files?.[0]); event.target.value = '' }} /></label><span>{imageTool.name || 'PNG、JPEG 或 WebP · 最大 10 MB'}</span><button className="secondary-button workspace-button" disabled={saving || toolBusy === 'screenshot' || (!imageTool.data && !imageTool.url)} onClick={extract}>提取走势候选</button><details className="pattern-crop-details"><summary>裁剪与来源</summary><div className="pattern-crop-popover">{(imageTool.data || imageTool.url) && <img src={imageTool.data ? `data:${imageTool.mime};base64,${imageTool.data}` : imageTool.url} alt="待识别行情图截图" />}<span>主图裁剪范围（百分比）</span><div className="crop-controls">{([{ key: 'x', label: '左', min: 0, max: 95 }, { key: 'y', label: '上', min: 0, max: 95 }, { key: 'width', label: '宽', min: 5, max: 100 }, { key: 'height', label: '高', min: 5, max: 100 }] as const).map(item => <label className="workspace-field-label" key={item.key}>{item.label}<input disabled={saving} type="number" min={item.min} max={item.max} value={imageTool.crop[item.key]} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) editTool('screenshot', () => setImageTool(previous => ({ ...previous, crop: { ...previous.crop, [item.key]: Math.max(item.min, Math.min(item.max, value)) } }))) }} className="workspace-field" /></label>)}</div><p>截图只提取走势，不还原真实价格或 OHLC。</p></div></details></div>}
        {activeTool === 'natural_language' && <div className="pattern-language-input"><textarea aria-label="形态需求描述" rows={2} placeholder="例如：20 个交易日内先下跌后回升，形成 V 形反转" value={prompt} disabled={saving} maxLength={2000} onChange={event => editTool('natural_language', () => setPrompt(event.target.value))} className="workspace-field" /><button className="secondary-button workspace-button" disabled={saving || toolBusy === 'natural_language' || !prompt.trim()} onClick={describePattern}><Sparkles size={14} />生成形态草稿</button><details className="pattern-description-examples"><summary>最近描述与示例</summary><div>{(recentDescriptions.length ? recentDescriptions : ['20 个交易日内先下跌后回升，形成 V 形反转', '30 个交易日内形成双底，第二个低点略高', '40 个交易日内先横盘整理，再向上突破']).map(text => <button className="text-button workspace-button" key={text} disabled={saving} onClick={() => editTool('natural_language', () => setPrompt(text))}>{text}</button>)}</div></details></div>}
        {toolBusy && <p className="pattern-source-feedback" role="status">正在准备{sourceLabels[toolBusy]}候选…</p>}
        {notice && noticeArea === 'source' && <p className="pattern-source-feedback" role="status">{notice}</p>}
    </section>}
    {!activeTool && notice && noticeArea === 'source' && <p className="pattern-source-feedback" role="status">{notice}</p>}
        {candidate && <section className="pattern-input-candidate" aria-label="建议候选形态">
          <div className="pattern-input-candidate-preview">{candidate.target.marketSource ? <PatternMarketChart bars={candidate.target.marketSource.bars} /> : <svg viewBox="0 0 900 280" preserveAspectRatio="none" role="img" aria-label="候选走势预览"><polyline points={plotPoints(candidate.target.rawPoints)} fill="none" stroke="var(--ui-chart-line)" strokeWidth="3" /></svg>}</div>
          <div className="pattern-input-candidate-summary"><strong>{sourceLabels[candidate.tool]}候选 · {candidate.target.targetBars} 个交易日</strong><span>{candidate.target.name}{candidate.tool === 'natural_language' && ` · 最低相似度 ${candidate.target.minSimilarity} 分`}</span><div className="pattern-candidate-actions"><button ref={candidateApplyButton} type="button" className="primary-button workspace-button" disabled={saving} onClick={applyCandidate}>应用候选</button><button type="button" className="secondary-button workspace-button" disabled={saving} onClick={cancelCandidate}>取消候选</button></div>{(candidate.target.quality || candidate.target.draft?.issues.length || candidate.target.draft?.assumptions.length) && <details><summary>候选说明</summary>{candidate.target.quality && <p>置信度 {Math.round(candidate.target.quality.confidence * 100)}% · {candidate.target.quality.limitations.join('；')}</p>}{candidate.target.draft?.assumptions.map(assumption => <p key={assumption}>{assumption}</p>)}{candidate.target.draft?.issues.map(issue => <p key={issue}>{issue}</p>)}</details>}</div>
        </section>}
  </>
  const targetChart = <section data-state={workspaceState} data-drawing={activeTool === 'drawing'} className={'pattern-comparison-target' + (drawingFocused ? ' pattern-comparison-target-focused' : '')} aria-label={drawingFocused ? '专注绘图' : '目标形态'} role={drawingFocused ? 'dialog' : 'region'} aria-modal={drawingFocused ? true : undefined} onKeyDown={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && activeTool === 'drawing') { event.preventDefault(); event.stopPropagation(); chooseTool(null); return }
    if (!drawingFocused) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDrawingFocused(false) }
    else trapDialogTab(event)
  }}>
    {(showCanvas || hasTarget) && <header className="pattern-comparison-chart-heading">
      <div><h2>目标形态</h2><span>{source === 'market_window' && marketSource ? <><StockName code={marketSource.stock_code} /> · {marketSource.bars.length} 根</> : `${name} · ${targetBars} 个交易日`}</span>{showCanvas && <span className="pattern-target-source" aria-label="目标来源">来源：{sourceLabels[source]}{source === 'market_window' ? ' · 真实行情 · 只读' : target.derivation ? ` · ${sourceLabels[target.derivation.origin_type]}派生` : ''}</span>}</div>
      <div className="pattern-target-actions">
        {showCanvas && <PatternInputMenu hasTarget={hasTarget} disabled={saving} onChoose={chooseTool} buttonRef={inputMenuButton} />}
        <label className="pattern-target-duration workspace-field-label"><span>交易日数</span><input aria-label="目标交易日数" type="number" min={10} max={250} value={targetBars} disabled={saving || mode === 'ohlc_sequence' || source === 'market_window'} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 10 && value <= 250) editTarget({ targetBars: value }) }} className="workspace-field" /></label>
        <div className="segmented"><button aria-pressed={mode === 'price_path'} disabled={saving} className={'workspace-button' + (mode === 'price_path' ? ' selected' : '')} onClick={() => changeMode('price_path')}>走势曲线</button><button aria-pressed={mode === 'ohlc_sequence'} disabled={saving || !candles.length && (rawPoints.length > 1 || source !== 'drawing')} title={!candles.length && rawPoints.length > 1 ? '走势曲线不能还原 OHLC' : undefined} className={'workspace-button' + (mode === 'ohlc_sequence' ? ' selected' : '')} onClick={() => changeMode('ohlc_sequence')}>蜡烛图</button></div>
        <button ref={focusButton} type="button" className="text-button workspace-button" aria-pressed={drawingFocused} aria-label={drawingFocused ? '退出专注绘图' : '专注绘图'} data-tooltip={drawingFocused ? '退出专注绘图' : '专注绘图'} onClick={() => setDrawingFocused(value => !value)}>{drawingFocused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      </div>
    </header>}
    {inputTools}
    {(showStarters || showCanvas) && <div className="pattern-comparison-chart-content">
      {showStarters ? <div className="pattern-start-actions" role="group" aria-label="创建目标方式"><div className="pattern-start-heading"><span>形态研究</span><h2>用一段走势，寻找相似形态</h2><p>先建立目标，再对照真实行情中的相似样本。</p></div>{patternInputActions.map(({ value, label, description, Icon }) => <button type="button" className="workspace-button" aria-label={label} disabled={saving} key={value} ref={button => { starterButtons.current[value] = button }} onClick={() => chooseTool(value)}><Icon size={22} aria-hidden="true" /><span>{label}<small>{description}</small></span></button>)}</div> : source === 'market_window' ? <div className="pattern-market-preview" aria-label="来源 K 线预览">{marketSource ? <PatternMarketChart bars={marketSource.bars} closePath={mode === 'price_path'} /> : <div className="pattern-comparison-placeholder"><ChartNoAxesCombined size={24} /><p>载入行情候选后应用到目标。</p></div>}</div> : <div className={'pattern-target-drawing' + (mode === 'price_path' && editable ? ' draw-enabled' : '')}>
        <svg ref={drawingCanvas} tabIndex={editable ? 0 : undefined} role="img" viewBox="0 0 900 280" preserveAspectRatio="none" aria-label={mode === 'price_path' ? '走势曲线编辑区' : '蜡烛形态预览'} onPointerDown={startDraw} onPointerMove={continueDraw} onPointerUp={stopDraw} onPointerCancel={stopDraw}>
          {[0, 1, 2, 3, 4].map(line => <line key={`h${line}`} x1="0" x2="900" y1={line * 70} y2={line * 70} className="chart-grid" />)}
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(line => <line key={`v${line}`} x1={line * 112.5} x2={line * 112.5} y1="0" y2="280" className="chart-grid vertical" />)}
          {mode === 'price_path' ? rawPoints.length > 1 && <polyline points={plotPoints(rawPoints)} className={source === 'screenshot' ? 'price-line extracted-line' : 'price-line'} /> : <CandleSvg candles={candles} onSelect={index => { if (!savingRef.current) setTarget(previous => ({ ...previous, selectedCandle: index })) }} />}
          {mode === 'price_path' && rawPoints.length < 2 && <text x="450" y="144" textAnchor="middle" className="chart-placeholder">{editable ? '从左向右拖动，绘制目标走势' : '选择创建方式生成目标形态'}</text>}
        </svg>
        <div className="chart-axis"><span>第 1 日</span><span>{targetBars} 个交易日</span><span>第 {targetBars} 日</span></div>
      </div>}
    </div>}
    {(showCanvas || undo) && <div className="pattern-target-edit-tools">
      {undo && <button type="button" className="text-button workspace-button" disabled={saving} onClick={undoApply}><Undo2 size={14} />撤销应用</button>}
      {hasTarget ? source === 'market_window' && marketSource ? <button className="secondary-button workspace-button" disabled={saving} onClick={convertToDrawing}>复制为自定义形态</button> : source !== 'drawing' ? <button className="secondary-button workspace-button" disabled={saving} onClick={convertToDrawing}>转为手工编辑</button> : activeTool !== 'drawing' ? <button className="text-button workspace-button" disabled={saving} onClick={() => chooseTool('drawing')}>手工编辑</button> : mode === 'price_path' ? <><span>从左向右拖动绘制</span>{hasTarget && <button className="text-button workspace-button" disabled={saving} onClick={() => { setUndo(target); editTarget({ rawPoints: [], candles: [], quality: null }); drawingCanvas.current?.focus() }}><PencilLine size={13} />重画走势</button>}</> : null : editable && mode === 'price_path' ? <span>从左向右拖动绘制</span> : null}
      {hasTarget && <details className="pattern-target-details"><summary>来源与口径</summary><div>
        {marketSource && <p>{marketSource.stock_code} · {marketSource.start_date} 至 {marketSource.end_date} · {marketSource.price_basis === 'unadjusted' ? '未复权日线' : marketSource.price_basis}</p>}
        {target.derivation && <p>由{sourceLabels[target.derivation.origin_type]}转为自定义形态，保留原始来源。</p>}{target.originMarket && <p>来源 {target.originMarket.stock_code} · {target.originMarket.start_date} 至 {target.originMarket.end_date} · {target.originMarket.price_basis === 'unadjusted' ? '未复权日线' : target.originMarket.price_basis}</p>}
        {(draft?.prompt || target.sourcePrompt) && <p>原始描述：{draft?.prompt || target.sourcePrompt}</p>}
        {(target.image.data || target.image.url) && <img src={target.image.data ? `data:${target.image.mime};base64,${target.image.data}` : target.image.url} alt="形态原始截图" />}
        {(source === 'screenshot' || target.derivation?.origin_type === 'screenshot') && <p>截图只提取走势，不还原真实价格或 OHLC。{quality && `置信度 ${Math.round(quality.confidence * 100)}%。`}</p>}
        <p>走势按交易日重采样；相似度不代表上涨概率。</p>
      </div></details>}
    </div>}
    {editable && mode === 'ohlc_sequence' && <details className="pattern-candle-controls" open><summary>编辑蜡烛 · {candles.length} 根</summary><div className="candle-strip">{candles.map((candle, index) => <button key={index} disabled={saving} className={'workspace-button candle-chip' + (selectedCandle === index ? ' active' : '') + (candle.close >= candle.open ? ' up' : ' down')} onClick={() => setTarget(previous => ({ ...previous, selectedCandle: index }))} aria-label={`选择第 ${index + 1} 根蜡烛`} aria-pressed={selectedCandle === index}><i /><small>{index + 1}</small></button>)}</div>{selected && <div className="form-grid four-col candle-fields">{(['open', 'high', 'low', 'close'] as const).map(field => <label className="field workspace-field-label" key={field}><span>{field.toUpperCase()}</span><input disabled={saving} type="number" step="0.01" value={selected[field]} onChange={event => changeCandle(field, Number(event.target.value))} className="workspace-field" /></label>)}</div>}<button className="secondary-button workspace-button" disabled={saving || candles.length >= 250} onClick={addCandle}><Plus size={13} />添加蜡烛</button></details>}
  </section>
  const targetActions = hasTarget ? <div className="pattern-target-controls">
      <footer className="pattern-workbench-footer">
        <label className="pattern-template-name workspace-field-label"><span>模板名称</span><input disabled={saving} value={name} onChange={event => editTarget({ name: event.target.value })} className="workspace-field" /></label>
        <button className="primary-button workspace-button" disabled={saving || matchBusy || !canMatch} onClick={matchInput}><Search size={14} />{matchBusy ? '匹配中…' : '匹配相似形态'}</button>
        {screeningSettings}
        <button className="text-button workspace-button" disabled={saving || !canMatch || (!dirty && !!activeId)} onClick={() => void save()}><Save size={14} />{saving ? '保存中…' : '保存模板'}</button>
        {onDiscuss && activeId && <button className="text-button workspace-button" disabled={dirty || saving} onClick={() => onDiscuss(activeId, version, name)}><MessageCircle size={14} />研究此形态</button>}
        {screeningMode ? <button className="secondary-button workspace-button" disabled={saving || !canMatch} onClick={() => void preparePatternScreening()}>{!activeId || dirty ? '保存并用于选股' : '按此形态选股'}<ArrowRight size={14} /></button> : <button className="secondary-button workspace-button" disabled={saving || !activeId || dirty} onClick={() => usePattern()}>用于组合<ArrowRight size={14} /></button>}
        <span className="pattern-workbench-status" role={notice && noticeArea === 'footer' ? 'status' : undefined}>{notice && noticeArea === 'footer' ? notice : dirty && activeId ? `未保存修改 · 将保存为 v${version + 1}` : activeId ? `已保存 v${version}` : dirty ? '未保存' : ''}</span>
      </footer>
      <details className="pattern-template-research"><summary>备注与版本</summary><div className="pattern-template-research-fields"><label className="field workspace-field-label"><span>模板备注</span><textarea disabled={saving} className="workspace-field" aria-label="模板备注" maxLength={4000} rows={2} value={note} onChange={event => editTarget({ note: event.target.value })} /></label>{activeId && <><button type="button" className="secondary-button workspace-button" disabled={saving || historyBusy || dirty} onClick={readVersions}>查看历史版本</button>{versions.length > 0 && <label className="field workspace-field-label"><span>模板版本</span><select aria-label="模板版本" className="workspace-field workspace-select" value={version} disabled={dirty || saving} onChange={event => { const item = versions.find(item => item.version === Number(event.target.value)); if (item) load(item) }}>{versions.map(item => <option key={item.version} value={item.version}>v{item.version} · {item.created_at}</option>)}</select></label>}<button type="button" className="secondary-button workspace-button" disabled={saving || !canMatch} onClick={() => void save(true)}>另存为副本</button></>}</div></details>
    </div> : null
  return <StockText><div className="page-content workspace-tool-page library-shell library-redesign pattern-library pattern-studio pattern-comparison-studio pattern-unified-workspace" data-panel={panel}>
    <WorkspacePageHeading actionsClassName="library-heading-actions" actions={<>{screeningMode && onScreeningHistory && <button className="secondary-button workspace-button" onClick={onScreeningHistory}>筛选记录</button>}<PatternResearchRecords refreshKey={inputMatch?.search_run_id} /><button className="secondary-button workspace-button" onClick={reset} disabled={saving}><Plus size={15} />新建形态</button></>}><h1>{screeningMode ? '形态选股' : '形态库'}</h1></WorkspacePageHeading>
    <div className="pattern-studio-navigation"><nav className="library-tabs" role="tablist" aria-label="形态库功能" onKeyDown={event => navigateTabs(event, ['create', 'saved'] as const, panel, setPanel)}><button role="tab" id="pattern-create-tab" aria-controls="pattern-content" aria-selected={panel === 'create'} tabIndex={panel === 'create' ? 0 : -1} className={'workspace-button' + (panel === 'create' ? ' active' : '')} onClick={() => setPanel('create')}><ChartNoAxesCombined size={16} />形态匹配</button><button role="tab" id="pattern-saved-tab" aria-controls="pattern-content" aria-selected={panel === 'saved'} tabIndex={panel === 'saved' ? 0 : -1} className={'workspace-button' + (panel === 'saved' ? ' active' : '')} onClick={() => setPanel('saved')}><Library size={16} />我的形态</button></nav><span className="pattern-studio-nav-note">{activeId ? `v${version} · ${dirty ? '有未保存修改' : '已保存'}` : '当前目标'}</span></div>
    <section id="pattern-content" role="tabpanel" aria-labelledby={`pattern-${panel}-tab`}>
    {panel === 'saved' ? <>
        <div className="workspace-filter-bar pattern-filter-bar workspace-filters"><SearchField label="搜索形态" placeholder="搜索形态名称" value={query} onChange={setQuery} /><select aria-label="形态类型筛选" value={representation} onChange={event => setRepresentation(event.target.value)} className="workspace-field workspace-select"><option value="">全部形态类型</option><option value="price_path">走势曲线</option><option value="ohlc_sequence">蜡烛图</option></select><span className="workspace-result-count">{filteredItems.length} / {items.length} 个形态</span>{(query || representation) && <button className="text-button workspace-button" onClick={clearPatternFilters}>重置形态筛选</button>}</div>
        {catalogLoading ? <LoadingState compact label="正在加载形态…" /> : catalogError ? <div className="workspace-error" role="alert">{catalogError}<button className="text-button workspace-button" onClick={() => void refresh()}>重新加载形态</button></div> : !filteredItems.length ? <EmptyState icon={Search} titleAs="h3" title={items.length ? '没有找到匹配的形态' : '暂无形态'} description="保存的目标形态会显示在这里，可随时载入对照。" actions={<button className="secondary-button workspace-button" onClick={items.length ? clearPatternFilters : reset}>{items.length ? '查看全部形态' : '创建形态'}</button>} /> : <div className="shape-gallery">{filteredItems.slice(0, visibleCount).map(item => <article className="saved-condition-card" key={item.id}><div className="pattern-gallery-meta"><span>{item.representation === 'ohlc_sequence' ? '蜡烛图' : '走势曲线'}</span><span>v{item.version}</span></div><div className="condition-card-title"><h3>{item.name}</h3><span className="condition-category">{item.target_bars} 个交易日</span></div><PatternExample key={item.id + '@' + item.version} item={item} allowCurve compact />{item.market_source && <p className="pattern-source-caption">来源 {item.market_source.stock_code} · {item.market_source.start_date} 至 {item.market_source.end_date}</p>}<div className="card-actions"><button className="secondary-button workspace-button" disabled={saving} onClick={() => load(item)}><PencilLine size={14} />载入对照</button><button className="text-button workspace-button" disabled={saving} onClick={() => usePattern(item)}>加入组合<ArrowRight size={14} /></button></div></article>)}{visibleCount < filteredItems.length && <div className="gallery-more"><button className="secondary-button workspace-button" onClick={() => setVisibleCount(value => value + 6)}>显示更多形态（还有 {filteredItems.length - visibleCount} 个）</button></div>}</div>}
    </> : <div className="pattern-workbench">
      <PatternComparison target={targetChart} matchAction={targetActions} result={inputMatch} loading={matchLoading} error={matchError} selectedKey={selectedMatchKey} onSelect={selectMatch} onRetry={() => void matchInput()} minSimilarity={minSimilarity} />
      {selectionError && <p className="workspace-error" role="alert">{selectionError}</p>}

    </div>}
    </section>
  </div></StockText>
}

// Keep preview requests component-local: module-level promises can outlive an account switch.
function requestPatternExamples(id: string, version: number, similar = false) {
  return api<PatternMatch>(`/patterns/${encodeURIComponent(id)}/best-match?version=${version}${similar ? '&limit=12' : ''}`)
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
    requestPatternExamples(item.id, item.version, showSimilar).then(value => { if (active) setResult(value) }).catch(error => { if (active) setError(error.message) })
    return () => { active = false }
  }, [item.id, item.version, retry, showSimilar, key])
  const matches = result?.items?.length ? result.items : result?.bars.length ? [result] : []
  const selectedMatch = matches[selectedIndex] || matches[0]
  return <StockText><div className={'pattern-example' + (showSimilar ? ' pattern-match-browser' : '')}>
    {allowCurve && <div className="pattern-chart-toolbar">{showSimilar && <span><ChartNoAxesCombined size={14} />{curve ? '原始目标走势' : '真实行情对照'}</span>}<div className="pattern-chart-tools"><div className="segmented"><button aria-pressed={!curve} className={["workspace-button", !curve ? 'selected' : ''].filter(Boolean).join(' ')} onClick={() => setCurve(false)}>K线</button><button aria-pressed={curve} className={["workspace-button", curve ? 'selected' : ''].filter(Boolean).join(' ')} onClick={() => setCurve(true)}>原始曲线</button></div>{!curve && result && <button className="text-button pattern-refresh workspace-button" aria-label="刷新形态匹配" onClick={() => { setRetry(value => value + 1) }}><RefreshCw size={13} /><span>刷新匹配</span></button>}</div></div>}
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
