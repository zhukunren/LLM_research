import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, Maximize2, Save, Sparkles } from 'lucide-react'
import planTemplate from '../../../api/app/assets/client-service/opening-plan.json'
import { api } from '../api'
import { beijingDate, cardArtworkPosition, cardThemes, fixedDisclosure, marketTime, withoutWebLinks, type CardTheme } from '../clientService'
import { ClientCardFullscreen, ClientCardImageStage, ClientCardPreviewSwitch, type CardPreviewMode } from '../components/ClientCardPreview'
import ClientThemePicker from '../components/ClientThemePicker'
import EditableClientCard from '../components/EditableClientCard'
import LoadingState from '../components/LoadingState'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import { useClientCardPreview } from '../useClientCardPreview'
import { useClientServiceCollection } from '../useClientServiceCollection'
import { useSessionState } from '../useSessionState'
import { useWorkspaceSession } from '../WorkspaceSession'
import './client-service.css'
import './opening-plan.css'

const endpoint = '/client-service/opening-plans'
const artworkSlot = 'opening-plan'
const sectionLimit = 1800
const fields = [...planTemplate.groups.flatMap(group => group.fields), planTemplate.data_note]
type Field = { key: string; label: string; rows: number; placeholder?: string }
type Sections = Record<string, string>
type Content = { sections: Sections; theme: CardTheme }
type Draft = { sections: Sections; appliedRequest: string; theme?: CardTheme }
type Saved = { revision: number; content: Content; collection_request_id: string | null }
type Editor = { template: Saved; saved: Saved | null }
type Request = { id: string; date: string; accepted: boolean }
type Source = { title: string; url: string; published_at: string }
type Market = { index: string; trade_date: string; close: string; pct_change: string | null; source: string }
type Status = {
  request_id: string; plan_date: string; cutoff: string; message: string
} & (
  { state: 'succeeded' | 'partial'; sections: Sections; sources: Source[]; market: Market | null }
  | { state: 'awaiting_agent' | 'running' | 'no_evidence' | 'failed' | 'cancelled' }
)

const initialDraft: Draft = { sections: {}, appliedRequest: '' }
const initialContent: Content = { sections: {}, theme: 'river' }
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const adviser = `投资顾问：${fixedDisclosure.adviser}　执业编码：${fixedDisclosure.license}`
const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'UTC' })
const submission = (request: Request) => ({ request_id: request.id, plan_date: request.date })

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value <= '0001-01-01') return false
  const day = new Date(value + 'T00:00:00Z')
  return Number.isFinite(day.valueOf()) && day.toISOString().slice(0, 10) === value
}

function validDraft(value: unknown): value is Draft {
  const draft = value as Partial<Draft> | null
  return !!draft?.sections && !Array.isArray(draft.sections) && typeof draft.sections === 'object'
    && typeof draft.appliedRequest === 'string'
    && (draft.theme === undefined || cardThemes.some(theme => theme.id === draft.theme))
    && Object.entries(draft.sections).every(([key, text]) => fields.some(field => field.key === key) && typeof text === 'string')
}

function validRequest(value: unknown): value is Request | null {
  if (value === null) return true
  const item = value as Partial<Request> | undefined
  return typeof item?.id === 'string' && requestPattern.test(item.id)
    && validDate(item.date) && typeof item.accepted === 'boolean'
}

function sameContent(first: Content, second: Content) {
  return first.theme === second.theme
    && Object.keys(first.sections).length === Object.keys(second.sections).length
    && Object.entries(first.sections).every(([key, value]) => second.sections[key] === value)
}

function planTitle(date: string) {
  const [year, month, day] = date.split('-')
  return `${year}年${Number(month)}月${Number(day)}日（${weekday.format(new Date(date + 'T00:00:00Z'))}）开盘计划`
}

