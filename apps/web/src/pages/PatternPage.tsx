import { PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, BookOpen, ImageUp, RefreshCw, Library, MessageCircle, Plus, Save, Search, Sparkles, Trash2 } from 'lucide-react'
import { api, type Pattern } from '../api'
import { appendCombination } from '../libraryContext'
import { ResponsiveMarketIndicatorChart as MarketIndicatorChart, type ChartBar } from './TechnicalBrowser'
import { navigateTabs } from '../keyboard'

type Point = { x: number; y: number }
type Candle = { open: number; high: number; low: number; close: number }
type Extraction = { points: number[]; target_bars: number; quality: { confidence: number; horizontal_coverage: number; requires_manual_review: boolean; limitations: string[] } }
type ShapeDraft = { id: string; prompt: string; status: string; name: string; points: number[]; target_bars: number; min_similarity: number; assumptions: string[]; issues: string[]; description: string }
type EditorSnapshot = { activeId: string; version: number; name: string; mode: 'price_path' | 'ohlc_sequence'; source: 'drawing' | 'screenshot' | 'natural_language'; panel: 'browse' | 'create' | 'saved'; draft: ShapeDraft | null; sourceDraftId: string; minSimilarity: number; matchMode: 'current' | 'recent'; recentBars: number; dirty: boolean; targetBars: number; rawPoints: Point[]; candles: Candle[]; selectedCandle: number; imageData: string; savedImageUrl: string; imageMime: 'image/png' | 'image/jpeg' | 'image/webp'; imageName: string; crop: { x: number; y: number; width: number; height: number }; quality: Extraction['quality'] | null }
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
    if (!value || !['price_path', 'ohlc_sequence'].includes(value.mode) || !['drawing', 'screenshot', 'natural_language'].includes(value.source) || !['browse', 'create', 'saved'].includes(value.panel)) return null
    if (!['activeId', 'name', 'sourceDraftId', 'imageData', 'savedImageUrl', 'imageName'].every(key => typeof (value as unknown as Record<string, unknown>)[key] === 'string')) return null
    if (!Number.isInteger(value.version) || value.version < 0 || !Number.isInteger(value.targetBars) || value.targetBars < 10 || value.targetBars > 250 || !Number.isFinite(value.minSimilarity) || !['current', 'recent'].includes(value.matchMode) || !Number.isInteger(value.recentBars) || typeof value.dirty !== 'boolean') return null
    if (!Array.isArray(value.rawPoints) || value.rawPoints.length > 10000 || !value.rawPoints.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return null
    if (!Array.isArray(value.candles) || value.candles.length > 250 || !value.candles.every(candle => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))) return null
    if (!Number.isInteger(value.selectedCandle) || !['image/png', 'image/jpeg', 'image/webp'].includes(value.imageMime) || !value.crop || !Object.values(value.crop).every(Number.isFinite) || (value.draft && !validShapeDraft(value.draft))) return null
    return value
  } catch { return null }
}

