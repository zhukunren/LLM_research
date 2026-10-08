import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Archive, ArrowUpRight, Building2, ChevronDown, Download, FileText, FolderOpen, MessageCircle, Pencil, Plus, RefreshCw, X } from 'lucide-react'
import { api, conversationWorkflow, type Conversation, type ConversationScope } from '../api'
import { isText, useSessionState } from '../useSessionState'
import StockSearch, { StockName } from '../components/StockSearch'
import ResearchAnswer from '../components/conversation/ResearchAnswer'
import ResearchNoteHistory from '../components/ResearchNoteHistory'
import ResearchNoteEvidence from '../components/ResearchNoteEvidence'
import CompanyResearchPanel from '../components/CompanyResearchPanel'
import { researchToday } from '../companyResearch'
import { noteStatuses, type ResearchProject, type ResearchProjectSummary, type ResearchNote, type ResearchFile } from '../research'
import { navigateTabs } from '../keyboard'
import SearchField from '../components/SearchField'
import ResearchFileList, { reportPending } from '../components/ResearchFileList'
import ResearchNotePDF from '../components/ResearchNotePDF'

const time = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
type NoteContent = Pick<ResearchNote, 'title' | 'body' | 'stock_code' | 'validation_plan' | 'invalidation_condition' | 'status'>
type NoteSubmission = { request_id: string; content: NoteContent; note_id?: string }
type NoteDraft = NoteContent & { base_revision: number; request_id: string; submission?: NoteSubmission }
const noteContent = (value: NoteContent): NoteContent => ({ title: value.title, body: value.body, stock_code: value.stock_code, validation_plan: value.validation_plan, invalidation_condition: value.invalidation_condition, status: value.status })
const sameNoteContent = (left: NoteContent, right: NoteContent) => JSON.stringify(noteContent(left)) === JSON.stringify(noteContent(right))
const draftFor = (note?: ResearchNote): NoteDraft => ({
  title: note?.title || '', body: note?.body || '', stock_code: note?.stock_code || null,
  validation_plan: note?.validation_plan || '', invalidation_condition: note?.invalidation_condition || '',
  status: note?.status || 'watching', base_revision: note?.revision || 1, request_id: crypto.randomUUID(),
})

function validNoteContent(value: unknown): value is NoteContent {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return ['title', 'body', 'validation_plan', 'invalidation_condition'].every(key => typeof item[key] === 'string')
    && (item.stock_code === null || typeof item.stock_code === 'string')
    && typeof item.status === 'string' && Object.prototype.hasOwnProperty.call(noteStatuses, item.status)
}
function validDrafts(value: unknown): value is Record<string, NoteDraft> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(item => item && typeof item === 'object'
    && ['title', 'body', 'validation_plan', 'invalidation_condition', 'request_id'].every(key => typeof item[key] === 'string')
    && (item.stock_code === null || typeof item.stock_code === 'string')
    && typeof item.base_revision === 'number' && Number.isInteger(item.base_revision) && item.base_revision > 0
    && Object.prototype.hasOwnProperty.call(noteStatuses, item.status)
    && (item.submission === undefined || (item.submission && typeof item.submission.request_id === 'string'
      && validNoteContent(item.submission.content) && (item.submission.note_id === undefined || typeof item.submission.note_id === 'string'))))
}