export default function OpeningPlanPage() {
  const inputId = useId()
  const page = useRef<HTMLDivElement>(null)
  const scroll = useRef({ edit: 0, preview: 0 })
  const [date, setDate] = useSessionState('client-service.opening.date', beijingDate(), validDate)
  const [saving, setSaving] = useState<Saving>(null)
  const [pane, setPane] = useState<Pane>('edit')
  const [mode, setMode] = useState<CardPreviewMode>('image')

  function switchPane(next: Pane) {
    if (next === pane) return
    if (page.current) scroll.current[pane] = page.current.scrollTop
    setPane(next)
    requestAnimationFrame(() => { if (page.current) page.current.scrollTop = scroll.current[next] })
  }

  return <div ref={page} className="page-content workspace-tool-page client-service-page opening-plan-page" aria-label="开盘计划">
    <WorkspacePageHeading actions={<div className="opening-plan-date">
      <label htmlFor={inputId}>计划日期</label>
      <input id={inputId} type="date" className="workspace-field" value={date} disabled={!!saving}
        onChange={event => { if (validDate(event.target.value)) setDate(event.target.value) }} />
    </div>}><h1>开盘计划</h1></WorkspacePageHeading>
    <nav className="client-mobile-pane-switch" aria-label="开盘计划编辑视图">
      <button type="button" className="workspace-button" aria-pressed={pane === 'edit'} onClick={() => switchPane('edit')}>编辑</button>
      <button type="button" className="workspace-button" aria-pressed={pane === 'preview'} onClick={() => switchPane('preview')}>预览</button>
    </nav>
    <OpeningPlanEditor key={date} date={date} pane={pane} mode={mode} setMode={setMode} saving={saving} setSaving={setSaving} />
  </div>
}

type Pane = 'edit' | 'preview'
type Saving = 'saved' | 'template' | null

