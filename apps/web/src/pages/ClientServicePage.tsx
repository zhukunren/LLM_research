import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, Maximize2, Clock3, Copy, Download, Image, Radio, RefreshCw, RotateCcw, Save, Send } from 'lucide-react'
import { api } from '../api'
import ConditionWorkspaceDrawer from '../components/ConditionWorkspaceDrawer'
import ClientRobotPanel, { ClientCardSendDialog } from '../components/ClientRobotPanel'
import ClientCardReview from '../components/ClientCardReview'
import { ClientCardFullscreen, ClientCardImageStage, ClientCardPreviewSwitch, type CardPreviewMode } from '../components/ClientCardPreview'
import ClientThemePicker from '../components/ClientThemePicker'
import EditableClientCard from '../components/EditableClientCard'
import LoadingState from '../components/LoadingState'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import { useWorkspaceSession } from '../WorkspaceSession'
import { useSessionState } from '../useSessionState'
import { beijingDate, cardThemes, cardArtworkPosition, cardText, conclusionLimit, contentFields, defaultCardTheme, disclosureLines, fixedDisclosure, legacyCardTheme, withFixedDisclosure, marketTime, markDraftPreview, type CardContent, type CardPreview, type ServiceCard, type ServiceSettings } from '../clientService'
import './client-service.css'
import type { ServiceView } from '../workspaceRoute'
import { isServiceResearchDraft, serviceResearchPassages, type ServiceResearchDraft } from '../clientServiceResearchDraft'
import AnswerSources from '../components/conversation/AnswerSources'

type Drafts = Record<string, CardContent>
type CardDeliveryTarget = { card: ServiceCard; kind: 'image' | 'text'; image: string; previewKey: string }
type ReplacedConclusions = Record<string, { before: string; after: string }>
const isReplacedConclusions = (value: unknown): value is ReplacedConclusions =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item =>
    item && typeof item.before === 'string' && item.before.length <= conclusionLimit && typeof item.after === 'string' && item.after.length <= conclusionLimit)