function ProjectForm({ project, onSaved, onCancel }: { project?: ResearchProject; onSaved: (id: string) => void; onCancel: () => void }) {
  type Draft = { name: string; objective: string; base_revision: number; status: 'active' | 'archived'; request_id: string }
  const key = project?.id || 'new'
  const [drafts, setDrafts] = useSessionState<Record<string, Draft>>('research.projectDrafts', {}, (value): value is Record<string, Draft> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item && typeof item.name === 'string' && typeof item.objective === 'string' && typeof item.request_id === 'string' && Number.isInteger(item.base_revision) && item.base_revision > 0 && ['active', 'archived'].includes(item.status)))
  const initial = useRef<Draft>({ name: project?.name || '', objective: project?.objective || '', base_revision: project?.revision || 1, status: project?.status || 'active', request_id: crypto.randomUUID() })
  const draft = drafts[key] || initial.current
  const { name, objective } = draft
  const change = (value: Partial<Draft>) => setDrafts(current => ({ ...current, [key]: { ...draft, ...value, request_id: crypto.randomUUID() } }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [latest, setLatest] = useState<ResearchProject | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const saved = await api<ResearchProject>(`/research-projects${project ? `/${project.id}` : ''}`, {
        method: project ? 'PATCH' : 'POST', body: JSON.stringify({ name, objective, ...(project ? { base_revision: draft.base_revision, status: draft.status } : { request_id: draft.request_id }) }),
      })
      setDrafts(current => { const next = { ...current }; delete next[key]; return next })
      onSaved(saved.id)
    } catch (reason) {
      setError((reason as Error).message)
      if (project) {
        try { const current = await api<ResearchProject>(`/research-projects/${project.id}`); if (current.revision !== draft.base_revision) setLatest(current) } catch { /* Preserve the draft and the original error. */ }
      }
    }
    finally { setBusy(false) }
  }
  return <form className="research-project-form" onSubmit={event => void submit(event)} aria-label={project ? '编辑研究项目' : '新建研究项目'}>
    <div className="research-form-heading"><h2>{project ? '编辑项目' : '新建研究项目'}</h2></div>
    <label>项目名称<input aria-label="项目名称" disabled={busy} value={name} maxLength={100} required onChange={event => change({ name: event.target.value })} /></label>
    <label>研究目标<textarea aria-label="研究目标" disabled={busy} value={objective} maxLength={8000} rows={3} onChange={event => change({ objective: event.target.value })} /></label>
    {error && <p className="research-error" role="alert">{error}</p>}
    {latest && <section className="research-note-conflict"><h3>另一处保存的最新项目</h3><strong>{latest.name}</strong><p>{latest.objective}</p><button type="button" className="secondary-button" onClick={() => { change({ base_revision: latest.revision, status: latest.status }); setLatest(null); setError('你的输入已保留，请结合最新内容核对后保存。') }}>继续合并我的修改</button></section>}
    <div className="heading-actions"><button className="primary-button" disabled={busy || !name.trim() || !!latest} type="submit">{busy ? '保存中…' : '保存项目'}</button><button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>关闭编辑</button></div>
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
  function saved() {
    setDrafts(current => { const next = { ...current }; delete next[key]; return next })
    onSaved()
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(''); setLatest(null)
    const content = noteContent(draft)
    let targetId = note?.id || draft.submission?.note_id
    let baseRevision = draft.base_revision
    try {
      if (!targetId) {
        // Recover an unknown creation using its original payload and identity
        // before applying any later edits to the same note.
        const submission = draft.submission || { request_id: draft.request_id, content }
        setDrafts(current => ({ ...current, [key]: { ...(current[key] || draft), submission } }))
        const created = await api<ResearchNote>(`/research-projects/${project.id}/notes`, {
          method: 'POST', body: JSON.stringify({ ...submission.content, request_id: submission.request_id }),
        })
        targetId = created.id
        baseRevision = created.revision
        setDrafts(current => ({ ...current, [key]: { ...(current[key] || draft), base_revision: baseRevision, submission: { ...submission, note_id: targetId } } }))
        if (sameNoteContent(content, submission.content)) { saved(); return }
      }
      await api(`/research-projects/${project.id}/notes/${targetId}`, {
        method: 'PATCH', body: JSON.stringify({ ...content, base_revision: baseRevision }),
      })
      saved()
    } catch (reason) {
      setError((reason as Error).message)
      if (targetId || draft.submission) {
        try {
          const current = await api<ResearchProject>(`/research-projects/${project.id}`)
          const updated = current.notes.find(item => targetId ? item.id === targetId : (item as ResearchNote & { request_id?: string }).request_id === draft.submission?.request_id)
          const recoveredCreation = !targetId && !!updated
          if (recoveredCreation && updated && draft.submission) {
            targetId = updated.id
            setDrafts(items => ({ ...items, [key]: { ...(items[key] || draft), submission: { ...draft.submission!, note_id: updated.id } } }))
          }
          // Recognize a committed PATCH whose response was lost, while keeping
          // unrelated concurrent edits behind the existing merge confirmation.
          if (updated && (recoveredCreation || updated.revision > baseRevision) && sameNoteContent(updated, content)) { saved(); return }
          if (updated && (recoveredCreation || updated.revision !== baseRevision)) setLatest(updated)
        } catch { /* Keep the original error and the unsaved draft. */ }
      }
    } finally { setBusy(false) }
  }
  return <form className="research-note-editor" aria-label="编辑研究笔记" onSubmit={event => void save(event)}>
    <div className="research-form-heading"><h3>{note ? '编辑研究笔记' : '写研究笔记'}</h3></div>
    <label>标题<input aria-label="笔记标题" disabled={busy} value={draft.title} maxLength={200} required onChange={event => change({ title: event.target.value })} /></label>
    <div className="research-editor-fields">
      <label>关联公司<select aria-label="笔记关联公司" disabled={busy} value={draft.stock_code || ''} onChange={event => change({ stock_code: event.target.value || null })}><option value="">整个研究项目</option>{note?.stock_code && !project.companies.some(item => item.stock_code === note.stock_code) && <option value={note.stock_code}>{note.stock_code}（原关联公司）</option>}{project.companies.map(item => <option value={item.stock_code} key={item.stock_code}>{item.name || item.stock_code}</option>)}</select></label>
      <label>观点状态<select aria-label="观点状态" disabled={busy} value={draft.status} onChange={event => change({ status: event.target.value as ResearchNote['status'] })}>{Object.entries(noteStatuses).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    </div>
    <label>研究内容<textarea aria-label="研究内容" disabled={busy} rows={10} value={draft.body} maxLength={100000} onChange={event => change({ body: event.target.value })} /></label>
    <div className="research-editor-fields">
      <label>接下来验证什么<textarea aria-label="验证事项" disabled={busy} rows={3} value={draft.validation_plan} maxLength={4000} onChange={event => change({ validation_plan: event.target.value })} /></label>
      <label>什么情况说明判断失效<textarea aria-label="失效条件" disabled={busy} rows={3} value={draft.invalidation_condition} maxLength={4000} onChange={event => change({ invalidation_condition: event.target.value })} /></label>
    </div>
    {error && <p className="research-error" role="alert">{error}</p>}
    {latest && <section className="research-note-conflict"><h3>另一处保存的最新内容</h3><p>{latest.title} · {noteStatuses[latest.status]}</p><ResearchAnswer content={latest.body} conversationId={latest.source_conversation_id || ''} /><p>验证事项：{latest.validation_plan || '未填写'}<br />失效条件：{latest.invalidation_condition || '未填写'}</p><button className="secondary-button" type="button" onClick={() => { change({ base_revision: latest.revision }); setLatest(null); setError('已保留你的输入。请结合最新内容修改，核对后保存。') }}>继续合并我的修改</button></section>}
    <div className="heading-actions"><button className="primary-button" disabled={busy || !draft.title.trim() || !!latest} type="submit">{busy ? '保存中…' : '保存笔记'}</button><button className="secondary-button" disabled={busy} type="button" onClick={onCancel}>关闭编辑</button></div>
  </form>
}

