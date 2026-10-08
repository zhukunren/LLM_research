import { useEffect, useState } from 'react'
import { ArrowRight, BookOpen, ChartNoAxesCombined, MessageCircle, Network, ShieldCheck } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type ResearchAssistant } from '../api'
import './research-assistants.css'

const icons = { general: MessageCircle, financial: ChartNoAxesCombined, reports: BookOpen, 'supply-chain': Network, risk: ShieldCheck }
const uses: Record<string, string> = {
  general: '适合公司研究、行业分析和开放式问题', financial: '适合业绩点评、现金流核验和财务质量分析',
  reports: '适合提炼结论、查找原文依据和核对预测', 'supply-chain': '适合梳理供需、关键瓶颈和公司受益证据', risk: '适合检验投资逻辑、寻找反证和设定验证条件',
}

export default function ResearchAssistantsPage({ onUse }: { onUse: (id: string) => void }) {
  const [items, setItems] = useState<ResearchAssistant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    api<{ items: ResearchAssistant[] }>('/research-assistants', { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items)) throw new Error('助手列表暂时无法读取。')
      if (!controller.signal.aborted) setItems(result.items.filter(item => item.builtin && item.enabled))
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload])

  return <div className="page-content assistant-catalog">
    <header className="page-heading"><div><h1>研究助手</h1><p className="page-description">选择一个助手，直接开始研究。</p></div></header>
    {error && <div className="library-error" role="alert"><span>{error}</span><button className="text-button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>}
    {loading && !items.length && <p role="status">正在读取助手…</p>}
    <div className="assistant-catalog-grid">{items.map(item => {
      const Icon = icons[item.id as keyof typeof icons] || MessageCircle
      return <article key={item.id} className="assistant-card" aria-label={item.name}>
        <header><span className="assistant-card-icon"><Icon size={22} strokeWidth={1.6} /></span><div><h2>{item.name}</h2><p>{item.description}</p></div></header>
        <p className="assistant-card-use">{uses[item.id] || '使用预设研究方法处理你的问题'}</p>
        <footer><details><summary>研究方法</summary><div className="assistant-method"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.instructions.replace(/^# [^\n]+\n+/, '')}</ReactMarkdown></div></details><button type="button" className="primary-button" aria-label={`使用${item.name}`} onClick={() => onUse(item.id)}>开始研究<ArrowRight size={15} /></button></footer>
      </article>
    })}</div>
    {!loading && !error && !items.length && <p className="page-description">助手暂不可用，请重新读取。<button className="text-button" onClick={() => setReload(value => value + 1)}>重试</button></p>}
  </div>
}
