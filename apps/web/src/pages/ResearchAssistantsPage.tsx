import { useEffect, useState } from 'react'
import { ArrowRight, BookOpen, ChartNoAxesCombined, ChevronDown, Factory, Landmark, MessageCircle, Network, Newspaper, ShieldCheck } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type ResearchAssistant } from '../api'
import './research-assistants.css'

const icons = { general: MessageCircle, financial: ChartNoAxesCombined, reports: BookOpen, 'supply-chain': Network, risk: ShieldCheck, 'daily-hotspots': Newspaper, 'policy-tracker': Landmark, 'industry-updates': Factory }
const uses: Record<string, string> = {
  general: '适合公司研究、行业分析和开放式问题', financial: '适合业绩点评、现金流核验和财务质量分析',
  reports: '适合提炼结论、查找原文依据和核对预测', 'supply-chain': '适合梳理供需、关键瓶颈和公司受益证据', risk: '适合检验投资逻辑、寻找反证和设定验证条件',
}

export default function ResearchAssistantsPage({ onUse, busy = false }: { onUse: (id: string, launchMode?: 'immediate' | 'draft', name?: string) => void; busy?: boolean }) {
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
  const tasks = items.filter(item => item.launch_mode === 'immediate')
  const methods = items.filter(item => item.launch_mode !== 'immediate')
  const card = (item: ResearchAssistant) => {
    const Icon = icons[item.id as keyof typeof icons] || MessageCircle
    const immediate = item.launch_mode === 'immediate'
    return <article key={item.id} className={`assistant-option${immediate ? ' assistant-option-immediate' : ''}`} aria-label={item.name}>
      <header className="assistant-option-heading">
        <span className="assistant-option-icon"><Icon size={22} strokeWidth={1.6} aria-hidden="true" /></span>
        <div><h3>{item.name}</h3><p>{item.description}</p></div>
      </header>
      <footer className="assistant-option-footer">
        <details className="assistant-option-details">
          <summary>{immediate ? '查看说明' : '研究方法'}<ChevronDown size={13} aria-hidden="true" /></summary>
          <div className="assistant-option-method">{immediate
            ? <p>{item.launch_description || item.description}</p>
            : <><p>{uses[item.id] || '使用预设研究方法处理你的问题'}</p><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.instructions.replace(/^# [^\n]+\n+/, '')}</ReactMarkdown></>}</div>
        </details>
        <button type="button" className="assistant-option-start" aria-label={`使用${item.name}`} disabled={immediate && busy} onClick={() => immediate ? onUse(item.id, 'immediate', item.name) : onUse(item.id)}>
          {immediate ? item.launch_label || '开始研究' : '开始对话'}<ArrowRight size={15} aria-hidden="true" />
        </button>
      </footer>
    </article>
  }

  return <div className="page-content assistant-catalog">
    <header className="page-heading"><h1>研究助手</h1></header>
    {error && <div className="library-error" role="alert"><span>{error}</span><button className="text-button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>}
    {loading && !items.length && <p role="status">正在读取助手…</p>}
    <div className="assistant-catalog-content">
    {!!tasks.length && <section className="assistant-catalog-section" aria-label="即用助手">
      <div className="assistant-section-heading"><h2>即用助手</h2><p>自动检索，保存到对话</p></div>
      <div className="assistant-options assistant-options-immediate">{tasks.map(card)}</div>
    </section>}
    {!!methods.length && <section className="assistant-catalog-section" aria-label="研究方法">
      <div className="assistant-section-heading"><h2>专题研究</h2><p>输入问题，开始分析</p></div>
      <div className="assistant-options assistant-options-methods">{methods.map(card)}</div>
    </section>}
    {!loading && !error && !items.length && <p className="page-description">助手暂不可用，请重新读取。<button className="text-button" onClick={() => setReload(value => value + 1)}>重试</button></p>}
    </div>
  </div>
}
