import { useEffect, useState } from 'react'
import { ArrowRight, ArrowUpRight, Clock3, FileText, FolderOpen, ListFilter, MessageCircle, RefreshCw, Star } from 'lucide-react'
import { api, conversationWorkflow, type ConversationScope, type DataStatus, type WorkflowType } from '../api'
import { workspaceLibraryMenus, type PageId } from '../navigation'
import type { ResearchProjectSummary } from '../research'
import { isText, useSessionState } from '../useSessionState'

type RecentConversation = { id: string; title: string | null; entry_scope: ConversationScope; workflow_type?: WorkflowType; research_mode?: string; task_revision?: number; last_turn_state: string | null; updated_at: string }
type RecentRun = { id: string; name: string; signal_date: string; status: string; counts: { true_count?: number } }
type PendingCandidate = { id: string; name: string; stock_code: string; note: string; verification: string; status: string }
type Resource<T> = { items: T[]; loading: boolean; error: string }
const emptyResource = <T,>(): Resource<T> => ({ items: [], loading: true, error: '' })
const timeLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const scopeLabels: Record<ConversationScope, string> = { screening: '综合研究', technical: '行情研究', news: '资讯研究', report: '研报研究', pattern: '形态研究' }
const runStates: Record<string, string> = { queued: '排队中', running: '执行中', succeeded: '已完成', partial: '部分数据不足', failed: '执行失败', cancelled: '已取消' }
const conversationStates: Record<string, string> = { awaiting_agent: '排队中', running: '处理中', succeeded: '已完成', awaiting_user: '待补充', failed: '需重试', cancelled: '已停止' }

