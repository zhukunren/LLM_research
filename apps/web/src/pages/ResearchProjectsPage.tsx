import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Archive, ArrowUpRight, Building2, Download, FileText, FolderOpen, MessageCircle, Pencil, Plus, RefreshCw, X } from 'lucide-react'
import { api, type Conversation, type ConversationScope } from '../api'
import { isText, useSessionState } from '../useSessionState'
import StockSearch, { StockName } from '../components/StockSearch'
import ResearchAnswer from '../components/conversation/ResearchAnswer'
import ResearchNoteHistory from '../components/ResearchNoteHistory'
import { noteStatuses, type ResearchProject, type ResearchProjectSummary, type ResearchNote, type ResearchFile } from '../research'

const time = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
type NoteDraft = Pick<ResearchNote, 'title' | 'body' | 'stock_code' | 'validation_plan' | 'invalidation_condition' | 'status'> & { base_revision: number; request_id: string }
const draftFor = (note?: ResearchNote): NoteDraft => ({
  title: note?.title || '', body: note?.body || '', stock_code: note?.stock_code || null,
  validation_plan: note?.validation_plan || '', invalidation_condition: note?.invalidation_condition || '',
  status: note?.status || 'watching', base_revision: note?.revision || 1, request_id: crypto.randomUUID(),
})

function validDrafts(value: unknown): value is Record<string, NoteDraft> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(item => item && typeof item === 'object'
    && ['title', 'body', 'validation_plan', 'invalidation_condition', 'request_id'].every(key => typeof item[key] === 'string')
    && (item.stock_code === null || typeof item.stock_code === 'string')
    && typeof item.base_revision === 'number' && Number.isInteger(item.base_revision) && item.base_revision > 0
    && Object.prototype.hasOwnProperty.call(noteStatuses, item.status))
}