function OpeningPlanEditor({ date, pane, mode, setMode, saving, setSaving }: {
  date: string; pane: Pane; mode: CardPreviewMode; setMode: (mode: CardPreviewMode) => void
  saving: Saving; setSaving: (saving: Saving) => void
}) {
  const { active } = useWorkspaceSession()
  const savedVersion = useRef(0)
  const [draft, setDraft, storage] = useSessionState(`client-service.opening.draft.${date}`, initialDraft, validDraft)
  const [request, setRequest] = useSessionState<Request | null>(`client-service.opening.request.${date}`, null, validRequest)
  const [workspace, setWorkspace] = useState<Editor | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const [readError, setReadError] = useState('')
  const [reading, setReading] = useState(true)
  const [saveError, setSaveError] = useState('')
  const [saveNotice, setSaveNotice] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [notice, setNotice] = useState('')
  const [copyError, setCopyError] = useState('')
  const editorPath = endpoint + '/editor/' + date
  const saved = workspace?.saved
  const baseline = saved?.content || workspace?.template.content || initialContent
  const sourceId = saved?.collection_request_id || null
  const appliedId = draft.appliedRequest || sourceId
  const savedRequest = useMemo<Request | null>(() => sourceId ? { id: sourceId, date, accepted: true } : null, [date, sourceId])
  const sections = { ...baseline.sections, ...draft.sections }
  const theme = draft.theme || baseline.theme
  const themeName = cardThemes.find(item => item.id === theme)!.name
  const content: Content = { theme, sections }
  const dirty = !sameContent(baseline, content) || (!!draft.appliedRequest && draft.appliedRequest !== sourceId)
  const isDraft = !saved || dirty
  const preview = useClientCardPreview(endpoint + '/preview' + (isDraft ? '?draft=true' : ''), JSON.stringify({ plan_date: date, ...content }))
  const basis = useRef({ sections: baseline.sections, saved: !!saved, sourceId })
  basis.current = { sections: baseline.sections, saved: !!saved, sourceId }

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const startedVersion = savedVersion.current
    setReading(true)
    setReadError('')
    void api<Editor>(editorPath, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted && startedVersion === savedVersion.current) setWorkspace(value) })
      .catch((reason: Error) => { if (!controller.signal.aborted && startedVersion === savedVersion.current) setReadError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setReading(false) })
    return () => controller.abort()
  }, [active, editorPath, readAttempt])

  const onResult = useCallback((value: Status) => {
    if (value.plan_date !== date || (value.state !== 'succeeded' && value.state !== 'partial')) return
    setDraft(current => {
      if (current.appliedRequest === value.request_id || basis.current.sourceId === value.request_id) return current
      const available = Object.entries(value.sections).filter(([key]) =>
        !Object.hasOwn(current.sections, key) && (basis.current.saved
          ? !Object.hasOwn(basis.current.sections, key)
          : !basis.current.sections[key]?.trim()))
      return { ...current, sections: { ...Object.fromEntries(available), ...current.sections }, appliedRequest: value.request_id }
    })
  }, [date, setDraft])
  const collectionRequest = workspace || !reading ? request || savedRequest : null
  const { current, error, busy, stopping, begin, stop, retry, stopError } = useClientServiceCollection(
    endpoint, collectionRequest, setRequest, submission, onResult,
  )
  const collected = (current?.state === 'succeeded' || current?.state === 'partial') && current.plan_date === date ? current : null

  const paragraphs = fields.flatMap(field => {
    const body = withoutWebLinks(sections[field.key] || '').trim()
    if (!body) return []
    return [field.key === 'data_note' ? body : `【${field.label}】${body}`]
  })
  const canExport = paragraphs.length > 0
  const text = [
    `${planTitle(date)}\n${adviser}\n${fixedDisclosure.institution}`,
    ...paragraphs,
    `风险提示：${planTemplate.risk}\n${adviser}　${fixedDisclosure.institution}`,
  ].join('\n\n')
  const outgoing = isDraft ? `【草稿 · 待核对】\n${text}` : text
  const downloadLabel = isDraft ? '下载草稿图片' : '下载图片'
  const imageValues = Object.fromEntries(fields.map(field => [field.key, sections[field.key] || '']))

  function change(key: string, body: string) {
    setDraft(current => ({ ...current, sections: { ...current.sections, [key]: body } }))
    setNotice('')
    setSaveNotice('')
    setCopyError('')
  }

  function selectTheme(value: CardTheme) {
    setDraft(current => ({ ...current, theme: value }))
    setSaveNotice('')
  }

  function switchTheme(direction: -1 | 1) {
    const index = cardThemes.findIndex(item => item.id === theme)
    selectTheme(cardThemes[(index + direction + cardThemes.length) % cardThemes.length].id)
  }

  function collect() {
    if (busy || stopping || (!workspace && reading)) return
    setNotice('')
    setCopyError('')
    begin({ id: crypto.randomUUID(), date, accepted: false })
  }

  async function save(target: 'saved' | 'template') {
    if (!workspace || reading || saving) return
    setSaving(target)
    setSaveError('')
    setSaveNotice('')
    try {
      const savingDay = target === 'saved'
      const value = await api<Saved>(savingDay ? editorPath : endpoint + '/template', {
        method: 'PUT',
        body: JSON.stringify({
          revision: workspace[target]?.revision || 0, content,
          ...(savingDay ? { collection_request_id: appliedId || null } : {}),
        }),
      })
      savedVersion.current++
      setWorkspace(current => current && { ...current, [target]: value })
      if (savingDay || !saved) setDraft(current => {
        // After saving a default, keep the current date's collection provenance.
        return current === draft
          ? { ...initialDraft, appliedRequest: savingDay ? '' : draft.appliedRequest }
          : current
      })
      setSaveNotice(savingDay ? '本次开盘计划已保存' : '默认模板已保存，未保存的日期会使用此模板')
    } catch (reason) {
      setSaveError((reason as Error).message)
    } finally {
      setSaving(null)
    }
  }

  async function copy() {
    if (!canExport) return
    try {
      await navigator.clipboard.writeText(outgoing)
      setCopyError('')
      setNotice(isDraft ? '草稿文案已复制' : '开盘计划已复制，含风险提示和投顾信息')
    } catch {
      setCopyError('复制失败，请在文案预览中选中文案后手动复制。')
      setMode('text')
    }
  }

  function download() {
    if (!canExport || !preview.preview) return
    const link = document.createElement('a')
    link.href = preview.preview.image
    link.download = `开盘计划-${date}${isDraft ? '-草稿' : ''}.png`
    link.click()
  }

  function editorField(field: Field) {
    return <label key={field.key}>
      <span>{field.label}</span>
      <textarea aria-label={field.label} className="workspace-field" rows={field.rows} maxLength={sectionLimit} placeholder={field.placeholder}
        value={sections[field.key] || ''} onChange={event => change(field.key, event.target.value)} />
    </label>
  }

  function previewImage(mode: 'normal' | 'fit' | 'read' = 'normal') {
    if (preview.error) return <div className="client-preview-placeholder">
      <p role="alert">{preview.error}</p>
      <button type="button" className="secondary-button workspace-button" onClick={preview.retry}>重试预览</button>
    </div>
    if (!preview.visible) return <LoadingState label="正在排版卡片…" />
    return <EditableClientCard preview={preview.visible} editableValues={imageValues} alt="开盘计划图片预览" mode={mode}
      onApply={values => Object.entries(values).forEach(([key, value]) => { if (Object.hasOwn(imageValues, key) && value !== null) change(key, value) })}
      onFullscreen={mode === 'normal' && preview.preview ? () => setFullscreen(true) : undefined} />
  }

  const heading = isDraft ? '草稿预览' : '成品预览'
  return <>
    <div className="client-service-studio opening-plan-studio" data-mobile-pane={pane}>
      <section className="client-card-editor" aria-label="编辑开盘计划">
        <header className="client-editor-title"><h2>模板编辑</h2></header>
        <div className="opening-plan-collection">
          <button type="button" className="primary-button workspace-button" disabled={busy || stopping || (!workspace && reading)} onClick={collect}>
            <Sparkles size={16} />AI 采集资料
          </button>
          {busy && <LoadingState compact label={current?.state === 'running' ? '正在核对行情和盘前资料…' : '等待开始采集…'} />}
          {busy && request?.accepted && <button type="button" className="text-button workspace-button"
            disabled={stopping} onClick={() => void stop()}>{stopping ? '正在停止…' : '停止采集'}</button>}
        </div>
        {error && <div role="alert" className="workspace-error client-service-feedback">
          {error.message} {error.retry && <button type="button" className="text-button workspace-button" onClick={retry}>重试连接</button>}
        </div>}
        {stopError && <p role="alert" className="workspace-error client-service-feedback">{stopError}</p>}
        {current && !busy && !error && request && <p role="status" className="opening-plan-status">{current.message}</p>}
        {collected && <details className="opening-plan-evidence">
          <summary>采集资料与来源</summary>
          <p>信息截止 <time dateTime={collected.cutoff}>{marketTime(collected.cutoff)}</time>（北京时间）</p>
          {collected.market && <p>{collected.market.source} · {collected.market.trade_date} {collected.market.index}收于 {collected.market.close} 点</p>}
          {!!collected.sources.length && <ul>{collected.sources.map(source => <li key={source.url}>
            <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>{' '}
            <time dateTime={source.published_at}>{source.published_at.slice(0, 10)}</time>
          </li>)}</ul>}
          {fields.map(({ key, label }) => {
            const body = collected.sections[key]
            if (!body || body === sections[key]) return null
            return <div className="opening-plan-collected-text" key={key}>
              <strong>{label}</strong><p>{body}</p>
              <button type="button" className="secondary-button workspace-button" onClick={() => change(key, body)}>填入{label}</button>
            </div>
          })}
        </details>}
        <div className="opening-plan-save">
          <p className="opening-plan-status">{reading ? '正在读取模板…' : dirty ? (storage.persisted ? '未提交的修改已留在本机' : '有未提交的修改')
            : saved ? '本次开盘计划已保存' : '正在使用默认模板'}</p>
          <div className="client-editor-actions">
            <button type="button" className="primary-button workspace-button" disabled={!workspace || reading || !!saving || !canExport || (!!saved && !dirty)}
              onClick={() => void save('saved')}><Save size={15} />{saving === 'saved' ? '正在保存…' : '保存本次卡片'}</button>
            <button type="button" className="secondary-button workspace-button" disabled={!workspace || reading || !!saving}
              onClick={() => void save('template')}>{saving === 'template' ? '正在保存…' : '保存为默认模板'}</button>
          </div>
          {(readError || saveError) && <div role="alert" className="workspace-error client-service-feedback">
            <span>{readError || saveError}</span><button type="button" className="text-button workspace-button" disabled={reading || !!saving} onClick={() => {
              setSaveError('')
              setReadAttempt(value => value + 1)
            }}>刷新保存版本</button>
          </div>}
          {saveNotice && <p role="status" className="workspace-feedback-success client-service-feedback"><Check size={15} />{saveNotice}</p>}
        </div>
        {planTemplate.groups.map((group, index) => <details className="opening-plan-section" key={group.label} open={index < 2}>
          <summary>{group.label}</summary>
          <div className="client-content-fields">{group.fields.map(editorField)}</div>
        </details>)}
        <details className="opening-plan-section">
          <summary>数据说明与落款</summary>
          <div className="client-content-fields">{editorField(planTemplate.data_note)}</div>
          <div className="client-fixed-disclosure">
            <header><strong>固定风险提示</strong><span>R4</span></header>
            <p>{planTemplate.risk}</p><div><p>{adviser}</p><p>{fixedDisclosure.institution}</p></div>
          </div>
        </details>
      </section>
      <section className="client-preview-workspace" aria-label="开盘计划预览">
        <section className="client-preview-panel" aria-label={heading}>
          <header>
            <h2>{heading}</h2>
            <div className="client-preview-toolbar">
              <button type="button" className="secondary-button workspace-button" disabled={!preview.preview} onClick={() => setFullscreen(true)}><Maximize2 size={14} />全屏查看</button>
              <ClientCardPreviewSwitch mode={mode} onChange={setMode} />
            </div>
          </header>
          <div className="client-preview-meta">
            <span>{themeName}{mode === 'image' && ' · 点击图片文字可编辑'}</span>
            {mode === 'image' && <span>{preview.preview ? `${preview.preview.width} × ${preview.preview.height} px` : preview.error ? '预览暂不可用' : '正在同步…'}</span>}
          </div>
          {mode === 'image' ? <ClientCardImageStage pending={!preview.preview && !preview.error} onStep={switchTheme}>{previewImage()}</ClientCardImageStage>
            : <div className="client-text-preview" aria-label="文案预览"><pre aria-label="可复制的开盘计划">{outgoing}</pre></div>}
          <div className="client-export-bar" data-draft={isDraft}>
            {isDraft && <p>{canExport ? '保存本次卡片后可导出成品' : '填写任意段落后即可导出'}</p>}
            {copyError && <p role="alert" className="workspace-error">{copyError}</p>}
            {notice && <p role="status" className="workspace-feedback-success"><Check size={15} />{notice}</p>}
            <div>
              <button type="button" className="secondary-button workspace-button" disabled={!canExport} onClick={() => void copy()}><Copy size={15} />复制文案</button>
              <button type="button" className={`${isDraft ? 'secondary' : 'primary'}-button workspace-button`} disabled={!preview.preview || !canExport} onClick={download}><Download size={15} />{downloadLabel}</button>
            </div>
          </div>
        </section>
        <ClientThemePicker theme={theme} onSelect={selectTheme} ariaLabel="开盘计划底图" caption="开盘计划专用插画"
          thumbnail={id => <span className="client-theme-thumbnail" style={{ backgroundImage: `url(/client-service/themes/${id}-logo-safe.png)`, backgroundPosition: cardArtworkPosition(artworkSlot) }} />} />
      </section>
    </div>
    {fullscreen && <ClientCardFullscreen title={isDraft ? '草稿全屏预览' : '成品全屏预览'} description={`${themeName} · 开盘计划`}
      theme={themeName} downloadLabel={downloadLabel} canDownload={canExport && !!preview.preview}
      onDownload={download} onStep={switchTheme} onClose={() => setFullscreen(false)}>{previewImage}</ClientCardFullscreen>}
  </>
}