export default function PatternPage({ onCompose, onDiscuss }: { onCompose?: () => void; onDiscuss?: (id: string, version: number, name: string) => void }) {
  const [restored] = useState(readEditor)
  const [items, setItems] = useState<Pattern[]>([])
  const [activeId, setActiveId] = useState(restored?.activeId || '')
  const [version, setVersion] = useState(restored?.version || 0)
  const [name, setName] = useState(restored?.name || '新形态')
  const [mode, setMode] = useState<'price_path' | 'ohlc_sequence'>(restored?.mode || 'price_path')
  const [source, setSource] = useState<'drawing' | 'screenshot' | 'natural_language'>(restored?.source || 'drawing')
  const [panel, setPanel] = useState<'browse' | 'create' | 'saved'>(restored?.panel || 'browse')
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
  const [busy, setBusy] = useState(false)
  const [inputMatch, setInputMatch] = useState<PatternMatch | null>(null)
  const pointerRef = useRef(false)
  const panelRef = useRef(panel)
  panelRef.current = panel

  const refresh = () => api<{ items: Pattern[] }>('/patterns').then(({ items }) => setItems(items)).catch((error) => setNotice(error.message))
  useEffect(() => { refresh(); if (!restored) { try { const raw = JSON.parse(localStorage.getItem('library.pattern.draft') || 'null'); if (validShapeDraft(raw)) { acceptDraft(raw); setPanel('browse') } } catch { /* Invalid saved data must not break the editor. */ } } }, [])
  useEffect(() => { try { localStorage.setItem('library.pattern.prompt', prompt) } catch { /* Storage failure should not block drafting. */ } }, [prompt])

  const pointValues = useMemo(() => resample(rawPoints, targetBars), [rawPoints, targetBars])
  const selected = candles[selectedCandle]
  const displayedPattern = items.find(item => item.id === activeId) ?? items[0]
  const geometry = JSON.stringify([mode, targetBars, pointValues, candles])
  const geometryRef = useRef(geometry)
  const editorRef = useRef<EditorSnapshot | null>(null)
  editorRef.current = { activeId, version, name, mode, source, panel, draft, sourceDraftId, minSimilarity, matchMode, recentBars, dirty, targetBars, rawPoints, candles, selectedCandle, imageData, savedImageUrl, imageMime, imageName, crop, quality }
  useEffect(() => {
    const save = () => { try { sessionStorage.setItem('pattern.editor', JSON.stringify(editorRef.current)) } catch { /* Editing and explicit template saving remain available. */ } }
    const timer = setTimeout(save, 300)
    return () => clearTimeout(timer)
  }, [activeId, version, name, mode, source, panel, draft, sourceDraftId, minSimilarity, matchMode, recentBars, dirty, targetBars, rawPoints, candles, selectedCandle, imageData, savedImageUrl, imageMime, imageName, crop, quality])
  useEffect(() => {
    const save = () => { try { sessionStorage.setItem('pattern.editor', JSON.stringify(editorRef.current)) } catch { /* Explicit saved templates are independent of browser storage. */ } }
    window.addEventListener('pagehide', save)
    return () => { window.removeEventListener('pagehide', save); save() }
  }, [])
  geometryRef.current = geometry
  useEffect(() => setInputMatch(null), [rawPoints, candles, targetBars, mode])

  function reset() {
    setActiveId(''); setVersion(0); setName('新形态'); setMode('price_path'); setSource('drawing'); setTargetBars(40)
    setRawPoints([]); setCandles([]); setSelectedCandle(0); setImageData(''); setSavedImageUrl(''); setQuality(null); setNotice('')
    setDraft(null); setSourceDraftId(''); setMinSimilarity(80); setMatchMode('current'); setRecentBars(20); setDirty(false); setPanel('create')
    localStorage.removeItem('library.pattern.draft')
  }

  function acceptDraft(result: ShapeDraft) {
    setDraft(result); setActiveId(''); setVersion(0); setSource('natural_language'); setSourceDraftId(result.status === 'ready' ? result.id : '')
    setName(result.name); setMode('price_path'); setTargetBars(result.target_bars); setMinSimilarity(result.min_similarity); setMatchMode('current'); setRecentBars(20)
    setRawPoints(result.points.map((y, i) => ({ x: i / Math.max(1, result.points.length - 1), y })))
    setImageData(''); setSavedImageUrl(''); setQuality(null); setCandles([]); setDirty(true); setPanel('create')
  }

  async function describePattern() {
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
    appendCombination({ op: 'pattern_ref', pattern_id: id, version: savedVersion, min_similarity: Number(item?.params.min_similarity ?? minSimilarity), match_mode: item?.params.match_mode === 'recent' ? 'recent' : matchMode, recent_bars: Number(item?.params.recent_bars ?? recentBars), score_weight: 1 })
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
    if (mode !== 'price_path' || busy) return
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
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setNotice('请选择 PNG、JPEG 或 WebP 图片'); return }
    if (file.size > 10 * 1024 * 1024) { setNotice('图片不能超过 10 MB'); return }
    setBusy(true); setNotice('')
    try {
      const dataUrl = await readDataUrl(file)
      setImageData(dataUrl.split(',')[1] ?? '')
      setSavedImageUrl('')
      setImageMime(file.type as typeof imageMime)
      setImageName(file.name)
      setSource('screenshot'); setMode('price_path'); setQuality(null)
      setDirty(true); setSourceDraftId('')
      setNotice('截图已载入。调整主图裁剪区域后执行识别。')
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  async function extract() {
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
    setActiveId(item.id); setVersion(item.version); setName(item.name); setMode(item.representation); setSource(item.input_type === 'natural_language' ? 'natural_language' : item.input_type === 'screenshot' ? 'screenshot' : 'drawing')
    setSourceDraftId(item.provenance?.draft_id ?? ''); setMinSimilarity(Number(item.params.min_similarity ?? 80)); setMatchMode(item.params.match_mode === 'recent' ? 'recent' : 'current'); setRecentBars(Number(item.params.recent_bars ?? 20)); setDraft(null); setDirty(false); setPanel('browse')
    if (item.provenance?.prompt) setPrompt(item.provenance.prompt)
    setTargetBars(item.target_bars); setCandles(item.candlesticks ?? []); setRawPoints(item.points.map((y, index) => ({ x: index / Math.max(1, item.points.length - 1), y })))
    setImageData('')
    setSavedImageUrl(item.source_image ? `/api/v1/patterns/${item.id}/source-image?version=${item.version}` : '')
    if (item.source_image) { setImageMime(item.source_image.mime_type); setImageName(item.source_image.filename) }
    setSelectedCandle(0); setQuality(null); setNotice(`已载入 v${item.version}。再次保存将生成新版本。`)
  }

  async function save() {
    if (mode === 'price_path' && pointValues.length < 10) { setNotice('先手绘至少两个点，或上传截图完成走势提取'); return }
    if (mode === 'ohlc_sequence' && candles.length < 10) { setNotice('蜡烛模板至少需要 10 根已编辑 OHLC'); return }
    if (mode === 'ohlc_sequence' && candles.length !== targetBars) { setNotice('当前蜡烛数与目标交易日数不一致'); return }
    setBusy(true); setNotice('')
    try {
      const saved = await api<Pattern>('/patterns', { method: 'POST', body: JSON.stringify({
        id: activeId || undefined, name, input_type: source, representation: mode, target_bars: mode === 'ohlc_sequence' ? candles.length : targetBars,
        source_draft_id: sourceDraftId || undefined,
        points: mode === 'ohlc_sequence' ? candles.map((item) => item.close) : pointValues,
        candlesticks: mode === 'ohlc_sequence' ? candles : [], params: { min_similarity: minSimilarity, match_mode: matchMode, recent_bars: recentBars, screenshot_quality: quality },
        source_image_base64: source === 'screenshot' && imageData ? imageData : undefined,
        source_image_mime: source === 'screenshot' && imageData ? imageMime : undefined,
        source_image_filename: source === 'screenshot' ? imageName : undefined,
      }) })
      setActiveId(saved.id); setVersion(saved.version); await refresh(); setNotice(`已保存 ${saved.name} v${saved.version}`)
      setDirty(false); if (panelRef.current === 'create') setPanel('browse'); localStorage.removeItem('library.pattern.draft')
    } catch (error) { setNotice((error as Error).message) }
    finally { setBusy(false) }
  }

  const svgPoints = rawPoints.map((point) => `${point.x * 900},${(1 - point.y) * 280}`).join(' ')
  async function matchInput() {
    setBusy(true); setNotice(''); setInputMatch(null)
    const requestedGeometry = geometryRef.current
    try {
      const result = await api<PatternMatch>('/patterns/match', { method: 'POST', body: JSON.stringify({ name, input_type: source, representation: mode, target_bars: targetBars, points: mode === 'ohlc_sequence' ? candles.map(item => item.close) : pointValues, candlesticks: mode === 'ohlc_sequence' ? candles : [] }) })
      if (geometryRef.current === requestedGeometry) setInputMatch(result)
      else setNotice('走势已修改，请按当前走势重新匹配。')
    } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) }
  }
  const selectedValue = (field: keyof Candle) => selected?.[field] ?? 0
  return (
    <div className="page-content library-shell pattern-library">
      <div className="page-heading"><div className="library-title"><span className="workspace-eyebrow">研究资料</span><h1>形态库</h1></div><div className="library-heading-actions">{onDiscuss && <button className="primary-button" disabled={!displayedPattern || (panel === 'create' && dirty) || busy} onClick={() => displayedPattern && onDiscuss(displayedPattern.id, displayedPattern.version, displayedPattern.name)}><MessageCircle size={15} />研究当前形态</button>}<button className="secondary-button" onClick={reset} disabled={busy}><Plus size={15} />新建形态</button></div></div>
      <nav className="library-tabs" role="tablist" aria-label="形态库功能" onKeyDown={event => navigateTabs(event, ['browse', 'create', 'saved'] as const, panel, setPanel)}><button role="tab" id="pattern-browse-tab" aria-controls="pattern-content" aria-selected={panel === 'browse'} tabIndex={panel === 'browse' ? 0 : -1} className={panel === 'browse' ? 'active' : ''} onClick={() => setPanel('browse')}><BookOpen size={16} />浏览形态</button><button role="tab" id="pattern-create-tab" aria-controls="pattern-content" aria-selected={panel === 'create'} tabIndex={panel === 'create' ? 0 : -1} className={panel === 'create' ? 'active' : ''} onClick={() => setPanel('create')}><Sparkles size={16} />描述需求</button><button role="tab" id="pattern-saved-tab" aria-controls="pattern-content" aria-selected={panel === 'saved'} tabIndex={panel === 'saved' ? 0 : -1} className={panel === 'saved' ? 'active' : ''} onClick={() => setPanel('saved')}><Library size={16} />我的形态</button></nav>
      {notice && <div className="inline-notice" role="status">{notice}</div>}
      <section id="pattern-content" role="tabpanel" aria-labelledby={`pattern-${panel}-tab`}>
      {panel === 'create' && <div className="intent-layout"><section className="pattern-language-panel"><div className="section-title-row"><h2>描述目标走势</h2></div><textarea aria-label="形态需求描述" value={prompt} disabled={busy} maxLength={2000} onChange={e => setPrompt(e.target.value)} placeholder="例如：近30个交易日的双底形态，相似度不低于85%" /><div className="prompt-bottom"><span>{prompt.length}/2000</span><button className="primary-button" disabled={busy || !prompt.trim()} onClick={describePattern}><Sparkles size={15} />{busy ? '正在生成…' : '生成形态草稿'}</button></div>{draft?.issues.map(item => <div className="clarification-card" key={item}>{item}</div>)}</section><aside className="intent-guide"><section className="draft-history"><h3>最近的描述</h3>{recentDescriptions.map(text => <button key={text} disabled={busy} onClick={() => setPrompt(text)}>{text}</button>)}</section></aside></div>}
      {panel === 'browse' && <div className="pattern-layout"><aside className="asset-rail pattern-rail"><div className="rail-heading"><strong>形态</strong><span>{items.length}</span></div>{items.map(item => <button className={'asset-row ' + ((activeId || items[0]?.id) === item.id ? 'selected' : '')} key={item.id} onClick={() => load(item)}><span className="asset-row-title">{item.name}</span><span className="asset-row-meta">{item.target_bars} 根 · v{item.version}</span></button>)}</aside><section className="pattern-browse-detail">{(() => { const item = items.find(item => item.id === activeId) ?? items[0]; return item ? <><div className="section-title-row"><h2>{item.name}</h2><button className="secondary-button" onClick={() => { load(item); setPanel('create') }}>编辑形态</button></div><PatternExample key={item.id + '@' + item.version} item={item} /><button className="primary-button" onClick={() => usePattern(item)}>加入组合<ArrowRight size={14} /></button></> : <p className="workbench-help">暂无已保存形态。到“描述需求”中用文字、绘图或截图创建。</p> })()}</section></div>}
      {panel === 'saved' && <div className="shape-gallery">{items.map(item => <article className="saved-condition-card" key={item.id}><div className="condition-card-title"><h3>{item.name}</h3><span className="condition-category">v{item.version} · {item.target_bars} 个交易日</span></div><PatternExample key={item.id + '@' + item.version} item={item} allowCurve /><p>最低相似度 {String(item.params.min_similarity ?? 80)} 分</p><div className="card-actions"><button className="secondary-button" onClick={() => { load(item); setPanel('create') }}>查看与调整</button><button className="primary-button" onClick={() => usePattern(item)}>加入组合<ArrowRight size={14} /></button></div></article>)}{!items.length && <div className="workbench-empty">还没有形态条件。</div>}</div>}
      {panel === 'create' && <div className="pattern-create-layout">
        <div className="pattern-editor">
          <section className="editor-section">
            <div className="pattern-topline">
              <div className="segmented">
                <button className={mode === 'price_path' ? 'selected' : ''} onClick={() => { setMode('price_path'); setDirty(true) }}>走势曲线</button>
                <button className={mode === 'ohlc_sequence' ? 'selected' : ''} onClick={() => { setMode('ohlc_sequence'); setSource('drawing'); setDirty(true) }}>蜡烛图</button>
              </div>
              <div className="source-toggle"><button className={source === 'drawing' ? 'selected' : ''} onClick={() => { setSource('drawing'); setMode('price_path'); setSourceDraftId(''); setDraft(null) }}>手绘输入</button><label className={`upload-label ${source === 'screenshot' ? 'selected' : ''}`}><ImageUp size={15} />上传截图<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => selectImage(event.target.files?.[0])} /></label></div>
            </div>

            {source === 'screenshot' && <div className="screenshot-tools">
              <div className="screenshot-preview">{imageData || savedImageUrl ? <img src={imageData ? `data:${imageMime};base64,${imageData}` : savedImageUrl} alt="待识别行情图截图" /> : <div className="upload-empty"><ImageUp size={24} /><span>选择一张 PNG、JPEG 或 WebP 图表截图</span></div>}</div>
              <div className="crop-controls">
                <strong>主图裁剪范围（百分比）</strong>
                <label>左 <input type="number" min={0} max={95} value={crop.x} onChange={(event) => setCrop({ ...crop, x: Number(event.target.value) })} /></label>
                <label>上 <input type="number" min={0} max={95} value={crop.y} onChange={(event) => setCrop({ ...crop, y: Number(event.target.value) })} /></label>
                <label>宽 <input type="number" min={5} max={100} value={crop.width} onChange={(event) => setCrop({ ...crop, width: Number(event.target.value) })} /></label>
                <label>高 <input type="number" min={5} max={100} value={crop.height} onChange={(event) => setCrop({ ...crop, height: Number(event.target.value) })} /></label>
                <button className="secondary-button compact" disabled={busy || (!imageData && !savedImageUrl)} onClick={extract}><Search size={14} />提取走势候选</button>
              </div>
            </div>}

            <div className={`drawing-area ${source !== 'screenshot' && mode === 'price_path' ? 'draw-enabled' : ''}`}>
              <svg viewBox="0 0 900 280" preserveAspectRatio="none" aria-label={mode === 'price_path' ? '走势曲线编辑区' : '蜡烛形态预览'}
                onPointerDown={startDraw} onPointerMove={continueDraw} onPointerUp={stopDraw} onPointerCancel={stopDraw}>
                {[0, 1, 2, 3, 4].map((line) => <line key={`h${line}`} x1="0" x2="900" y1={line * 70} y2={line * 70} className="chart-grid" />)}
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((line) => <line key={`v${line}`} x1={line * 112.5} x2={line * 112.5} y1="0" y2="280" className="chart-grid vertical" />)}
                {mode === 'price_path' ? rawPoints.length > 1 && <polyline points={svgPoints} className={source === 'screenshot' ? 'price-line extracted-line' : 'price-line'} /> : <CandleSvg candles={candles} onSelect={setSelectedCandle} />}
                {mode === 'price_path' && rawPoints.length < 2 && <text x="450" y="144" textAnchor="middle" className="chart-placeholder">{source === 'drawing' ? '在此拖动绘制走势' : '识别结果将在此对照'}</text>}
              </svg>
              <div className="chart-axis"><span>起点</span><span>{targetBars} 个交易日</span><span>末端</span></div>
            </div>

            <div className="pattern-fields">
              <label className="field grow"><span>模板名称</span><input value={name} onChange={(event) => { setName(event.target.value); setDirty(true) }} /></label>
              <label className="field"><span>目标交易日数</span><input type="number" min={10} max={250} value={targetBars} disabled={mode === 'ohlc_sequence'} onChange={(event) => { setTargetBars(Number(event.target.value)); setDirty(true) }} /></label>
              {mode === 'price_path' && <button className="icon-text-button" onClick={() => { setRawPoints([]); setQuality(null); setDirty(true) }} title="清除走势"><Trash2 size={15} />清除</button>}
              {mode === 'ohlc_sequence' && <button className="secondary-button compact" onClick={addCandle}><Plus size={14} />添加蜡烛</button>}
              <label className="field pattern-threshold"><span>最低相似度（分）</span><div><input aria-label="最低相似度滑块" type="range" min={0} max={100} step={1} value={minSimilarity} onChange={e => { setMinSimilarity(Number(e.target.value)); setDirty(true) }} /><input aria-label="最低相似度" type="number" min={0} max={100} step={1} value={minSimilarity} onChange={e => { setMinSimilarity(Number(e.target.value)); setDirty(true) }} /></div><small>低于此分数的股票不会进入形态筛选结果。</small></label>
              <label className="field"><span>匹配窗口</span><select aria-label="形态匹配窗口" value={matchMode} onChange={e => { setMatchMode(e.target.value as 'current' | 'recent'); setDirty(true) }}><option value="current">当前窗口</option><option value="recent">近期最相近窗口</option></select></label>
              {matchMode === 'recent' && <label className="field"><span>近期回看（根）</span><input aria-label="近期回看交易日数" type="number" min={1} max={120} value={recentBars} onChange={e => { setRecentBars(Number(e.target.value)); setDirty(true) }} /></label>}
              <button className="primary-button" disabled={busy || (!dirty && !!activeId) || (mode === 'price_path' && pointValues.length < 10)} onClick={save}><Save size={15} />{source === 'natural_language' ? '确认并保存形态' : '保存模板'}</button><button className="secondary-button" disabled={busy || !activeId || dirty} onClick={() => usePattern()}>用于组合<ArrowRight size={14} /></button>
            </div>

            {mode === 'ohlc_sequence' && <div className="candle-editor">
              <div className="section-title-row"><h2>蜡烛编辑</h2><span>{candles.length} 根已编辑 OHLC</span></div>
              <div className="candle-strip">{candles.map((candle, index) => <button key={index} className={`candle-chip ${selectedCandle === index ? 'active' : ''} ${candle.close >= candle.open ? 'up' : 'down'}`} onClick={() => setSelectedCandle(index)} title={`第 ${index + 1} 根`}><i /></button>)}</div>
              {selected && <div className="form-grid four-col candle-fields">{(['open', 'high', 'low', 'close'] as const).map((field) => <label className="field" key={field}><span>{field.toUpperCase()}</span><input type="number" step="0.01" value={selectedValue(field)} onChange={(event) => changeCandle(field, Number(event.target.value))} /></label>)}</div>}
            </div>}
            {quality && <div className={`quality-row ${quality.requires_manual_review ? 'needs-review' : ''}`}><span>截图路径候选置信度 <b>{Math.round(quality.confidence * 100)}%</b></span><span>横向覆盖 {Math.round(quality.horizontal_coverage * 100)}%</span>{quality.limitations.map((item) => <small key={item}>{item}</small>)}</div>}
            <button className="primary-button" disabled={busy || (mode === 'price_path' ? pointValues.length < 10 : candles.length < 10)} onClick={matchInput}><Search size={15} />{busy ? '处理中…' : '匹配真实K线'}</button>
            {inputMatch && <div className="pattern-example"><h3>匹配结果</h3>{inputMatch.bars.length ? <><MarketIndicatorChart chart={{ bars: inputMatch.bars, placement: 'overlay', lines: [], histogram: null, reference_lines: [] }} /><p className="pattern-example-caption">{inputMatch.stock_code} · {inputMatch.start_date} 至 {inputMatch.end_date} · 形态相似度 {inputMatch.similarity?.toFixed(1)} 分（衡量走势形状，不是上涨概率）</p><small>{inputMatch.scope}</small></> : <p>{inputMatch.reason}</p>}</div>}
          </section>

          {sourceDraftId && <details className="provenance"><summary>查看形态来源</summary><p>原始描述：{draft?.prompt ?? prompt}</p><p>草稿编号：{sourceDraftId} · 已保存版本：{version || '尚未保存'}</p></details>}{dirty && activeId && <p className="notice-amber">当前有未保存修改，保存后才能试算或加入组合。</p>}
        </div>
      </div>}
      </section>
    </div>
  )
}