function ProjectForm({ project, onSaved, onCancel }: { project?: ResearchProject; onSaved: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(project?.name || '')
  const [objective, setObjective] = useState(project?.objective || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const attempt = useRef<{ key: string; id: string } | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    const key = JSON.stringify([name.trim(), objective.trim()])
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
    try {
      const saved = await api<ResearchProject>(`/research-projects${project ? `/${project.id}` : ''}`, {
        method: project ? 'PATCH' : 'POST', body: JSON.stringify({ name, objective, ...(project ? { base_revision: project.revision, status: project.status } : { request_id: attempt.current.id }) }),
      })
      onSaved(saved.id)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  return <form className="research-project-form" onSubmit={event => void submit(event)} aria-label={project ? '编辑研究项目' : '新建研究项目'}>
    <h2>{project ? '编辑项目' : '新建研究项目'}</h2>
    <label>项目名称<input aria-label="项目名称" value={name} maxLength={100} required onChange={event => setName(event.target.value)} placeholder="如：白酒盈利改善" /></label>
    <label>研究目标<textarea aria-label="研究目标" value={objective} maxLength={8000} rows={3} onChange={event => setObjective(event.target.value)} placeholder="想验证什么，关注哪些变化？" /></label>
    {error && <p className="research-error" role="alert">{error}</p>}
    <div className="heading-actions"><button className="primary-button" disabled={busy || !name.trim()} type="submit">{busy ? '保存中…' : '保存项目'}</button><button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>取消</button></div>
  </form>
}

function NoteEditor({ project, note, onSaved, onCancel }: { project: ResearchProject; note?: ResearchNote; onSaved: () => void; onCancel: () => void }) {
  const key = `${project.id}:${note?.id || 'new'}`
  const [drafts, setDrafts] = useSessionState<Record<string, NoteDraft>>('research.noteDrafts', {}, validDrafts)
  const initial = useRef(draftFor(note))
  const draft = drafts[key] || initial.current
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [latest, setLatest] = useState<ResearchNote | null>(null)
  const change = (values: Partial<NoteDraft>) => setDrafts(current => ({ ...current, [key]: { ...draft, ...values } }))
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setLatest(null)
    const { request_id, base_revision, ...content } = draft
    try {
      await api(`/research-projects/${project.id}/notes${note ? `/${note.id}` : ''}`, {
        method: note ? 'PATCH' : 'POST', body: JSON.stringify({ ...content, ...(note ? { base_revision } : { request_id }) }),
      })
      setDrafts(current => { const next = { ...current }; delete next[key]; return next })
      onSaved()
    } catch (reason) {
      setError((reason as Error).message)
      if (note) {
        try {
          const current = await api<ResearchProject>(`/research-projects/${project.id}`)
          const updated = current.notes.find(item => item.id === note.id)
          if (updated && updated.revision !== draft.base_revision) setLatest(updated)
        } catch { /* Keep the original error and the unsaved draft. */ }
      }
    } finally { setBusy(false) }
  }
  return <form className="research-note-editor" aria-label="编辑研究笔记" onSubmit={event => void save(event)}>
    <label>标题<input aria-label="笔记标题" value={draft.title} maxLength={200} required onChange={event => change({ title: event.target.value })} /></label>
    <div className="research-editor-fields">
      <label>关联公司<select aria-label="笔记关联公司" value={draft.stock_code || ''} onChange={event => change({ stock_code: event.target.value || null })}><option value="">整个研究项目</option>{note?.stock_code && !project.companies.some(item => item.stock_code === note.stock_code) && <option value={note.stock_code}>{note.stock_code}（原关联公司）</option>}{project.companies.map(item => <option value={item.stock_code} key={item.stock_code}>{item.name || item.stock_code}</option>)}</select></label>
      <label>观点状态<select aria-label="观点状态" value={draft.status} onChange={event => change({ status: event.target.value as ResearchNote['status'] })}>{Object.entries(noteStatuses).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    </div>
    <label>研究内容<textarea aria-label="研究内容" rows={10} value={draft.body} maxLength={100000} onChange={event => change({ body: event.target.value })} placeholder="记录判断、数据、来源和反方理由，支持 Markdown。" /></label>
    <div className="research-editor-fields">
      <label>接下来验证什么<textarea aria-label="验证事项" rows={3} value={draft.validation_plan} maxLength={4000} onChange={event => change({ validation_plan: event.target.value })} /></label>
      <label>什么情况说明判断失效<textarea aria-label="失效条件" rows={3} value={draft.invalidation_condition} maxLength={4000} onChange={event => change({ invalidation_condition: event.target.value })} /></label>
    </div>
    {error && <p className="research-error" role="alert">{error}</p>}
    {latest && <section className="research-note-conflict"><h3>另一处保存的最新内容</h3><p>{latest.title} · {noteStatuses[latest.status]}</p><ResearchAnswer content={latest.body} conversationId={latest.source_conversation_id || ''} /><p>验证事项：{latest.validation_plan || '未填写'}<br />失效条件：{latest.invalidation_condition || '未填写'}</p><button className="secondary-button" type="button" onClick={() => { change({ base_revision: latest.revision }); setLatest(null); setError('已保留你的输入。请结合最新内容修改，核对后保存。') }}>继续合并我的修改</button></section>}
    <div className="heading-actions"><button className="primary-button" disabled={busy || !draft.title.trim() || !!latest} type="submit">{busy ? '保存中…' : '保存笔记'}</button><button className="secondary-button" disabled={busy} type="button" onClick={onCancel}>关闭编辑</button><span className="research-secondary">关闭编辑后仍保留当前输入</span></div>
  </form>
}

export default function ResearchProjectsPage({ initialProjectId, onOpenConversation }: { initialProjectId?: string; onOpenConversation: (id: string, scope: ConversationScope) => void }) {
  const [projects, setProjects] = useState<ResearchProjectSummary[]>([])
  const [selectedId, setSelectedId] = useSessionState('research.selectedProject', '', isText)
  const [project, setProject] = useState<ResearchProject | null>(null)
  const [files, setFiles] = useState<ResearchFile[]>([])
  const [tab, setTab] = useState<'notes' | 'conversations' | 'files'>('notes')
  const [form, setForm] = useState<'new' | 'edit' | null>(null)
  const [editing, setEditing] = useState<ResearchNote | 'new' | null>(null)
  const [company, setCompany] = useState('')
  const [companyFilter, setCompanyFilter] = useState('')
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fileError, setFileError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { if (initialProjectId) { setSelectedId(initialProjectId); setIncludeArchived(true) } }, [initialProjectId])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    api<{ items: ResearchProjectSummary[] }>('/research-projects', { signal: controller.signal })
      .then(result => { setProjects(result.items); if (!selectedId && result.items.length) setSelectedId(result.items.find(item => item.status === 'active')?.id || result.items[0].id) })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload])
  useEffect(() => {
    if (!selectedId) { setProject(null); setFiles([]); return }
    const controller = new AbortController()
    setProject(null); setFiles([]); setError(''); setFileError('')
    api<ResearchProject>(`/research-projects/${selectedId}`, { signal: controller.signal }).then(setProject)
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
    api<{ items: ResearchFile[] }>(`/research-projects/${selectedId}/files`, { signal: controller.signal }).then(result => setFiles(result.items))
      .catch(reason => { if (!controller.signal.aborted) setFileError((reason as Error).message) })
    return () => controller.abort()
  }, [selectedId, reload])
  function select(id: string) { setSelectedId(id); setEditing(null); setForm(null); setCompany(''); setCompanyFilter(''); setNotice('') }
  function saved(id: string) { setSelectedId(id); setForm(null); setReload(value => value + 1); setNotice('研究项目已保存。') }
  async function mutate(path: string, init: RequestInit, message: string) {
    setBusy(true); setError('')
    try { await api(path, init); setReload(value => value + 1); setNotice(message) }
    catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  async function startResearch() {
    if (!project) return
    setBusy(true); setError('')
    try {
      const conversation = await api<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ entry_scope: 'screening', research_mode: 'research', project_id: project.id }) })
      onOpenConversation(conversation.id, conversation.entry_scope)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  const displayed = projects.filter(item => (includeArchived || item.status === 'active') && `${item.name} ${item.objective}`.toLowerCase().includes(query.trim().toLowerCase()))
  const writable = project?.status === 'active'
  return <div className="page-content research-project-page">
    <div className="page-heading"><h1>研究中心</h1><div className="heading-actions"><button className="secondary-button" disabled={busy} onClick={() => setReload(value => value + 1)} aria-label="刷新研究中心"><RefreshCw size={15} /></button><button className="primary-button" disabled={busy} onClick={() => { setForm('new'); setEditing(null) }}><Plus size={15} />新建项目</button></div></div>
    {error && <div role="alert" className="research-error">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试加载</button></div>}
    {notice && <p role="status" className="research-notice">{notice}</p>}
    <div className="research-project-layout">
      <aside className="research-project-list" aria-label="研究项目列表">
        <input aria-label="搜索研究项目" placeholder="搜索研究主题" value={query} onChange={event => setQuery(event.target.value)} />
        <label className="research-archive-toggle"><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />显示已归档项目</label>
        {loading ? <p role="status">正在加载项目…</p> : displayed.length ? displayed.map(item => <button key={item.id} className={`research-project-row ${selectedId === item.id ? 'selected' : ''}`} aria-current={selectedId === item.id ? 'true' : undefined} disabled={busy} onClick={() => select(item.id)}><FolderOpen size={17} /><span><strong>{item.name}</strong><small>{item.company_count} 家公司 · {item.note_count} 份笔记{item.status === 'archived' ? ' · 已归档' : ''}</small></span></button>) : <p className="research-secondary">{projects.length ? '没有符合条件的项目。' : '创建一个项目，持续整理研究目标、公司和结论。'}</p>}
      </aside>
      <section className="research-project-detail" aria-label="当前研究项目">
        {form ? <ProjectForm key={form === 'edit' ? project?.id : 'new'} project={form === 'edit' ? project || undefined : undefined} onSaved={saved} onCancel={() => setForm(null)} /> : project ? <>
          <div className="research-project-heading"><div><span className="research-secondary">{project.status === 'archived' ? '已归档项目' : '持续研究项目'}</span><h2>{project.name}</h2></div><div className="heading-actions"><button className="secondary-button" disabled={busy} onClick={() => setForm('edit')} aria-label="编辑项目"><Pencil size={15} /></button><button className="secondary-button" disabled={busy} onClick={() => void mutate(`/research-projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ base_revision: project.revision, name: project.name, objective: project.objective, status: writable ? 'archived' : 'active' }) }, writable ? '项目已归档，研究内容保留。' : '项目已恢复。')}><Archive size={15} />{writable ? '归档' : '恢复'}</button><button className="primary-button" disabled={busy || !writable} onClick={() => void startResearch()}><MessageCircle size={15} />开始研究</button></div></div>
          {project.objective && <p className="research-project-objective">{project.objective}</p>}
          <section className="research-project-companies" aria-label="关联公司">
            <div className="research-section-heading"><h3><Building2 size={16} />关联公司</h3>{writable && <div className="research-add-company"><StockSearch label="选择关联公司" value={company} disabled={busy} onChange={setCompany} /><button className="secondary-button" disabled={busy || !/^\d{6}\.(SH|SZ|BJ)$/.test(company)} onClick={() => { void mutate(`/research-projects/${project.id}/companies`, { method: 'POST', body: JSON.stringify({ stock_code: company }) }, '公司已加入项目。'); setCompany('') }}><Plus size={14} />加入</button></div>}</div>
            {project.companies.length ? <div className="research-company-list">{project.companies.map(item => <div key={item.stock_code} className={`research-company ${companyFilter === item.stock_code ? 'selected' : ''}`}><button className="text-button" aria-pressed={companyFilter === item.stock_code} onClick={() => { setCompanyFilter(value => value === item.stock_code ? '' : item.stock_code); setTab('notes') }}><StockName code={item.stock_code} /></button>{writable && <button className="icon-button" aria-label={`移除公司 ${item.name || item.stock_code}`} disabled={busy} onClick={() => { if (companyFilter === item.stock_code) setCompanyFilter(''); void mutate(`/research-projects/${project.id}/companies/${item.stock_code}`, { method: 'DELETE' }, '公司已移出项目，原笔记和研究内容仍保留。') }}><X size={13} /></button>}</div>)}</div> : <p className="research-secondary">可加入需要持续比较的公司；项目也可以只围绕一个行业或问题展开。</p>}
          </section>
          <div className="research-project-tabs" role="tablist" aria-label="项目内容">{([['notes', '研究笔记', FileText], ['conversations', '研究对话', MessageCircle], ['files', '研究成果', Download]] as const).map(([value, label, Icon]) => <button key={value} type="button" id={`research-tab-${value}`} role="tab" aria-controls={`research-panel-${value}`} aria-selected={tab === value} onClick={() => { setTab(value); setEditing(null) }}><Icon size={15} />{label}<span>{value === 'notes' ? project.notes.length : value === 'conversations' ? project.conversations.length : files.length}</span></button>)}</div>
          <section id={`research-panel-${tab}`} role="tabpanel" aria-labelledby={`research-tab-${tab}`}>
            {tab === 'notes' && <>
              <div className="research-section-heading"><p className="research-secondary">观点状态由你维护，保存的答复保留原对话出处。</p>{writable && !editing && <button className="secondary-button" onClick={() => setEditing('new')}><Plus size={14} />写研究笔记</button>}</div>
              {companyFilter && <p>只看 <StockName code={companyFilter} /> 的笔记 <button className="text-button" onClick={() => setCompanyFilter('')}>查看全部</button></p>}
              {editing && writable ? <NoteEditor key={typeof editing === 'string' ? `${project.id}:new` : editing.id} project={project} note={typeof editing === 'string' ? undefined : editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setReload(value => value + 1); setNotice('研究笔记已保存。') }} /> : project.notes.filter(note => !companyFilter || note.stock_code === companyFilter).map(note => <article className="research-note" key={note.id}><div className="research-note-heading"><h3>{note.title}</h3><div className="heading-actions"><span className={`research-note-status ${note.status}`}>{noteStatuses[note.status]}</span>{writable && <button className="icon-button" aria-label={`编辑笔记 ${note.title}`} onClick={() => setEditing(note)}><Pencil size={15} /></button>}</div></div><div className="research-note-meta">{note.stock_code && <StockName code={note.stock_code} />}<time>{time(note.updated_at)}</time>{note.source_conversation_id && <button className="text-button" onClick={() => {
                const source = project.conversations.find(item => item.id === note.source_conversation_id)
                if (source) onOpenConversation(source.id, source.entry_scope)
                else void api<Conversation>(`/conversations/${note.source_conversation_id}`).then(value => onOpenConversation(value.id, value.entry_scope)).catch(reason => setError((reason as Error).message))
              }}>查看原对话<ArrowUpRight size={13} /></button>}</div><ResearchAnswer content={note.body} conversationId={note.source_conversation_id || ''} />{(note.validation_plan || note.invalidation_condition) && <dl className="research-note-checks">{note.validation_plan && <><dt>接下来验证</dt><dd>{note.validation_plan}</dd></>}{note.invalidation_condition && <><dt>判断失效条件</dt><dd>{note.invalidation_condition}</dd></>}</dl>}<ResearchNoteHistory key={`${note.id}:${note.revision}`} projectId={project.id} noteId={note.id} /></article>)}
              {!editing && !project.notes.some(note => !companyFilter || note.stock_code === companyFilter) && <div className="research-empty"><FileText size={23} /><p>{companyFilter ? '这家公司还没有关联笔记。' : '写下第一个判断，或在研究对话中把助手答复保存为笔记。'}</p></div>}
            </>}
            {tab === 'conversations' && (project.conversations.length ? <div className="research-conversation-list">{project.conversations.map(item => <button className="research-conversation-row" key={item.id} onClick={() => onOpenConversation(item.id, item.entry_scope)}><MessageCircle size={17} /><span><strong>{item.title || '新研究'}</strong><small>{item.last_turn_state === 'running' || item.last_turn_state === 'awaiting_agent' ? '正在研究' : item.last_turn_state === 'failed' ? '研究中断' : '研究对话'} · {time(item.updated_at)}</small></span><ArrowUpRight size={16} /></button>)}</div> : <div className="research-empty"><MessageCircle size={23} /><p>从这里开始研究，新对话将自动归入本项目。已有对话也可以在助手页面选择所属项目。</p></div>)}
            {tab === 'files' && (fileError ? <p className="research-error" role="alert">{fileError}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试成果加载</button></p> : files.length ? <div className="research-file-list">{files.map(file => <a key={`${file.conversation_id}:${file.name}`} className="research-file-row" href={file.url} download><FileText size={18} /><span><strong>{file.name}</strong><small>{(file.bytes / 1024).toFixed(1)} KB · {time(new Date(file.modified_at * 1000).toISOString())}</small></span><Download size={16} /></a>)}</div> : <div className="research-empty"><Download size={23} /><p>研究生成的表格、图表和报告会汇集到这里。</p></div>)}
          </section>
        </> : !loading && !projects.length ? <div className="research-empty"><FolderOpen size={28} /><h2>从一个研究问题开始</h2><p>保存研究目标，持续积累公司的资料、计算与判断。</p><button className="primary-button" onClick={() => setForm('new')}>创建第一个项目</button></div> : !error && <p role="status">正在读取研究项目…</p>}
      </section>
    </div>
  </div>
}