function isMarketOverrides(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).length <= 13 && Object.entries(value).every(([key, text]) =>
    typeof text === 'string' && text.trim().length > 0 && (key === 'summary' ? text.length <= 600 : /^metric\.[0-5]\.(label|value)$/.test(key) && text.length <= (key.endsWith('.label') ? 30 : 80)))
}
function isDrafts(value: unknown): value is Drafts {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item =>
    !!item && typeof item === 'object' && (!('market_overrides' in item) || isMarketOverrides(item.market_overrides)) && (!('theme' in item) || cardThemes.some(theme => theme.id === item.theme)) && contentFields.every(field => typeof item[field.key] === 'string' && item[field.key].length <= field.max))
}
const stateLabels = { awaiting_agent: '等待采集', running: '采集中', ready: '已采集', failed: '采集失败' }
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const prompts: Partial<Record<keyof CardContent, string>> = {
  conclusion: '用一两句话说明当前判断，以及判断成立的前提。',
  action: '写清今天的应对安排、适用情形与需要等待的信号。',
  focus: '列出接下来关注的方向、事件或数据。',
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function shiftDate(day: string, offset: number) {
  const value = new Date(day + 'T12:00:00Z'); value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

export default function ClientServicePage({ view, onViewChange, researchDraft }: { view?: ServiceView; onViewChange?: (view: ServiceView) => void; researchDraft?: ServiceResearchDraft } = {}) {
  const { active } = useWorkspaceSession()
  const [config, setConfig] = useState<ServiceSettings | null>(null)
  const [schedule, setSchedule] = useState<ServiceSettings | null>(null)
  const [localView, setLocalView] = useState<ServiceView>('cards')
  const serviceView = view ?? localView
  const showingRobots = serviceView === 'robots'
  const cardsActive = active && !showingRobots
  const changeView = onViewChange ?? setLocalView
  const [fullscreen, setFullscreen] = useState(false)
  const [previewMode, setPreviewMode] = useState<CardPreviewMode>('image')
  const [sendTarget, setSendTarget] = useState<CardDeliveryTarget | null>(null)
  const [mobilePane, setMobilePane] = useState<'edit' | 'preview'>('edit')
  const mobileScroll = useRef<Partial<Record<typeof mobilePane, number>>>({})
  const [date, setDate] = useState(beijingDate)
  const [slot, setSlot] = useState('checkpoint')
  const [cards, setCards] = useState<ServiceCard[]>([])
  const [loadedDate, setLoadedDate] = useState('')
  const [drafts, setDrafts, draftStorage] = useSessionState<Drafts>('client-service.drafts.v1', {}, isDrafts)
  const [researchSource, setResearchSource] = useSessionState<ServiceResearchDraft | null>('client-service.researchSource', researchDraft || null, isServiceResearchDraft)
  const [replacedConclusions, setReplacedConclusions] = useSessionState<ReplacedConclusions>('client-service.replacedConclusions', {}, isReplacedConclusions)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('')
  const [retry, setRetry] = useState(0), [previewRetry, setPreviewRetry] = useState(0)
  const [now, setNow] = useState(Date.now)
  const [preview, setPreview] = useState<(CardPreview & {key: string; owner: string}) | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [undo, setUndo] = useState<{ key: string; content: CardContent } | null>(null)
  const mutation = useRef(0)
  const latestCards = useRef(cards)
  latestCards.current = cards
  const pageRef = useRef<HTMLDivElement>(null)
  const studioRef = useRef<HTMLDivElement>(null)
  const mobileToolbarRef = useRef<HTMLDivElement>(null)
  const card = cards.find(item => item.slot_id === slot && item.service_date === date)
  const instant = slot === 'realtime' || slot.startsWith('live-')
  const baseTemplate = config?.templates.find(item => item.id === 'checkpoint')
  const instantTemplate = baseTemplate ? { ...baseTemplate, id: 'live-' + '0'.repeat(32), title: '即时简报',
    time: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(now),
    content: { ...baseTemplate.content, headline: '', conclusion: '', action: '', focus: '' } } : undefined
  const template = config?.templates.find(item => item.id === slot) || card?.template || (slot === 'realtime' ? instantTemplate : undefined)
  const key = date + ':' + slot
  const baselineContent = card?.content ?? template?.content
  const baselineTheme = baselineContent?.theme ?? (card ? legacyCardTheme : defaultCardTheme)
  const rawContent = drafts[key] ?? baselineContent
  const theme = rawContent?.theme ?? baselineTheme
  const content = rawContent ? { ...withFixedDisclosure(rawContent), theme, market_overrides: rawContent.market_overrides || {} } : undefined
  const themeLabel = cardThemes.find(item => item.id === theme)!.name
  const canonicalContent = (value: CardContent | undefined) => value && { theme: value.theme ?? baselineTheme, ...Object.fromEntries(contentFields.map(field => [field.key, value[field.key]])), market_overrides: Object.fromEntries(Object.entries(value.market_overrides || {}).sort()) }
  const contentEqual = (a: CardContent | undefined, b: CardContent | undefined) => same(canonicalContent(a), canonicalContent(b))
  const effectiveTemplate = card?.template || template
  const loaded = loadedDate === date
  const valid = !!content?.brand.trim()
  const pending = card?.state === 'awaiting_agent' || card?.state === 'running'
  const futureSlot = !instant && !!effectiveTemplate && new Date(card?.cutoff || `${date}T${effectiveTemplate.time}:00+08:00`).getTime() > now
  const dirty = !!content && !contentEqual(content, baselineContent)
  const scheduleDirty = !!schedule && !!config && !same(schedule, config)
  const filled = content ? (['conclusion', 'action', 'focus'] as const).filter(field => content[field].trim()).length : 0
  const draftReason = !card?.market || card.state !== 'ready' ? '市场状态尚未采集'
    : card.market.quality !== 'verified' ? '部分市场来源待核实'
      : filled !== 3 ? '核心内容待补齐' : dirty ? '本次修改尚未保存' : ''
  const exportAsDraft = !!draftReason
  const downloadLabel = exportAsDraft ? '下载草稿' : '下载成品'
  const previewBody = effectiveTemplate && content && valid && loaded ? JSON.stringify({ template: effectiveTemplate, date, content, card_id: card?.id || null }) : ''
  const previewKey = JSON.stringify([previewBody, card?.market || null, exportAsDraft])
  const currentPreview = preview?.key === previewKey ? preview : null
  const visiblePreview = preview?.owner === key ? preview : currentPreview
  const readyToSend: CardDeliveryTarget | null = card && !exportAsDraft && loaded && currentPreview && !previewError && !busy
    ? { card, kind: previewMode, image: currentPreview.image, previewKey } : null
  const replacement = replacedConclusions[key]
  const researchPassages = researchSource?.passages ?? (researchSource && researchSource.excerpt.length > conclusionLimit ? serviceResearchPassages(researchSource.excerpt) : [])
  const dayCards = cards.filter(item => item.service_date === date)
  const readyCount = dayCards.filter(item => !item.slot_id.startsWith('live-') && item.state === 'ready').length
  const instantCards = dayCards.filter(item => item.slot_id.startsWith('live-')).sort((a,b) => b.cutoff.localeCompare(a.cutoff))
  const text = effectiveTemplate && content ? (exportAsDraft ? '【草稿 · 待核对】\n' : '') + cardText(effectiveTemplate, content, card, date) : ''

  useEffect(() => {
    if (showingRobots) return
    const controller = new AbortController()
    api<ServiceSettings>('/client-service/settings', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setConfig(value); setSchedule(current => current || value) }
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [retry, showingRobots])

  useEffect(() => {
    if (!cardsActive) return
    const timer = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(timer)
  }, [cardsActive])

  useEffect(() => {
    if (!cardsActive) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoadedDate('')
    async function load() {
      const version = mutation.current
      try {
        const result = await api<{ items: ServiceCard[] }>(`/client-service/cards?date=${date}`, { signal: controller.signal })
        if (!controller.signal.aborted && version === mutation.current) {
          const previousCards = latestCards.current
          setDrafts(current => {
            const next = { ...current }
            for (const item of result.items) {
              const draftKey = item.service_date + ':' + item.slot_id
              const previous = previousCards.find(value => value.id === item.id)
              if (previous && next[draftKey] && item.revision > previous.revision) {
                next[draftKey] = { ...next[draftKey] }
                for (const field of contentFields) if (next[draftKey][field.key] === previous.content[field.key]) next[draftKey][field.key] = item.content[field.key]
              }
            }
            return next
          })
          setCards(result.items); setLoadedDate(date)
        }
      } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
      if (!controller.signal.aborted) timer = setTimeout(() => { if (document.hidden) timer = setTimeout(load, 10000); else void load() }, 5000)
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [date, retry, cardsActive, setDrafts])

  useEffect(() => {
    setPreviewError('')
    if (!previewBody || !cardsActive) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const path = exportAsDraft ? '/client-service/preview?draft=true' : '/client-service/preview'
      void api<CardPreview>(path, { method: 'POST', signal: controller.signal, body: previewBody })
        .then(value => exportAsDraft && !value.draft && !controller.signal.aborted ? markDraftPreview(value) : value)
        .then(value => { if (!controller.signal.aborted) setPreview({ ...value, key: previewKey, owner: key }) })
        .catch(reason => { if (!controller.signal.aborted) setPreviewError(reason.message) })
    }, 350)
    return () => { clearTimeout(timer); controller.abort() }
  }, [previewBody, previewKey, previewRetry, cardsActive, exportAsDraft])

  useEffect(() => {
    if (showingRobots) {
      setFullscreen(false)
      setSendTarget(null)
    }
  }, [showingRobots])

  function openFullscreen() { setFullscreen(true) }

  function switchMobilePane(next: typeof mobilePane) {
    if (next === mobilePane) return
    const scroller = pageRef.current, studio = studioRef.current
    if (scroller) mobileScroll.current[mobilePane] = scroller.scrollTop
    setMobilePane(next)
    if (!scroller || !studio) return
    requestAnimationFrame(() => {
      if (!scroller.isConnected) return
      const start = studio.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      scroller.scrollTop = mobileScroll.current[next] ?? Math.max(0, start - (mobileToolbarRef.current?.offsetHeight ?? 0))
    })
  }

  function update(field: keyof CardContent, value: string) {
    if (!content) return
    setDrafts(current => ({ ...current, [key]: { ...(current[key] || content), [field]: value } }))
    setNotice(''); setUndo(null)
  }
  function applyResearchExcerpt() {
    const excerpt = researchSource?.excerpt.trim()
    if (!excerpt || !content || !loaded || busy || excerpt.length > conclusionLimit || excerpt === content.conclusion) return
    if (content.conclusion.trim()) setReplacedConclusions(current => ({ ...current, [key]: { before: content.conclusion, after: excerpt } }))
    update('conclusion', excerpt)
    setNotice(`已填入 ${date} ${effectiveTemplate?.time} 的今日判断`)
  }
  function undoResearchExcerpt() {
    if (!replacement || content?.conclusion !== replacement.after) return
    update('conclusion', replacement.before)
    setReplacedConclusions(current => {
      const next = { ...current }
      delete next[key]
      return next
    })
    setNotice('已恢复替换前的今日判断')
  }
  function applyImageEdits(values: Record<string, string | null>) {
    if (!content) return
    setDrafts(current => {
      const next: CardContent = { ...(current[key] || content), market_overrides: { ...(current[key]?.market_overrides || content.market_overrides) } }
      for (const [field, value] of Object.entries(values)) {
        if (field.startsWith('market.')) {
          if (value === null) delete next.market_overrides![field.slice(7)]
          else next.market_overrides![field.slice(7)] = value
        } else if (value !== null && contentFields.some(item => item.key === field)) {
          Object.assign(next, { [field]: value })
        }
      }
      return { ...current, [key]: next }
    })
    setNotice('图片文字已更新，保存本次卡片后保留'); setUndo(null)
  }
  function switchTheme(direction: -1 | 1) {
    const index = cardThemes.findIndex(item => item.id === theme)
    update('theme', cardThemes[(index + direction + cardThemes.length) % cardThemes.length].id)
  }
  function clearSavedDraft(savedKey: string, saved: CardContent) {
    setDrafts(current => {
      if (!contentEqual(current[savedKey], saved)) return current
      const next = { ...current }; delete next[savedKey]; return next
    })
  }
  function replaceCard(value: ServiceCard) {
    mutation.current++
    setCards(current => [...current.filter(item => item.id !== value.id), value])
  }
  async function saveCard() {
    if (!card || !content || !valid) return
    setBusy('save'); setError(''); setNotice('')
    try {
      const value = await api<ServiceCard>(`/client-service/cards/${card.id}`, { method: 'PUT', body: JSON.stringify({ revision: card.revision, content }) })
      replaceCard(value); clearSavedDraft(key, content); setNotice('本次卡片已保存')
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }
  async function saveSettings(kind: 'template' | 'schedule') {
    if (!config || !content || !schedule || (kind === 'template' && (!valid || instant))) return
    if (kind === 'schedule' && schedule.templates.some(item => !item.content.brand.trim())) { setError('请补全每个服务模板的服务名称。'); return }
    setBusy(kind); setError(''); setNotice('')
    try {
      const next = kind === 'template'
        ? { ...config, templates: config.templates.map(item => item.id === slot ? { ...item, content: { ...content, market_overrides: {} } } : item) }
        : { ...schedule, revision: config.revision, templates: schedule.templates.map(item => ({ ...item, content: { ...withFixedDisclosure(item.content), market_overrides: {} } })) }
      const saved = await api<ServiceSettings>('/client-service/settings', { method: 'PUT', body: JSON.stringify(next) })
      setConfig(saved)
      setSchedule(current => kind === 'schedule' ? saved : current && { ...current, revision: saved.revision, templates: current.templates.map(item => ({ ...item, content: same(item.content, config.templates.find(value => value.id === item.id)?.content) ? saved.templates.find(value => value.id === item.id)!.content : item.content })) })
      if (kind === 'template' && !card && !Object.keys(content.market_overrides).length) clearSavedDraft(key, content)
      setNotice(kind === 'template' ? '默认模板已保存，今后此时点沿用当前文案' : '自动生成计划已保存')
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }
  async function saveThemeCollection() {
    if (!config || !schedule) return
    setBusy('theme'); setError(''); setNotice('')
    try {
      const next = { ...config, templates: config.templates.map(item => ({ ...item, content: { ...item.content, theme } })) }
      const saved = await api<ServiceSettings>('/client-service/settings', { method: 'PUT', body: JSON.stringify(next) })
      setConfig(saved)
      setSchedule(current => current && { ...current, revision: saved.revision, templates: current.templates.map(item => ({ ...item, content: same(item.content, config.templates.find(value => value.id === item.id)?.content) ? saved.templates.find(value => value.id === item.id)!.content : item.content })) })
      setNotice(`「${themeLabel}」已设为所有时点的默认套图，以后生成时自动匹配对应底图`)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }
  async function generate() {
    if (!content || !valid || !loaded || pending || futureSlot) return
    setBusy('generate'); setError(''); setNotice('')
    try {
      let value = await api<ServiceCard>('/client-service/cards', { method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID(), date, slot_id: slot, regenerate: !!card }) })
      replaceCard(value)
      if (!contentEqual(value.content, content)) {
        value = await api<ServiceCard>(`/client-service/cards/${value.id}`, { method: 'PUT', body: JSON.stringify({ revision: value.revision, content }) })
        replaceCard(value)
      }
      clearSavedDraft(key, content); setNotice('采集已开始，关闭页面后任务仍会继续')
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }
  async function generateInstant() {
    if (busy) return
    setBusy('instant'); setError(''); setNotice('')
    try {
      let value = await api<ServiceCard>('/client-service/briefs', { method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID(), theme }) })
      replaceCard(value)
      if (slot === 'realtime' && drafts[key] && content) {
        value = await api<ServiceCard>(`/client-service/cards/${value.id}`, { method: 'PUT', body: JSON.stringify({ revision: value.revision, content }) })
        replaceCard(value); clearSavedDraft(key, content)
      }
      setDate(value.service_date); setSlot(value.slot_id); setPreviewMode('image')
      setNotice('实时股评已启动，Codex 正在检索并生成即时简报')
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setNotice(exportAsDraft ? '草稿文案已复制' : '文案已复制') }
    catch { setError('复制失败，请在文案预览中手动选择并复制。') }
  }
  function download() {
    if (!currentPreview || previewError) return
    const link = document.createElement('a')
    link.href = currentPreview.image; link.download = `market-card-${exportAsDraft ? 'draft-' : ''}${date}-${slot}.png`; link.click()
    setNotice(exportAsDraft ? '带草稿标记的图片已下载' : '成品图片已下载')
  }
  function resetDraft() {
    if (!content) return
    setUndo({ key, content })
    setDrafts(current => { const next = { ...current }; delete next[key]; return next })
    setNotice('已恢复保存的内容，可撤销此操作')
  }
  function changeDate(value: string) { if (value) { setDate(value); if (instant) setSlot('checkpoint'); setNotice(''); setUndo(null) } }
  function selectSlot(value: string) { setSlot(value === 'realtime' ? instantCards[0]?.slot_id || value : value); setNotice(''); setUndo(null) }
  function field(fieldKey: keyof CardContent) {
    const item = contentFields.find(value => value.key === fieldKey)!
    if (!content) return null
    const label = instant && item.key === 'action' ? '盘面主线' : item.label
    return <label key={item.key} className={item.rows ? 'client-field-wide' : ''}><span>{label}<small>{content[item.key].length}/{item.max}</small></span>
      {item.rows ? <textarea className="workspace-field" aria-label={label} value={content[item.key]} rows={item.rows} maxLength={item.max} onChange={event => update(item.key, event.target.value)} placeholder={instant && item.key === 'action' ? '描述资金、行业或主题的主要变化' : prompts[item.key] || `填写${label}`} />
        : <input className="workspace-field" aria-label={item.label} aria-invalid={item.key === 'brand' && !valid || undefined} value={content[item.key]} maxLength={item.max} onChange={event => update(item.key, event.target.value)} placeholder={item.key === 'headline' ? effectiveTemplate?.title : item.label} />}
      {item.key === 'brand' && !valid && <small className="client-field-error">请填写服务名称，才能预览和保存。</small>}
    </label>
  }

  if (showingRobots) return <div key="robots" className="page-content workspace-tool-page client-service-page client-robot-page" role="region" aria-label="群机器人工作区" tabIndex={0}>
    <WorkspacePageHeading actions={null}><h1>群机器人</h1></WorkspacePageHeading>
    <ClientRobotPanel />
  </div>

  const ready = !!(config && template && content)
  const templateStatus = error ? <p className="client-empty">暂时无法读取服务模板，请重新读取。</p> : <LoadingState label="正在读取服务模板…" />
  const researchDraftPanel = researchSource && (
    <section className="client-research-draft" aria-label="研究转服务草稿">
      <header><h3>研究转服务草稿</h3><a href={`#/research/${encodeURIComponent(researchSource.conversationId)}`}>查看原研究</a></header>
      <p>研究答复 {marketTime(researchSource.createdAt)} · 数据截至 {researchSource.asOf || '未记录'}</p>
      {researchPassages.length > 0 && <label className="workspace-field-label">从答复选段<select className="workspace-field" aria-label="从研究答复选段" value="" onChange={event => setResearchSource({ ...researchSource, excerpt: event.target.value })}>
        <option value="" disabled>选择一段原文填入摘录</option>
        {researchPassages.map(passage => <option key={passage} value={passage}>{passage.length > 48 ? passage.slice(0, 48) + '…' : passage}</option>)}
      </select></label>}
      <label className="workspace-field-label">编辑客户沟通摘录<textarea className="workspace-field" aria-label="服务草稿摘录" rows={3} maxLength={conclusionLimit} value={researchSource.excerpt} onChange={event => setResearchSource({ ...researchSource, excerpt: event.target.value })} /></label>
      {researchSource.references.length > 0 && <AnswerSources references={researchSource.references} />}
      <footer>
        <span>{researchSource.excerpt.length}/{conclusionLimit} 字 · 填入 {date} {effectiveTemplate?.time} {effectiveTemplate?.title || '所选卡片'}</span>
        <button type="button" className="secondary-button workspace-button" disabled={!content || !loaded || !!busy || !researchSource.excerpt.trim() || researchSource.excerpt.length > conclusionLimit || content.conclusion === researchSource.excerpt.trim()} onClick={applyResearchExcerpt}>{content?.conclusion.trim() && content.conclusion !== researchSource.excerpt.trim() ? '替换今日判断' : '填入今日判断'}</button>
        <button type="button" className="text-button workspace-button" onClick={() => setResearchSource(null)}>关闭草稿</button>
      </footer>
    </section>
  )

  return <div key="cards" ref={pageRef} className="page-content workspace-tool-page client-service-page" role="region" aria-label="对客服务内容" tabIndex={0}>
    <WorkspacePageHeading actions={<div className="client-date-control"><button className="workspace-button" aria-label="前一天" onClick={() => changeDate(shiftDate(date, -1))}><ArrowLeft size={15} /></button><input className="workspace-field" type="date" aria-label="服务日期" value={date} onChange={event => changeDate(event.target.value)} /><button className="workspace-button" aria-label="后一天" onClick={() => changeDate(shiftDate(date, 1))}><ArrowRight size={15} /></button><button className="workspace-button" disabled={date === beijingDate()} onClick={() => changeDate(beijingDate())}>今天</button></div>}><h1>对客服务</h1><p className="page-description">编辑市场时点卡片，预览并下载客户沟通内容。</p></WorkspacePageHeading>
    <div className="client-generation-status" role="status">
      <span className={`client-status-dot ${config?.enabled ? 'is-ready' : ''}`} aria-hidden="true" />
      {config ? `${config.enabled ? '自动生成已开启' : '自动生成未开启'} · 北京时间` : error ? '暂时无法读取自动生成状态' : '正在读取自动生成状态…'}
    </div>
    {error && serviceView !== 'templates' && <div role="alert" className="workspace-error client-service-feedback"><AlertCircle size={17} /><span>{error}</span><button className="workspace-button text-button" onClick={() => { setError(''); setRetry(value => value + 1) }}>重新读取</button></div>}
    {notice && serviceView !== 'templates' && <div role="status" className="client-service-feedback workspace-feedback-success"><Check size={16} /><span>{notice}</span>{undo?.key === key && <button className="workspace-button text-button" onClick={() => { setDrafts(current => ({ ...current, [key]: undo.content })); setUndo(null); setNotice('已撤销恢复，继续编辑') }}>撤销</button>}</div>}
    {ready && <>
      <div className="client-day-summary"><h2>{date === beijingDate() ? '今日服务时点' : `${date} 服务时点`}</h2><span>{loaded ? `固定时点已采集 ${readyCount} / ${config.templates.length} · 即时简报 ${instantCards.length} 份` : '正在读取当日卡片…'}</span></div>
      <label className="client-compact-slot workspace-field-label">服务时点<select className="workspace-field" aria-label="选择服务时点" value={instant ? 'realtime' : slot} onChange={event => selectSlot(event.target.value)}>
        <option value="realtime">实时 · 即时简报</option>
        {config.templates.map(item => {
          const existing = dayCards.find(value => value.slot_id === item.id)
          return <option key={item.id} value={item.id}>{existing?.template.time || item.time} · {existing?.template.title || item.title}{existing ? ` · ${stateLabels[existing.state]}` : ''}</option>
        })}
      </select></label>
      <nav className="client-slot-tabs" aria-label="服务时点"><button type="button" className="workspace-button client-live-slot" aria-label="实时股评卡片" aria-current={instant ? 'page' : undefined} onClick={() => selectSlot('realtime')}><span className="client-slot-top"><time><Radio size={15} />实时</time><small>LIVE</small></span><strong>即时简报</strong><span className={`client-slot-state is-${instantCards[0]?.state || 'empty'}`}><span className="client-status-dot" />{instantCards[0] ? stateLabels[instantCards[0].state] : '随时生成'}<ChevronRight size={12} /></span></button>{config.templates.map((item, index) => {
        const existing = dayCards.find(value => value.slot_id === item.id)
        const status = existing ? stateLabels[existing.state] : new Date(`${date}T${item.time}:00+08:00`).getTime() > now ? '未到时点' : '待制作'
        return <button className="workspace-button" key={item.id} aria-current={slot === item.id ? 'page' : undefined} onClick={() => selectSlot(item.id)}><span className="client-slot-top"><time>{existing?.template.time || item.time}</time><small>0{index + 1}</small></span><strong>{existing?.template.title || item.title}</strong><span className={`client-slot-state is-${existing?.state || 'empty'}`}><span className="client-status-dot" />{loaded ? status : '读取中'}{drafts[date + ':' + item.id] && <span className="client-draft-tag">草稿</span>}</span></button>
      })}</nav>
      {!!instantCards.length && <section className="client-instant-history" aria-label="即时简报记录"><div><Radio size={16} /><strong>即时简报</strong><span>按生成时刻保留</span></div><nav aria-label="即时简报选择">{instantCards.map(item => <button key={item.id} className="workspace-button" aria-current={slot === item.slot_id ? 'page' : undefined} onClick={() => { setSlot(item.slot_id); setNotice('') }}><time>{new Date(item.cutoff).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</time><span>{stateLabels[item.state]}</span></button>)}</nav></section>}
      <div ref={mobileToolbarRef} className="client-mobile-pane-switch" role="group" aria-label="卡片编辑与预览">
        <button type="button" className="workspace-button" aria-pressed={mobilePane === 'edit'} onClick={() => switchMobilePane('edit')}>编辑</button>
        <button type="button" className="workspace-button" aria-pressed={mobilePane === 'preview'} onClick={() => switchMobilePane('preview')}>预览</button>
      </div>
    </>}
    {!ready && !researchSource && templateStatus}
    {(ready || researchSource) && (
      <div ref={studioRef} className="client-service-studio" data-mobile-pane={ready ? mobilePane : 'edit'}>
        <section className="client-card-editor" aria-label="卡片编辑">
          {ready && <header className="client-editor-title"><div><h2>{effectiveTemplate?.title}<span>编辑卡片</span></h2></div><button className="workspace-button text-button" disabled={!dirty || !!busy} onClick={resetDraft}><RotateCcw size={14} />恢复</button></header>}
          {researchDraftPanel}
          {ready ? <>
          <section className={`client-market-control ${card?.state === 'failed' ? 'has-error' : ''}`} aria-label="市场采集"><div><span className="client-market-icon"><RefreshCw size={17} className={pending ? 'spin' : ''} /></span><div><strong>市场快照 <small>{card ? stateLabels[card.state] : '尚未采集'}</small></strong><p>{futureSlot ? `将于 ${effectiveTemplate?.time} 到达服务时点，可先准备文案。` : card?.message || '采集指数、成交与市场广度，附带信息来源。'}</p></div></div><button type="button" className="secondary-button workspace-button" disabled={!!busy || pending || futureSlot || !loaded || !valid} onClick={() => void (instant ? generateInstant() : generate())}>{pending ? '正在采集…' : instant ? card ? '生成新一期股评' : '生成即时简报' : card ? '重新采集市场状态' : '采集市场状态'}</button></section>
          <div className="client-content-fields client-identity-fields">{field('brand')}{field('headline')}</div>
          <div className="client-section-heading"><h3>核心内容</h3><span>{filled} / 3 项已填写</span></div>
          <div className="client-content-fields">
            {field('conclusion')}
            {replacement && content.conclusion === replacement.after && <button type="button" className="text-button workspace-button client-replacement-undo" onClick={undoResearchExcerpt}><RotateCcw size={13} />撤销替换今日判断</button>}
            {field('action')}{field('focus')}
          </div>
          <details className="client-brand-details"><summary>服务落款与风险提示<span>R4 · 固定展示</span></summary><div className="client-content-fields">{field('service')}</div><section className="client-fixed-disclosure" aria-label="固定风险提示与投顾信息"><header><strong>风险提示</strong><span>R4</span></header><p>{fixedDisclosure.risk}</p><div>{disclosureLines.slice(1).map(line => <p key={line}>{line}</p>)}</div><small>所有时点、套图和导出文案均固定附带以上信息。</small></section></details>
          <footer className="client-editor-footer"><p><span className={`client-status-dot ${dirty ? 'is-draft' : 'is-ready'}`} />{dirty ? draftStorage.persisted ? '草稿已暂存本机，尚未保存' : '草稿暂未写入本机，请及时保存' : card ? '与已保存卡片一致' : '正在使用默认模板'}</p><div className="client-editor-actions"><button className="primary-button workspace-button" disabled={!card || !!busy || !dirty || !valid} onClick={() => void saveCard()}><Save size={15} />{busy === 'save' ? '正在保存…' : '保存本次卡片'}</button><button className="secondary-button workspace-button" disabled={!!busy || !valid || instant} onClick={() => void saveSettings('template')}>{busy === 'template' ? '正在保存…' : '保存为默认模板'}</button></div>{!card && <small>采集后可保存本次卡片；提前准备的内容可保存为默认模板。</small>}</footer>
          </> : templateStatus}
        </section>
        {ready && <section className="client-preview-workspace" aria-label="卡片预览">
          <section className="client-preview-panel" aria-label={exportAsDraft ? '草稿预览' : '成品预览'}>
          <header><div><h2>{exportAsDraft ? '草稿预览' : '成品预览'}</h2></div><div className="client-preview-toolbar"><button type="button" className="secondary-button workspace-button" disabled={!currentPreview || !!previewError} onClick={openFullscreen}><Maximize2 size={14} />全屏查看</button><ClientCardPreviewSwitch mode={previewMode} onChange={setPreviewMode} /></div></header>
          <div className="client-preview-meta"><span>{themeLabel} · 点击图片文字可编辑</span><span>{!valid ? '等待填写服务名称' : currentPreview ? `${currentPreview.width} × ${currentPreview.height} px` : previewError ? '预览暂不可用' : '正在同步…'}</span></div>
          {previewError && <div role="alert" className="workspace-error client-service-feedback"><span>{previewError}</span><button className="workspace-button text-button" onClick={() => setPreviewRetry(value => value + 1)}>重试预览</button></div>}
          {previewMode === 'image' ? <ClientCardImageStage pending={valid && !currentPreview && !previewError} onStep={switchTheme}>
            {visiblePreview ? <EditableClientCard key={key} preview={visiblePreview} content={content} alt={`${content.brand} ${content.headline || effectiveTemplate?.title}时点卡预览`} onApply={applyImageEdits} onFullscreen={openFullscreen} />
              : <div className="client-preview-placeholder"><Image size={34} /><p>{!valid ? '填写服务名称后，即可预览卡片' : previewError ? '修改内容或重试以恢复图片预览' : '正在排版当前内容…'}</p><small>预览与下载使用同一版式</small></div>}
          </ClientCardImageStage> : <div className="client-text-preview" aria-label="文案预览"><pre>{text}</pre></div>}
          <div className="client-preview-details">
            {card?.market && <details className="client-evidence-details"><summary>市场来源与时点<span>{card.market.sources.length} 个来源 · {card.market.quality === 'partial' ? '部分待核实' : '已核对'}</span></summary><section className="client-market-evidence" aria-label="市场来源与时点"><p>信息截至 {marketTime(card.cutoff)}（北京时间）</p><dl>{(card.market.raw_metrics || card.market.metrics).map((metric, index) => <div key={index}><dt>{metric.label}</dt><dd>{metric.value}{metric.observed_at && <small>数据时点 {marketTime(metric.observed_at)}</small>}</dd></div>)}</dl><ul>{card.market.sources.map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul>{!!card.market.limitations.length && <p>{card.market.limitations.join('；')}</p>}</section></details>}
            {currentPreview?.checks?.state==='warning'&&<p className="client-layout-warning" role="status">排版提示：{[...new Set(currentPreview.checks.issues.map(issue=>issue.message))].join('；')}。</p>}
            <ClientCardReview card={card} dirty={dirty} imageHash={exportAsDraft ? currentPreview?.saved_image_hash : currentPreview?.image_hash} />
          </div>
          <div className="client-export-bar" data-draft={exportAsDraft}>
            <p>{exportAsDraft ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}{exportAsDraft ? `草稿 · ${draftReason}` : '成品 · 市场已核对，内容已保存'}</p>
            <div>
              <button className="secondary-button workspace-button" disabled={!valid || !loaded} onClick={() => void copy()}><Copy size={15} />{exportAsDraft ? '复制草稿文案' : '复制文案'}</button>
              <button className={`${exportAsDraft ? 'secondary' : 'primary'}-button workspace-button`} disabled={!currentPreview || !!previewError} onClick={download}><Download size={15} />{downloadLabel}</button>
              {!exportAsDraft && <button type="button" className="secondary-button workspace-button" aria-haspopup="dialog" disabled={!readyToSend} onClick={() => setSendTarget(readyToSend)}><Send size={15} aria-hidden="true" />发送到群</button>}
            </div>
          </div>
          </section>
          <ClientThemePicker theme={theme} onSelect={value => update('theme', value)} caption="每套含 7 款时点插画"
            thumbnail={id => <span className="client-theme-thumbnail" style={{ backgroundImage: `url(/client-service/themes/${id}-logo-safe.png)`, backgroundPosition: cardArtworkPosition(slot) }} />}
            footer={<><span>已匹配{effectiveTemplate?.title}底图</span><button type="button" className="text-button workspace-button" disabled={!!busy} onClick={() => void saveThemeCollection()}>{busy === 'theme' ? '正在保存…' : '设为全时点默认'}</button></>} />
        </section>}
      </div>
    )}
    {fullscreen && <ClientCardFullscreen title={exportAsDraft ? '草稿全屏预览' : '成品全屏预览'}
      description={`${themeLabel} · ${content?.headline || effectiveTemplate?.title || '时点卡'}`} theme={themeLabel}
      downloadLabel={downloadLabel} canDownload={!!currentPreview && !previewError} onDownload={download} onStep={switchTheme}
      onClose={() => setFullscreen(false)}>
      {mode => visiblePreview ? <EditableClientCard key={key} preview={visiblePreview} content={content!} alt={exportAsDraft ? '全屏草稿图片' : '全屏成品图片'} mode={mode} onApply={applyImageEdits} />
        : previewError ? <div role="alert" className="client-fullscreen-error"><p>{previewError}</p><button className="workspace-button" onClick={() => setPreviewRetry(value => value + 1)}>重试预览</button></div> : <LoadingState label="正在同步卡片图片…" />}
    </ClientCardFullscreen>}
    {serviceView === 'templates' && schedule && <ConditionWorkspaceDrawer title="每日生成计划" description="设置服务时点与生成日期，保存后生效。" closeLabel="关闭生成计划" className="client-service-drawer" onClose={() => changeView('cards')}>
      {error && <p role="alert" className="workspace-error client-service-feedback">{error}</p>}
      {notice && <p role="status" className="workspace-feedback-success client-service-feedback">{notice}</p>}
      <section className="client-schedule" aria-label="每日生成计划"><header><div><h2><Clock3 size={20} />让服务按时准备好</h2><p>按北京时间采集市场快照，生成后回到卡片工作台编辑与下载。</p></div><label className="client-schedule-toggle"><input type="checkbox" checked={schedule.enabled} disabled={!!busy} onChange={event => setSchedule({ ...schedule, enabled: event.target.checked })} />开启每日自动生成</label></header>
      <div className="client-plan-note"><Clock3 size={17} /><span>本地后台服务运行时，关闭页面仍会执行计划。错过 15 分钟的时点需手动采集。</span></div>
      <fieldset disabled={!!busy}><legend>选择生成日期</legend><div className="client-weekdays">{weekdays.map((day, index) => <label key={day} className={schedule.weekdays.includes(index) ? 'is-selected' : ''}><input type="checkbox" checked={schedule.weekdays.includes(index)} onChange={event => setSchedule({ ...schedule, weekdays: event.target.checked ? [...schedule.weekdays, index].sort() : schedule.weekdays.filter(value => value !== index) })} />{day}</label>)}</div><p className="client-plan-help">按星期执行，请在法定休市日前调整计划。</p>
      <div className="client-schedule-times">{schedule.templates.map((item, index) => <div key={item.id}><span className="client-schedule-number">0{index + 1}</span><label><input type="checkbox" checked={item.enabled} onChange={event => setSchedule({ ...schedule, templates: schedule.templates.map(value => value.id === item.id ? { ...value, enabled: event.target.checked } : value) })} />{item.title}</label><input type="time" aria-label={`${item.title}生成时间`} className="workspace-field" value={item.time} onChange={event => { if (event.target.value) setSchedule({ ...schedule, templates: schedule.templates.map(value => value.id === item.id ? { ...value, time: event.target.value } : value) }) }} /></div>)}</div></fieldset>
      <section className="client-template-library" aria-label="服务模板文案"><h3>服务模板文案</h3><p className="client-plan-help">保存后用于后续生成，已有卡片保留原内容。</p>{schedule.templates.map(item => <details key={item.id}><summary>{item.title} · {item.time}</summary><div className="client-template-fields">{contentFields.map(field => <label key={field.key} className="workspace-field-label">{field.label}<textarea aria-label={`${item.title}${field.label}`} rows={field.rows || 1} maxLength={field.max} disabled={!!busy} value={item.content[field.key]} onChange={event => setSchedule({ ...schedule, templates: schedule.templates.map(value => value.id === item.id ? { ...value, content: withFixedDisclosure({ ...value.content, [field.key]: event.target.value }) } : value) })} className="workspace-field" /></label>)}</div></details>)}</section>
      {!schedule.weekdays.length && <p role="alert" className="client-field-error">请至少选择一个生成日期。</p>}
      <footer><span>{scheduleDirty ? '计划有未保存的修改' : '计划已保存'} · {schedule.templates.filter(item => item.enabled).length} 个启用时点</span><button className="secondary-button workspace-button" disabled={!scheduleDirty || !!busy} onClick={() => setSchedule(config)}>放弃计划修改</button><button type="button" className="primary-button workspace-button" disabled={!!busy || !schedule.weekdays.length || !scheduleDirty} onClick={() => void saveSettings('schedule')}><Save size={15} />{busy === 'schedule' ? '正在保存…' : '保存生成计划'}</button></footer>
    </section></ConditionWorkspaceDrawer>}
    {serviceView === 'deliveries' && <ConditionWorkspaceDrawer title="发送记录" description="查看最近发送的内容、时间与结果。" closeLabel="关闭发送记录" className="client-service-drawer" onClose={() => changeView('cards')}>
      <ClientRobotPanel historyOnly />
    </ConditionWorkspaceDrawer>}
    {sendTarget && <ClientCardSendDialog
      card={sendTarget.card}
      kind={sendTarget.kind}
      preview={sendTarget.image}
      canSend={!!readyToSend && readyToSend.card.id === sendTarget.card.id && readyToSend.card.revision === sendTarget.card.revision && readyToSend.previewKey === sendTarget.previewKey}
      onClose={() => setSendTarget(null)}
      onManage={() => { setSendTarget(null); setNotice(''); changeView('robots') }}
    />}
  </div>
}