export default function WorkspaceHome({ data, onNavigate, onNewResearch, onResearch, onProject, onConversation, onObservation, onSettings, onCandidate }: {
  data: DataStatus | null; onNavigate: (page: PageId) => void; onNewResearch: () => void; onResearch: (prompt: string) => void; onProject: (id: string) => void
  onConversation: (id: string, scope: ConversationScope) => void; onObservation: (id: string) => void; onSettings: () => void
  onCandidate?: (id: string) => void
}) {
  const [draft] = useSessionState('home.researchDraft', '', isText)
  const [projects, setProjects] = useState<Resource<ResearchProjectSummary>>(emptyResource)
  const [conversations, setConversations] = useState<Resource<RecentConversation>>(emptyResource)
  const [runs, setRuns] = useState<Resource<RecentRun>>(emptyResource)
  const [pendingCandidates, setPendingCandidates] = useState<Resource<PendingCandidate>>(emptyResource)
  const [reload, setReload] = useState(0)
  const [companyEntryOpen, setCompanyEntryOpen] = useState(false)
  const [companyName, setCompanyName] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    async function load<T>(path: string, update: (value: Resource<T>) => void) {
      update({ items: [], loading: true, error: '' })
      try {
        const result = await api<{ items: T[] }>(path, { signal: controller.signal })
        if (!Array.isArray(result.items)) throw new Error('工作记录格式异常，请重试加载。')
        if (!controller.signal.aborted) update({ items: result.items, loading: false, error: '' })
      }
      catch (reason) { if (!controller.signal.aborted) update({ items: [], loading: false, error: (reason as Error).message }) }
    }
    void load('/research-projects', setProjects)
    void load('/conversations?limit=6', setConversations)
    void load('/observation/runs?limit=3&offset=0', setRuns)
    void load('/observation/research-candidates?limit=3&sort=verification', setPendingCandidates)
    return () => controller.abort()
  }, [reload])
  const activeProjects = projects.items.filter(item => item.status === 'active')
  const candidatesToComplete = pendingCandidates.items.filter(item => item.id && item.stock_code && item.status !== 'ended' && !item.verification?.trim())
  const latest = conversations.items[0]
  const resources = [projects, conversations, runs, pendingCandidates]
  const historyLoading = resources.some(resource => resource.loading)
  const historyFailed = resources.some(resource => resource.error)
  const firstVisit = !historyLoading && !historyFailed && resources.every(resource => resource.items.length === 0) && !draft.trim()
  const latestWorkflow = latest ? conversationWorkflow(latest) : null
  const qualityLabel = data?.quality_status === 'basic_checks_passed' ? '基础质量检查通过' : data?.quality_status === 'issues_found' ? '基础质量检查发现异常' : '基础质量待检查'
  const formallyReady = data?.available && data?.quality_status === 'basic_checks_passed' && data?.formal_execution_ready === true && !data?.formal_blockers?.length
  const readinessLabel = formallyReady ? '正式选股已就绪' : data?.formal_execution_ready === false || data?.formal_blockers?.length || data?.quality_status === 'issues_found' ? '正式选股尚未就绪' : '正式选股就绪状态待确认'
  function failure(error: string) { return <div className="home-resource-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => setReload(value => value + 1)}>重试加载</button></div> }

  return <div className="page-content workspace-home">
    <div className="home-heading"><div><h1>{firstVisit ? '你想先完成哪件事？' : '首页'}</h1></div><button className="icon-button" aria-label="刷新首页" title="刷新首页" onClick={() => setReload(value => value + 1)}><RefreshCw size={18} /></button></div>
    {latest && <section className="home-resume" aria-label="继续最近工作"><div><span className="workspace-eyebrow">接着上次继续</span><h2>{latest.title || '未命名对话'}</h2><p>{conversationStates[latest.last_turn_state || ''] || (latestWorkflow === 'screening' ? '选股草稿' : '研究草稿')} · {timeLabel(latest.updated_at)}</p></div><button className="primary-button" onClick={() => onConversation(latest.id, latest.entry_scope)}>{latestWorkflow === 'screening' ? '继续上次选股' : '继续上次研究'}<ArrowRight size={16} /></button></section>}
    <nav className="home-task-choices" aria-label={firstVisit ? '选择第一项任务' : '工作快捷入口'}>
      <button className="home-task-choice" onClick={() => firstVisit ? setCompanyEntryOpen(true) : onNewResearch()}><MessageCircle size={22} /><span><strong>{firstVisit ? '研究一家公司' : '开始研究'}</strong></span><ArrowRight size={17} /></button>
      <button className="home-task-choice" onClick={() => onNavigate('conditions')}><ListFilter size={22} /><span><strong>按条件找股票</strong></span><ArrowRight size={17} /></button>
      <button className="home-task-choice" onClick={() => onNavigate('reports')}><FileText size={22} /><span><strong>读懂一份材料</strong></span><ArrowRight size={17} /></button>
    </nav>
    {companyEntryOpen && firstVisit && <form className="home-company-entry" aria-label="准备公司研究" onSubmit={event => {
      event.preventDefault()
      if (companyName.trim()) onResearch(`请研究 ${companyName.trim()}：主营业务是什么，近期有哪些变化，需要核对哪些关键证据？`)
    }}><label htmlFor="home-company-name">公司名称或证券代码</label><div><input autoFocus id="home-company-name" value={companyName} maxLength={120} onChange={event => setCompanyName(event.target.value)} /><button className="primary-button" type="submit" disabled={!companyName.trim()}>准备研究问题<ArrowRight size={15} /></button></div></form>}
    {historyLoading && !latest && <p className="home-history-status" role="status">正在读取已有工作…</p>}
    {historyFailed && <p className="home-history-status">部分工作记录暂时无法读取。</p>}
    {draft.trim() && <section className="home-pending-question" aria-label="未发送的研究问题"><div><strong>你还有一个未发送的问题</strong><p>{draft}</p></div><button className="secondary-button" onClick={() => onResearch(draft.trim())}>继续未发送的问题<ArrowRight size={14} /></button></section>}
    {!firstVisit && <div className="home-continuation-grid">
      <section className="home-panel home-conversations" aria-label="最近对话"><header><div><Clock3 size={17} /><h2>最近对话</h2></div><button className="text-button" onClick={() => onNavigate('screening')}>查看研究对话<ArrowRight size={13} /></button></header>{conversations.loading ? <p className="home-loading" role="status">正在读取最近对话…</p> : conversations.error ? failure(conversations.error) : conversations.items.length ? <div className="home-recent-list">{conversations.items.slice(0, 5).map(item => <button className="home-recent-row" key={item.id} onClick={() => onConversation(item.id, item.entry_scope)}><span className="home-row-icon"><MessageCircle size={18} /></span><span><strong title={item.title || undefined}>{item.title?.trim() || '未命名对话'}</strong><small>{conversationWorkflow(item) === 'screening' ? '选股对话' : scopeLabels[item.entry_scope]} · {timeLabel(item.updated_at)}</small></span>{item.last_turn_state && <span className={`home-activity-state state-${item.last_turn_state}`}>{conversationStates[item.last_turn_state] || '待查看'}</span>}<ArrowUpRight size={15} /></button>)}</div> : <div className="home-empty"><MessageCircle size={24} /><h3>暂无最近对话</h3></div>}</section>
      <div className="home-right-column">{(pendingCandidates.error || candidatesToComplete.length > 0) && <section className="home-panel" aria-label="待完善验证计划"><header><div><Star size={17} /><h2>待完善验证计划</h2></div><button className="text-button" onClick={() => onCandidate ? onCandidate('') : onNavigate('watchlist')}>打开观察池<ArrowRight size={13} /></button></header>{pendingCandidates.error ? failure(pendingCandidates.error) : <div className="home-project-list">{candidatesToComplete.map(item => <button key={item.id} className="home-project-row" onClick={() => onCandidate ? onCandidate(item.id) : onNavigate('watchlist')}><span><strong>{item.name || item.stock_code}</strong>{item.note && <small>{item.note}</small>}</span><ArrowUpRight size={14} /></button>)}</div>}</section>}<section className="home-panel" aria-label="活跃研究项目"><header><div><FolderOpen size={17} /><h2>研究项目</h2><span className="home-count">{projects.loading || projects.error ? '—' : activeProjects.length}</span></div><button className="text-button" onClick={() => onNavigate('research')}>管理项目<ArrowRight size={13} /></button></header>{projects.loading ? <p className="home-loading" role="status">正在读取项目…</p> : projects.error ? failure(projects.error) : activeProjects.length ? <div className="home-project-list">{activeProjects.slice(0, 3).map(item => <button key={item.id} className="home-project-row" onClick={() => onProject(item.id)}><span><strong>{item.name}</strong><small>{item.company_count} 家公司 · {item.note_count} 份笔记</small></span><ArrowUpRight size={14} /></button>)}</div> : <div className="home-empty compact-empty"><button className="secondary-button" onClick={() => onNavigate('research')}><FolderOpen size={15} />建立研究项目</button></div>}</section>
      <section className="home-panel" aria-label="最近观察批次"><header><div><Star size={17} /><h2>最近观察</h2></div><button className="text-button" onClick={() => onNavigate('watchlist')}>打开观察池<ArrowRight size={13} /></button></header>{runs.loading ? <p className="home-loading" role="status">正在读取观察记录…</p> : runs.error ? failure(runs.error) : runs.items.length ? <div className="home-run-list">{runs.items.map(item => <button key={item.id} className="home-project-row" onClick={() => onObservation(item.id)}><span><strong>{item.name}</strong><small>{item.signal_date} · {runStates[item.status] || item.status}{item.counts.true_count != null ? ' · 入选 ' + item.counts.true_count + ' 只' : ''}</small></span><ArrowUpRight size={14} /></button>)}</div> : <div className="home-empty compact-empty"><h3>暂无观察记录</h3></div>}</section></div>
    </div>}
    {firstVisit && <details className="home-later-tools"><summary>研究项目</summary><button className="text-button" onClick={() => onNavigate('research')}>查看研究项目<ArrowRight size={13} /></button></details>}
    <nav className="home-resources" aria-label="资料快捷入口">{workspaceLibraryMenus.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => onNavigate(id)}><Icon size={18} /><strong>{label}</strong></button>)}</nav>
    <button className="home-data-strip" onClick={onSettings}><span className={'status-dot ' + (formallyReady ? 'good' : 'warning')} /><strong>{data?.available ? '本地行情已载入' : data ? '待添加行情数据' : '正在读取数据状态'}</strong><span>{data ? <>{data.last_date ? '行情截至 ' + data.last_date : '行情日期待确认'}{data.securities ? ' · ' + data.securities.toLocaleString('zh-CN') + ' 个证券' : ''} · {qualityLabel} · {data.available ? readinessLabel : '正式选股尚未就绪'}</> : '查看数据与服务'}</span><ArrowRight size={15} /></button>
  </div>
}
