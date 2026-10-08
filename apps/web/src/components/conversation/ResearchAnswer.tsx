import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
function researchUrl(url: string, conversationId: string) {
  const normalized = url.replace(/\\/g, '/')
  const absolutePrefix = `/research/${conversationId}/work/outputs/`
  const position = normalized.indexOf(absolutePrefix)
  const relative = normalized.startsWith('outputs/') ? normalized.slice(8)
    : normalized.startsWith('./outputs/') ? normalized.slice(10)
      : position >= 0 ? normalized.slice(position + absolutePrefix.length) : null
  if (relative !== null) {
    const parts = relative.split('/')
    if (parts.some(part => !part || part === '.' || part === '..')) return ''
    return `/api/v1/conversations/${encodeURIComponent(conversationId)}/research-files/${parts.map(encodeURIComponent).join('/')}`
  }
  return defaultUrlTransform(url)
}

export default function ResearchAnswer({ content, conversationId }: { content: string; conversationId: string; messageId?: string }) {
  const filePrefix = `/api/v1/conversations/${encodeURIComponent(conversationId)}/research-files/`
  const renderMarkdown = (body: string) => <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={url => researchUrl(url, conversationId)} components={{
      h1: ({ children }) => <h3>{children}</h3>,
      h2: ({ children }) => <h3>{children}</h3>,
      h3: ({ children }) => <h4>{children}</h4>,
      table: ({ children }) => <div className="research-answer-table"><table>{children}</table></div>,
      pre: ({ children }) => <details className="research-answer-code"><summary>代码与数据</summary><pre>{children}</pre></details>,
      a: ({ href, children }) => {
        const download = href?.startsWith(filePrefix)
        const external = /^https?:\/\//i.test(href || '')
        return <a href={href || undefined} download={download || undefined} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>{children}</a>
      },
      img: ({ src, alt }) => /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(src || '')
        ? <img src={src?.startsWith(filePrefix) ? src.replace('/research-files/', '/research-assets/') : src} alt={alt || '研究图表'} loading="lazy" />
        : <a href={src || undefined}>{alt || '查看图表'}</a>,
    }}>{body}</ReactMarkdown>
  return <div className="research-answer">{renderMarkdown(content)}</div>
}