type PatternMatch = { bars: ChartBar[]; similarity?: number; stock_code?: string; start_date?: string; end_date?: string; reason?: string; scope?: string }
const exampleRequests = new Map<string, { expires: number; request: Promise<PatternMatch> }>()
function PatternExample({ item, allowCurve = false }: { item: Pattern; allowCurve?: boolean }) {
  const [curve, setCurve] = useState(false)
  const [result, setResult] = useState<PatternMatch | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    const key = item.id + '@' + item.version
    setResult(null); setError('')
    if (!exampleRequests.has(key) || exampleRequests.get(key)!.expires < Date.now()) {
      if (exampleRequests.size >= 80) exampleRequests.delete(exampleRequests.keys().next().value!)
      const request = api<PatternMatch>('/patterns/' + item.id + '/best-match?version=' + item.version).catch(error => { exampleRequests.delete(key); throw error })
      exampleRequests.set(key, { expires: Date.now() + 5 * 60000, request })
    }
    exampleRequests.get(key)!.request.then(value => { if (active) setResult(value) }).catch(error => { if (active) setError(error.message) })
    return () => { active = false }
  }, [item.id, item.version, retry])
  return <div className="pattern-example">
    {allowCurve && <div className="segmented"><button aria-pressed={!curve} className={!curve ? 'selected' : ''} onClick={() => setCurve(false)}>K线</button><button aria-pressed={curve} className={curve ? 'selected' : ''} onClick={() => setCurve(true)}>原始曲线</button></div>}
    {!curve && result && <button className="text-button pattern-refresh" aria-label="刷新形态匹配" onClick={() => { exampleRequests.delete(item.id + '@' + item.version); setRetry(value => value + 1) }}><RefreshCw size={13} />刷新匹配</button>}
    {curve ? <svg viewBox="0 0 600 160" role="img" aria-label={item.name + '原始曲线'}><polyline points={galleryPoints(item.points)} fill="none" stroke="var(--ui-chart-line)" strokeWidth="2.5" /></svg> : error ? <p role="alert">{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></p> : !result ? <div className="pattern-match-loading" role="status"><span className="loading-ring" />正在寻找匹配度最高的真实 K 线…</div> : result.bars.length ? <><MarketIndicatorChart chart={{ bars: result.bars, placement: 'overlay', lines: [], histogram: null, reference_lines: [] }} /><p className="pattern-example-caption">{result.stock_code} · {result.start_date} 至 {result.end_date} · 形态相似度 {result.similarity?.toFixed(1)} 分（衡量走势形状，不是上涨概率）</p><small>{result.scope}</small></> : <p className="workbench-help">{result.reason}</p>}
  </div>
}

function galleryPoints(points: number[]) {
  const low = Math.min(...points), span = Math.max(...points) - low || 1
  return comparisonPoints(points.map(value => (value - low) / span))
}

function comparisonPoints(points: number[]) {
  return points.map((value, index) => `${10 + index * 580 / Math.max(1, points.length - 1)},${150 - value * 140}`).join(' ')
}

function CandleSvg({ candles, onSelect }: { candles: Candle[]; onSelect: (index: number) => void }) {
  if (!candles.length) return <text x="450" y="144" textAnchor="middle" className="chart-placeholder">添加蜡烛后编辑开高低收</text>
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
