import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useId, useMemo, useState } from 'react'

function splitSections(content: string) {
  const sections: { title: string; body: string }[] = []
  let fence = ''
  for (const line of content.split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (marker && (!fence || (marker[1][0] === fence[0] && marker[1].length >= fence.length))) fence = fence ? '' : marker[1]
    const heading = !fence && line.match(/^#{1,3}\s+(.+?)\s*#*\s*$/)
    if (heading) sections.push({ title: heading[1], body: '' })
    else if (!sections.length) sections.push({ title: '', body: line })
    else sections[sections.length - 1].body += '\n' + line
  }
  return sections.filter(section => section.title || section.body.trim())
}

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

export default function ResearchAnswer({ content, conversationId, messageId }: { content: string; conversationId: string; messageId?: string }) {
  const filePrefix = `/api/v1/conversations/${encodeURIComponent(conversationId)}/research-files/`
  const uniqueId = useId()
  const prefix = `answer-${messageId || uniqueId}`
  const sections = useMemo(() => splitSections(content), [content])
  const layered = content.length > 1000 && sections.filter(section => section.title).length >= 3
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
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
  function navigate(index: number) {
    setExpanded(current => ({ ...current, [index]: true }))
    requestAnimationFrame(() => document.getElementById(`${prefix}-${index}`)?.scrollIntoView?.({ block: 'start', behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }))
  }
  return <div className="research-answer">
    {layered ? <><nav className="answer-outline" aria-label="研究答复章节"><span>跳转至</span>{sections.map((section, index) => section.title && <button key={index} type="button" className="text-button" onClick={() => navigate(index)}>{section.title.replace(/[*_`]/g, '')}</button>)}</nav>{sections.map((section, index) => !section.title ? <div key={index}>{renderMarkdown(section.body)}</div> : <details className="answer-section" id={`${prefix}-${index}`} key={index} open={expanded[index] ?? (index === sections.findIndex(item => item.title) || /结论|摘要|核心判断/.test(section.title))} onToggle={event => { const open = event.currentTarget.open; setExpanded(current => current[index] === open ? current : { ...current, [index]: open }) }}><summary>{section.title.replace(/[*_`]/g, '')}</summary>{renderMarkdown(section.body)}</details>)}</> : renderMarkdown(content)}
  </div>
}
