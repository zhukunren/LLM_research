import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import { useMemo, useRef } from 'react'
import remarkGfm from 'remark-gfm'
import remarkCjkStrong from './remarkCjkStrong'
import { StockText } from '../StockMentions'
import type { ResearchReadingBrief } from '../../api'
import ResearchSummary from './ResearchSummary'
function researchUrl(url: string, conversationId: string) {
  const normalized = url.replace(/\\/g, '/')
  if (/^https?:\/\//i.test(normalized) || normalized.startsWith('//')) return defaultUrlTransform(url)
  const conversationPrefix = `/api/v1/conversations/${encodeURIComponent(conversationId)}/`
  const absolutePrefix = `/research/${conversationId}/work/outputs/`
  const position = normalized.indexOf(absolutePrefix)
  const localAbsolute = normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || /^(file:\/\/|sandbox:)/i.test(normalized)
  const apiPrefix = [conversationPrefix + 'generated-files/', conversationPrefix + 'research-files/'].find(prefix => normalized.startsWith(prefix))
  const relative = apiPrefix ? normalized.slice(apiPrefix.length) : normalized.startsWith('outputs/') ? normalized.slice(8)
    : normalized.startsWith('./outputs/') ? normalized.slice(10)
      : localAbsolute && position >= 0 ? normalized.slice(position + absolutePrefix.length) : null
  if (relative !== null) {
    let parts: string[]
    try { parts = relative.split('/').map(part => decodeURIComponent(part.replace(/%(?![0-9a-f]{2})/gi, '%25'))) } catch { return '' }
    if (parts.some(part => !part || part.startsWith('.') || /[\\/:\u0000-\u001f\u007f]/.test(part) || /[. ]$/.test(part))) return ''
    if (!/\.(xlsx|docx|pptx|csv|tsv|json|txt|md|pdf|png|jpe?g|gif|webp|py)$/i.test(parts.at(-1)!)) return ''
    return `${conversationPrefix}generated-files/${parts.map(encodeURIComponent).join('/')}`
  }
  if (/\/research\/[^/]+\/work\//.test(normalized) || /^\/api\/v1\/conversations\/[^/]+\/(?:generated-files|research-files)\//.test(normalized)) return ''
  return defaultUrlTransform(url)
}

export default function ResearchAnswer({ content, conversationId, references, summary }: { content: string; conversationId: string; messageId?: string; references?: Record<string, unknown>[]; summary?: ResearchReadingBrief | null }) {
  const filePrefix = `/api/v1/conversations/${encodeURIComponent(conversationId)}/generated-files/`
  const referencesRef = useRef(references)
  referencesRef.current = references
  const components = useMemo<Components>(() => ({
      h1: ({ children }) => <StockText><h3>{children}</h3></StockText>,
      h2: ({ children }) => <StockText><h3>{children}</h3></StockText>,
      h3: ({ children }) => <StockText><h4>{children}</h4></StockText>,
      p: ({ children }) => <StockText><p>{children}</p></StockText>,
      li: ({ children }) => <StockText><li>{children}</li></StockText>,
      td: ({ children }) => <StockText><td>{children}</td></StockText>,
      th: ({ children }) => <StockText><th>{children}</th></StockText>,
      table: ({ children }) => <div className="research-answer-table workspace-table-scroll" tabIndex={0} role="region" aria-label="研究答复表格"><table className="workspace-data-table">{children}</table></div>,
      pre: ({ children }) => <details className="research-answer-code"><summary>代码与数据</summary><pre>{children}</pre></details>,
      a: ({ href, children }) => {
        const source = /^([A-Za-z0-9_-]{1,100})(?:#page=(\d+))?$/.exec(href || '')
        if (source) {
          const pages = (referencesRef.current || []).filter(ref => ref.kind === 'report_page' && ref.source_id === source[1] && typeof ref.page_number === 'number' && Number.isInteger(ref.page_number) && ref.page_number > 0).map(ref => ref.page_number as number)
          const requested = Number(source[2] || /第\s*(\d+)/.exec(String(children))?.[1])
          if (pages.length) href = `/api/v1/documents/${encodeURIComponent(source[1])}/pdf#page=${pages.includes(requested) ? requested : Math.min(...pages)}`
        }
        const download = href?.startsWith(filePrefix)
        const external = /^https?:\/\//i.test(href || '')
        return <StockText><a href={href || undefined} download={download ? true : undefined} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>{children}</a></StockText>
      },
      img: ({ src, alt }) => /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(src || '')
        ? <img src={src?.startsWith(filePrefix) ? src.replace('/generated-files/', '/research-assets/') : src} alt={alt || '研究图表'} loading="lazy" />
        : <a href={src || undefined}>{alt || '查看图表'}</a>,
    }), [filePrefix])
  return <div className="research-answer"><ResearchSummary value={summary} /><ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkStrong]} urlTransform={url => researchUrl(url, conversationId)} components={components}>{content}</ReactMarkdown></div>
}
