import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, ZoomIn, ZoomOut } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export default function PdfReader({ url, page, onPageChange, pageControls, actions }: { url: string; page: number; onPageChange: (page: number) => void; pageControls?: ReactNode; actions?: ReactNode }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [frame, setFrame] = useState({ width: 600, height: 650 })
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState<'width' | 'page' | 'custom'>('width')
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(true)
  const [retry, setRetry] = useState(0)
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let active = true
    setDocument(null); setError(''); setRendering(true)
    const task = getDocument({ url, cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/' })
    task.promise.then(result => { if (active) setDocument(result) }).catch(error => { if (active) { setError('PDF 读取失败：' + error.message); setRendering(false) } })
    return () => { active = false; void task.destroy().catch(() => {}) }
  }, [url, retry])
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setFrame({ width: Math.max(180, width), height: Math.max(200, height) })
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (container.current) { container.current.scrollTop = 0; container.current.scrollLeft = 0 }
  }, [page, url])
  useEffect(() => {
    if (!expanded) return
    const previous = globalThis.document.body.style.overflow
    globalThis.document.body.style.overflow = 'hidden'
    return () => { globalThis.document.body.style.overflow = previous }
  }, [expanded])
  useEffect(() => {
    if (!document || !canvas.current) return
    let active = true
    let cancel: (() => void) | undefined
    setRendering(true); setError('')
    void document.getPage(Math.max(1, Math.min(page, document.numPages))).then(async pdfPage => {
      if (!active || !canvas.current) return
      const viewport = pdfPage.getViewport({ scale: 1 })
      const fitWidth = frame.width / viewport.width
      const scale = fit === 'page' ? Math.min(fitWidth, frame.height / viewport.height) : fitWidth * (fit === 'custom' ? zoom : 1)
      const display = pdfPage.getViewport({ scale })
      const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (display.width * display.height)))
      // Each render owns its canvas so a cancelled zoom/page render cannot overwrite the new page.
      const buffer = canvas.current.ownerDocument.createElement('canvas')
      buffer.width = Math.max(1, Math.floor(display.width * pixelRatio))
      buffer.height = Math.max(1, Math.floor(display.height * pixelRatio))
      const context = buffer.getContext('2d')
      if (!context) throw new Error('浏览器无法创建 PDF 画布')
      const render = pdfPage.render({ canvas: buffer, canvasContext: context, viewport: display, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] })
      cancel = () => render.cancel()
      await render.promise
      if (!active || !canvas.current) return
      canvas.current.width = buffer.width
      canvas.current.height = buffer.height
      canvas.current.style.width = display.width + 'px'
      canvas.current.style.height = display.height + 'px'
      canvas.current.getContext('2d')?.drawImage(buffer, 0, 0)
      setRendering(false)
    }).catch(error => { if (active && error.name !== 'RenderingCancelledException') { setError('PDF 页面显示失败：' + error.message); setRendering(false) } })
    return () => { active = false; cancel?.() }
  }, [document, page, frame, fit, zoom])
  function changeZoom(delta: number) { setFit('custom'); setZoom(value => Math.max(.5, Math.min(3, (fit === 'custom' ? value : 1) + delta))) }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && expanded) { setExpanded(false); event.preventDefault() }
    if (event.key === 'Tab' && expanded) {
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select')
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && event.target === first) { last?.focus(); event.preventDefault() }
      else if (!event.shiftKey && event.target === last) { first?.focus(); event.preventDefault() }
    }
    if ((event.target as HTMLElement).matches('input,select,textarea')) return
    if (event.key === 'ArrowLeft' && page > 1) { onPageChange(page - 1); event.preventDefault() }
    if (event.key === 'ArrowRight' && document && page < document.numPages) { onPageChange(page + 1); event.preventDefault() }
  }
  return <div className={'pdf-document-viewer' + (expanded ? ' expanded' : '')} onKeyDown={onKeyDown} tabIndex={0} aria-label="PDF 阅读器" aria-keyshortcuts="ArrowLeft ArrowRight Escape">
    <div className="pdf-toolbar">
      <div><button className="icon-button" aria-label="上一页" title="上一页" disabled={page <= 1 || !document} onClick={() => onPageChange(page - 1)}><ChevronLeft size={16} /></button>{pageControls ?? <span className="pdf-page-count">{page} / {document?.numPages ?? '…'}</span>}<button className="icon-button" aria-label="下一页" title="下一页" disabled={!document || page >= document.numPages} onClick={() => onPageChange(page + 1)}><ChevronRight size={16} /></button></div>
      {actions && <div className="pdf-source-action">{actions}</div>}
      <div className="pdf-zoom-controls"><button className="icon-button" aria-label="缩小 PDF" title="缩小" disabled={fit === 'custom' && zoom <= .5} onClick={() => changeZoom(-.25)}><ZoomOut size={16} /></button><select aria-label="PDF 显示比例" value={fit} onChange={event => { setFit(event.target.value as typeof fit); setZoom(1) }}><option value="width">适合宽度</option><option value="page">整页显示</option>{fit === 'custom' && <option value="custom">{Math.round(zoom * 100)}%</option>}</select><button className="icon-button" aria-label="放大 PDF" title="放大" disabled={fit === 'custom' && zoom >= 3} onClick={() => changeZoom(.25)}><ZoomIn size={16} /></button><button className="icon-button" aria-label={expanded ? '退出专注阅读' : '专注阅读'} title={expanded ? '退出专注阅读（Esc）' : '专注阅读'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></div>
    </div>
    {error && <div role="alert" className="library-error">{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
    <div className="pdf-canvas-container" ref={container} aria-busy={rendering}>{rendering && !error && <div className="pdf-loading" role="status">正在显示 PDF…</div>}<canvas ref={canvas} role="img" aria-label={'研报 PDF 第 ' + page + ' 页'} style={{ visibility: rendering || error ? 'hidden' : 'visible' }} /></div>
  </div>
}

