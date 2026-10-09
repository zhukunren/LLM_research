import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import { useMemo } from 'react'
import remarkGfm from 'remark-gfm'
import remarkCjkStrong from './remarkCjkStrong'
import { StockText } from '../StockMentions'
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
    if (!/\.(xlsx|docx|pptx|csv|tsv|json|txt|md|pdf|png|jpe?g|gif|webp)$/i.test(parts.at(-1)!)) return ''
    return `${conversationPrefix}generated-files/${parts.map(encodeURIComponent).join('/')}`
  }
  if (/\/research\/[^/]+\/work\//.test(normalized) || /^\/api\/v1\/conversations\/[^/]+\/(?:generated-files|research-files)\//.test(normalized)) return ''
  return defaultUrlTransform(url)
}

export default function ResearchAnswer({ content, conversationId }: { content: string; conversationId: string; messageId?: string }) {
  const filePrefix = `/api/v1/conversations/${encodeURIComponent(conversationId)}/generated-files/`
  const components = useMemo<Components>(() => ({
      h1: ({ children }) => <StockText><h3>{children}</h3></StockText>,
      h2: ({ children }) => <StockText><h3>{children}</h3></StockText>,
      h3: ({ children }) => <StockText><h4>{children}</h4></StockText>,
      p: ({ children }) => <StockText><p>{children}</p></StockText>,
      li: ({ children }) => <StockText><li>{children}</li></StockText>,
      td: ({ children }) => <StockText><td>{children}</td></StockText>,
      th: ({ children }) => <StockText><th>{children}</th></StockText>,
      table: ({ children }) => <div className="research-answer-table"><table>{children}</table></div>,
      pre: ({ children }) => <details className="research-answer-code"><summary>代码与数据</summary><pre>{children}</pre></details>,
      a: ({ href, children }) => {
        const download = href?.startsWith(filePrefix)
        const external = /^https?:\/\//i.test(href || '')
        return <StockText><a href={href || undefined} download={download ? true : undefined} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>{children}</a></StockText>
      },
      img: ({ src, alt }) => /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(src || '')
        ? <img src={src?.startsWith(filePrefix) ? src.replace('/generated-files/', '/research-assets/') : src} alt={alt || '研究图表'} loading="lazy" />
        : <a href={src || undefined}>{alt || '查看图表'}</a>,
    }), [filePrefix])
  return <div className="research-answer"><ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkStrong]} urlTransform={url => researchUrl(url, conversationId)} components={components}>{content}</ReactMarkdown></div>
}