export default function ResearchProjectsPage({ initialProjectId, onOpenConversation, onLocationChange }: { initialProjectId?: string; onOpenConversation: (id: string, scope: ConversationScope) => void; onLocationChange?: (id: string, userNavigation?: boolean) => void }) {
  const [projects, setProjects] = useState<ResearchProjectSummary[]>([])
  const [selectedId, setSelectedId] = useSessionState('research.selectedProject', '', isText)
  const locationCallback = useRef(onLocationChange)
  locationCallback.current = onLocationChange
  const explicitProject = useRef(initialProjectId)
  explicitProject.current = initialProjectId
  const [project, setProject] = useState<ResearchProject | null>(null)
  const [files, setFiles] = useState<ResearchFile[]>([])
  const [tab, setTab] = useState<'notes' | 'conversations' | 'files'>('notes')
  const [form, setForm] = useState<'new' | 'edit' | null>(null)
  const [formProject, setFormProject] = useState<ResearchProject>()
  const [editing, setEditing] = useState<ResearchNote | 'new' | null>(null)
  const [company, setCompany] = useState('')
  const [companyFilter, setCompanyFilter] = useState('')
  const [researchDate, setResearchDate] = useState(researchToday)
  const [query, setQuery] = useState('')
  const [noteQuery, setNoteQuery] = useState('')
  const [noteStatus, setNoteStatus] = useState<ResearchNote['status'] | ''>('')
  const [noteSort, setNoteSort] = useState<'updated' | 'title'>('updated')
  const [openNoteId, setOpenNoteId] = useState<string | null>('')
  useEffect(() => {
    // Browser history changes selection without going through select(). Editors
    // belong to the previous project; their drafts remain in session storage.
    setEditing(null); setForm(null); setFormProject(undefined)
    setCompany(''); setNotice(''); setError('')
    setNoteQuery(''); setNoteStatus(''); setCompanyFilter(''); setOpenNoteId('')
  }, [selectedId])
  const [includeArchived, setIncludeArchived] = useState(false)
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [projectLoading, setProjectLoading] = useState(false)
  const [projectError, setProjectError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fileError, setFileError] = useState('')
  const [filesLoading, setFilesLoading] = useState(false)
  const [reportBusy, setReportBusy] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { if (initialProjectId) { setSelectedId(initialProjectId); setIncludeArchived(true) } }, [initialProjectId])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setCatalogError('')
    api<{ items: ResearchProjectSummary[] }>('/research-projects', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setProjects(result.items); setSelectedId(current => explicitProject.current || (result.items.some(item => item.id === current) ? current : result.items.find(item => item.status === 'active')?.id || result.items[0]?.id || '')) } })
      .catch(reason => { if (!controller.signal.aborted) setCatalogError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload])
  useEffect(() => {
    if (!selectedId) { setProject(null); setFiles([]); setProjectLoading(false); setProjectError(''); return }
    const controller = new AbortController()
    setProject(current => current?.id === selectedId ? current : null); setFiles([]); setProjectError(''); setFileError(''); setFilesLoading(true); setProjectLoading(true)
    api<ResearchProject>(`/research-projects/${selectedId}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setProject(value); locationCallback.current?.(value.id, false) } })
      .catch(reason => { if (!controller.signal.aborted) setProjectError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setProjectLoading(false) })
    api<{ items: ResearchFile[] }>(`/research-projects/${selectedId}/files`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setFiles(result.items) })
      .catch(reason => { if (!controller.signal.aborted) setFileError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setFilesLoading(false) })
    return () => controller.abort()
  }, [selectedId, reload])
  const reportsActive = files.some(file => reportPending(file.status))
  useEffect(() => {
    if (!selectedId || !reportsActive) return
    const controller = new AbortController()
    let reading = false
    const timer = globalThis.setInterval(() => {
      if (reading || controller.signal.aborted) return
      reading = true
      api<{ items: ResearchFile[] }>(`/research-projects/${selectedId}/files`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) { setFiles(result.items); setFileError('') } })
        .catch(reason => { if (!controller.signal.aborted) setFileError((reason as Error).message) })
        .finally(() => { reading = false })
    }, 1500)
    return () => { controller.abort(); globalThis.clearInterval(timer) }
  }, [selectedId, reportsActive])
  async function generateReports(file?: ResearchFile) {
    if (!project) return
    setReportBusy(file?.id || 'generate'); setError('')
    try {
      await api(file?.retry_url ? file.retry_url.replace(/^\/api\/v1/, '') : `/research-projects/${project.id}/research-pdf-jobs`, { method: 'POST', ...(file?.retry_url ? {} : { body: JSON.stringify({ request_id: crypto.randomUUID() }) }) })
      setReload(value => value + 1); setNotice('报告已交给后台生成，研究正文和原件已保留。')
    } catch (reason) { setError((reason as Error).message) }
    finally { setReportBusy('') }
  }
  function select(id: string) { setSelectedId(id); locationCallback.current?.(id, true); setEditing(null); setForm(null); setCompany(''); setCompanyFilter(''); setNotice(''); setError('') }
  function saved(id: string) { setSelectedId(id); locationCallback.current?.(id, true); setForm(null); setReload(value => value + 1); setNotice('研究项目已保存。') }
  async function mutate(path: string, init: RequestInit, message: string) {
    setBusy(true); setError('')
    try { await api(path, init); setReload(value => value + 1); setNotice(message); return true }
    catch (reason) { setError((reason as Error).message); return false }
    finally { setBusy(false) }
  }
  async function startResearch() {
    if (!project) return
    setBusy(true); setError('')
    try {
      const conversation = await api<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ entry_scope: 'screening', workflow_type: 'research', research_depth: 'standard', research_mode: 'research', project_id: project.id }) })
      onOpenConversation(conversation.id, conversation.entry_scope)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  const displayed = projects.filter(item => (includeArchived || item.status === 'active') && `${item.name} ${item.objective}`.toLowerCase().includes(query.trim().toLowerCase()))
  const writable = project?.status === 'active'
  const locked = busy || projectLoading || !!projectError
  const noteMatchesCompany = (note: ResearchNote) => !companyFilter || note.stock_code === companyFilter || note.claim_stock_codes?.includes(companyFilter)

  const visibleNotes = (project?.notes ?? []).filter(note => noteMatchesCompany(note)
    && (!noteStatus || note.status === noteStatus)
    && [note.title, note.body, note.validation_plan, note.invalidation_condition].join(' ').toLowerCase().includes(noteQuery.trim().toLowerCase()))
    .sort((a, b) => noteSort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : b.updated_at.localeCompare(a.updated_at))
  const activeNoteId = openNoteId === null ? null : visibleNotes.some(note => note.id === openNoteId) ? openNoteId : visibleNotes[0]?.id
  const notesFiltered = !!(noteQuery || noteStatus || companyFilter)
  function clearNoteFilters() { setNoteQuery(''); setNoteStatus(''); setCompanyFilter('') }
  return <div className="page-content research-project-page">
    <div className="page-heading"><div><h1>研究项目</h1></div><div className="heading-actions"><button className="secondary-button" disabled={busy || loading} onClick={() => setReload(value => value + 1)} aria-label="刷新研究项目"><RefreshCw size={15} /></button><button className={project || form ? "secondary-button" : "primary-button"} disabled={busy} onClick={() => { setForm('new'); setEditing(null) }}><Plus size={15} />新建项目</button></div></div>
    {error && <div role="alert" className="research-error">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试加载</button></div>}
    {catalogError && <div role="alert" className="research-error">{catalogError}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试项目目录</button></div>}
    {notice && <p role="status" className="research-notice">{notice}</p>}
    <div className={'research-project-layout ' + (projects.length ? '' : 'research-project-layout-solo')}>
      {projects.length > 0 && <aside className="research-project-list" aria-label="研究项目列表">
        <SearchField label="搜索研究项目" placeholder="搜索主题或研究目标" value={query} onChange={setQuery} />
        <label className="research-archive-toggle"><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />显示已归档项目</label>
        <div className="research-project-rows">{loading ? <p role="status">正在加载项目…</p> : displayed.length ? displayed.map(item => <button key={item.id} className={`research-project-row ${selectedId === item.id ? 'selected' : ''}`} aria-current={selectedId === item.id ? 'true' : undefined} disabled={busy} onClick={() => select(item.id)}><FolderOpen size={17} /><span><strong>{item.name}</strong><small>{item.company_count} 家公司 · {item.note_count} 份笔记{item.status === 'archived' ? ' · 已归档' : ''}</small></span></button>) : <p className="research-secondary">{projects.length ? '没有符合条件的项目。' : '暂无研究项目。'}</p>}
        {!loading && projects.length > 0 && !displayed.length && <button className="text-button" onClick={() => { setQuery(''); setIncludeArchived(true) }}>显示全部项目</button>}</div>
      </aside>}
      <section className={'research-project-detail ' + (form ? 'research-detail-editing' : '')} aria-label="当前研究项目" aria-busy={projectLoading}>
        {form ? <ProjectForm key={form === 'edit' ? formProject?.id : 'new'} project={form === 'edit' ? formProject : undefined} onSaved={saved} onCancel={() => setForm(null)} /> : project ? <>
          {projectError && <div className="research-error" role="alert">{projectError}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试项目详情</button></div>}
          <div className="research-project-heading"><div className="research-project-title"><div className="research-project-topline"><span className={'research-project-state ' + project.status}>{project.status === 'archived' ? '已归档' : '进行中'}</span><span>更新于 <time>{time(project.updated_at)}</time></span></div><h2>{project.name}</h2></div><div className="heading-actions"><button className="secondary-button" disabled={busy} onClick={() => { setFormProject(project); setForm('edit') }} aria-label="编辑项目"><Pencil size={15} /></button><button className="secondary-button" disabled={busy} onClick={() => void mutate(`/research-projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ base_revision: project.revision, name: project.name, objective: project.objective, status: writable ? 'archived' : 'active' }) }, writable ? '项目已归档，研究内容保留。' : '项目已恢复。')}><Archive size={15} />{writable ? '归档' : '恢复'}</button><button className={editing ? "secondary-button" : "primary-button"} disabled={locked || !writable} onClick={() => void startResearch()}><MessageCircle size={15} />开始研究</button></div></div>
          {project.objective && <div className="research-project-objective"><span>研究目标</span><p>{project.objective}</p></div>}

          <section className="research-project-companies" aria-label="关联公司">
            <div className="research-section-heading"><h3><Building2 size={16} />关联公司 <span className="research-inline-count">{project.companies.length}</span></h3>{writable && <div className="research-add-company"><StockSearch label="选择关联公司" value={company} disabled={busy} onChange={setCompany} /><button className="secondary-button" disabled={busy || !/^\d{6}\.(SH|SZ|BJ)$/.test(company)} onClick={() => { void mutate(`/research-projects/${project.id}/companies`, { method: 'POST', body: JSON.stringify({ stock_code: company }) }, '公司已加入项目。'); setCompany('') }}><Plus size={14} />加入</button></div>}</div>
            {project.companies.length ? <div className="research-company-list">{project.companies.map(item => <div key={item.stock_code} className={`research-company ${companyFilter === item.stock_code ? 'selected' : ''}`}><button className="text-button" aria-pressed={companyFilter === item.stock_code} onClick={() => { setCompanyFilter(value => value === item.stock_code ? '' : item.stock_code); setTab('notes') }}><StockName code={item.stock_code} /></button>{writable && <button className="icon-button" aria-label={`移除公司 ${item.name || item.stock_code}`} disabled={busy} onClick={() => { if (companyFilter === item.stock_code) setCompanyFilter(''); void mutate(`/research-projects/${project.id}/companies/${item.stock_code}`, { method: 'DELETE' }, '公司已移出项目，原笔记和研究内容仍保留。') }}><X size={13} /></button>}</div>)}</div> : null}
          </section>
          {companyFilter && <CompanyResearchPanel key={`${project.id}:${companyFilter}`} projectId={project.id} code={companyFilter} asOf={researchDate} onDateChange={setResearchDate} />}
          <div className="research-project-tabs" role="tablist" aria-label="项目内容" onKeyDown={event => navigateTabs(event, ['notes', 'conversations', 'files'] as const, tab, value => { setTab(value); setEditing(null) })}>{([['notes', '研究笔记', FileText], ['conversations', '研究对话', MessageCircle], ['files', '研究成果', Download]] as const).map(([value, label, Icon]) => <button key={value} type="button" id={`research-tab-${value}`} role="tab" aria-controls="research-project-panel" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} onClick={() => { setTab(value); setEditing(null) }}><Icon size={15} />{label}<span>{value === 'notes' ? project.notes.length : value === 'conversations' ? project.conversations.length : filesLoading ? '…' : files.length}</span></button>)}</div>
          <section id="research-project-panel" role="tabpanel" aria-labelledby={`research-tab-${tab}`}>
            {tab === 'notes' && <>
              <div className="research-content-heading">{writable && !editing && <button className="secondary-button" onClick={() => setEditing('new')}><Plus size={14} />写研究笔记</button>}</div>

              {!editing && <div className="workspace-filter-bar research-note-filters"><SearchField label="搜索研究笔记" placeholder="搜索标题、正文或验证事项" value={noteQuery} onChange={setNoteQuery} /><select aria-label="筛选笔记状态" value={noteStatus} onChange={event => setNoteStatus(event.target.value as typeof noteStatus)}><option value="">全部观点状态</option>{Object.entries(noteStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="笔记排序" value={noteSort} onChange={event => setNoteSort(event.target.value as typeof noteSort)}><option value="updated">最近更新</option><option value="title">按标题排序</option></select><span className="workspace-result-count" aria-live="polite">{visibleNotes.length} / {project.notes.length} 份笔记</span>{notesFiltered && <button className="text-button" onClick={clearNoteFilters}>重置笔记筛选</button>}</div>}
              {companyFilter && <p>只看 <StockName code={companyFilter} /> 的笔记 <button className="text-button" onClick={() => setCompanyFilter('')}>查看全部</button></p>}
              {editing && writable ? <NoteEditor key={`${project.id}:${typeof editing === 'string' ? 'new' : editing.id}`} project={project} note={typeof editing === 'string' ? undefined : editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setReload(value => value + 1); setNotice('研究笔记已保存。') }} /> : visibleNotes.map(note => <article className={'research-note ' + (activeNoteId === note.id ? 'research-note-open' : '')} key={note.id}><div className="research-note-heading"><h3><button className="research-note-disclosure" aria-expanded={activeNoteId === note.id} aria-controls={'research-note-body-' + note.id} onClick={() => setOpenNoteId(activeNoteId === note.id ? null : note.id)}><ChevronDown size={16} /><span>{note.title}</span></button></h3><div className="heading-actions"><span className={`research-note-status ${note.status}`}>{noteStatuses[note.status]}</span>{writable && <button className="icon-button" aria-label={`编辑笔记 ${note.title}`} onClick={() => setEditing(note)}><Pencil size={15} /></button>}</div></div><div className="research-note-meta">{note.stock_code && <StockName code={note.stock_code} />}<ResearchNotePDF projectId={project.id} noteId={note.id} revision={note.revision} pdf={note.pdf} /><time>{time(note.updated_at)}</time>{note.source_conversation_id && <button className="text-button" onClick={() => {
                const source = project.conversations.find(item => item.id === note.source_conversation_id)
                if (source) onOpenConversation(source.id, source.entry_scope)
                else void api<Conversation>(`/conversations/${note.source_conversation_id}`).then(value => onOpenConversation(value.id, value.entry_scope)).catch(reason => setError((reason as Error).message))
              }}>查看原对话<ArrowUpRight size={13} /></button>}</div><div id={'research-note-body-' + note.id} hidden={activeNoteId !== note.id}><ResearchAnswer content={note.body} conversationId={note.source_conversation_id || ''} />{(note.validation_plan || note.invalidation_condition) && <dl className="research-note-checks">{note.validation_plan && <><dt>接下来验证</dt><dd>{note.validation_plan}</dd></>}{note.invalidation_condition && <><dt>判断失效条件</dt><dd>{note.invalidation_condition}</dd></>}</dl>}<ResearchNoteEvidence key={`evidence:${note.id}:${note.revision}`} project={project} note={note} asOf={researchDate} /><ResearchNoteHistory key={`${note.id}:${note.revision}`} projectId={project.id} noteId={note.id} /></div></article>)}
              {!editing && !visibleNotes.length && <div className="research-empty"><FileText size={23} /><p>{notesFiltered ? '没有符合当前筛选的笔记。' : '暂无研究笔记。'}</p>{notesFiltered && <button className="secondary-button" onClick={clearNoteFilters}>查看全部笔记</button>}</div>}
            </>}
            {tab === 'conversations' && (project.conversations.length ? <div className="research-conversation-list">{project.conversations.map(item => <button className="research-conversation-row" key={item.id} onClick={() => onOpenConversation(item.id, item.entry_scope)}><MessageCircle size={17} /><span><strong>{item.title || '新研究'}</strong><small>{conversationWorkflow(item) === 'screening' ? '选股对话' : item.last_turn_state === 'running' || item.last_turn_state === 'awaiting_agent' ? '正在研究' : item.last_turn_state === 'failed' ? '研究中断' : '研究对话'} · {time(item.updated_at)}</small></span><ArrowUpRight size={16} /></button>)}</div> : <div className="research-empty"><MessageCircle size={23} /><p>暂无研究对话。</p></div>)}
            {tab === 'files' && <div className="heading-actions"><button className="text-button" disabled={!!reportBusy} onClick={() => void generateReports()}>{reportBusy === 'generate' ? '正在提交…' : '生成已有报告'}</button></div>}
            {tab === 'files' && (fileError ? <p className="research-error" role="alert">{fileError}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试成果加载</button></p> : filesLoading ? <p role="status">正在汇集研究成果…</p> : files.length ? <ResearchFileList files={files} busyId={reportBusy} onRetry={file => void generateReports(file)} /> : <div className="research-empty"><Download size={23} /><p>暂无研究成果。</p></div>)}
          </section>
        </> : projectLoading || loading ? <div className="research-loading" role="status"><RefreshCw size={20} /><p>正在读取研究项目…</p><div className="research-loading-lines" aria-hidden="true"><span /><span /><span /></div></div> : projectError ? <div className="research-load-failure" role="alert"><h2>项目暂时未能载入</h2><p>{projectError}</p><button className="secondary-button" onClick={() => setReload(value => value + 1)}>重新加载项目</button></div> : !catalogError && !projects.length ? <div className="research-empty"><h2>暂无研究项目</h2></div> : null}
      </section>
    </div>
  </div>
}
