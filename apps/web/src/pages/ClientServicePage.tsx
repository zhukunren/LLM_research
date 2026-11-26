import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, Maximize2, Copy, Download, Image, PanelRightOpen, Radio, RefreshCw, RotateCcw, Save, Send } from 'lucide-react'
import { api } from '../api'
import { serviceStateLabels as stateLabels } from '../clientServicePresentation'
import ConditionWorkspaceDrawer from '../components/ConditionWorkspaceDrawer'
import ClientRobotPanel, { ClientCardSendDialog } from '../components/ClientRobotPanel'
import ClientCardReview from '../components/ClientCardReview'
import { ClientCardFullscreen, ClientCardImageStage, ClientCardPreviewSwitch, type CardPreviewMode } from '../components/ClientCardPreview'
import ClientThemePicker from '../components/ClientThemePicker'
import EditableClientCard from '../components/EditableClientCard'
import LoadingState from '../components/LoadingState'
import { useWorkspaceSession } from '../WorkspaceSession'
import { useSessionState } from '../useSessionState'
import { beijingDate, cardThemes, cardArtworkPosition, cardText, conclusionLimit, contentFields, defaultCardTheme, disclosureLines, fixedDisclosure, legacyCardTheme, withFixedDisclosure, marketTime, markDraftPreview, type CardContent, type CardPreview, type ServiceCard, type ServiceSettings } from '../clientService'
import ClientServiceLayout, { ClientServiceEditor, ClientServiceGeneration, ClientServicePreview, ClientServiceStudio, useClientServicePane } from './ClientServiceLayout'
import ClientServiceSchedule from './ClientServiceSchedule'
import type { ServiceView } from '../workspaceRoute'
import { isServiceResearchDraft, serviceResearchPassages, type ServiceResearchDraft } from '../clientServiceResearchDraft'
import AnswerSources from '../components/conversation/AnswerSources'
import type { ModelMode } from '../modelSelection'

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
  const cardsActive = active && serviceView === 'cards'
  const needsSettings = serviceView === 'cards' || serviceView === 'templates'
  const changeView = onViewChange ?? setLocalView
  const [slotDrawerOpen, setSlotDrawerOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [previewMode, setPreviewMode] = useState<CardPreviewMode>('image')
  const [sendTarget, setSendTarget] = useState<CardDeliveryTarget | null>(null)
  const { pageRef, pane, switchPane } = useClientServicePane()
  const [date, setDate] = useState(beijingDate)
  const [slot, setSlot] = useState('checkpoint')
  const [modelMode, setModelMode] = useState<ModelMode>('deep')
  const [generationFocus, setGenerationFocus] = useState('')
  const [replaySource, setReplaySource] = useState<string | null>(null)
  const [cards, setCards] = useState<ServiceCard[]>([])
  const [loadedDate, setLoadedDate] = useState('')
  const [drafts, setDrafts, draftStorage] = useSessionState<Drafts>('client-service.drafts.v1', {}, isDrafts)
  const [researchSource, setResearchSource] = useSessionState<ServiceResearchDraft | null>('client-service.researchSource', researchDraft || null, isServiceResearchDraft)
  const [replacedConclusions, setReplacedConclusions] = useSessionState<ReplacedConclusions>('client-service.replacedConclusions', {}, isReplacedConclusions)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [scheduleError, setScheduleError] = useState(''), [scheduleNotice, setScheduleNotice] = useState('')
  const [retry, setRetry] = useState(0), [previewRetry, setPreviewRetry] = useState(0)
  const [now, setNow] = useState(Date.now)
  const [preview, setPreview] = useState<(CardPreview & {key: string; owner: string}) | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [undo, setUndo] = useState<{ key: string; content: CardContent } | null>(null)
  const mutation = useRef(0)
  const latestCards = useRef(cards)
  latestCards.current = cards
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
  const focusedCopy = card?.generation_focus ? card.market?.commentary : undefined
  const suggestedCopy = focusedCopy ? contentFields.flatMap(({ key, label }) => {
    if (key === 'brand' || key === 'service') return []
    const value = focusedCopy[key]
    return value && value !== content?.[key] ? [{ key, label: instant && key === 'action' ? '盘面主线' : label, value }] : []
  }) : []
  const text = effectiveTemplate && content ? (exportAsDraft ? '【草稿 · 待核对】\n' : '') + cardText(effectiveTemplate, content, card, date) : ''

  useEffect(() => {
    if (!needsSettings) return
    const controller = new AbortController()
    api<ServiceSettings>('/client-service/settings', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setConfig(value); setSchedule(current => current || value); setSettingsError('') }
    }).catch(reason => { if (!controller.signal.aborted) setSettingsError(reason.message) })
    return () => controller.abort()
  }, [retry, needsSettings])

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
    if (serviceView !== 'cards') {
      setSlotDrawerOpen(false)
      setFullscreen(false)
      setSendTarget(null)
    }
  }, [serviceView])

  function openFullscreen() { setFullscreen(true) }

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
    if (!config || !schedule) return
    const editedTemplate = kind === 'template' ? content : undefined
    if (kind === 'template' && (!editedTemplate || !valid || instant)) return
    const reportError = kind === 'schedule' ? setScheduleError : setError
    const reportNotice = kind === 'schedule' ? setScheduleNotice : setNotice
    if (kind === 'schedule' && schedule.templates.some(item => !item.content.brand.trim())) { reportError('请补全每个服务模板的服务名称。'); return }
    setBusy(kind); reportError(''); reportNotice('')
    try {
      const next = editedTemplate
        ? { ...config, templates: config.templates.map(item => item.id === slot ? { ...item, content: { ...editedTemplate, market_overrides: {} } } : item) }
        : { ...schedule, revision: config.revision, templates: schedule.templates.map(item => ({ ...item, content: { ...withFixedDisclosure(item.content), market_overrides: {} } })) }
      const saved = await api<ServiceSettings>('/client-service/settings', { method: 'PUT', body: JSON.stringify(next) })
      setConfig(saved)
      setSchedule(current => kind === 'schedule' ? saved : current && { ...current, revision: saved.revision, templates: current.templates.map(item => ({ ...item, content: same(item.content, config.templates.find(value => value.id === item.id)?.content) ? saved.templates.find(value => value.id === item.id)!.content : item.content })) })
      if (editedTemplate && !card && !Object.keys(editedTemplate.market_overrides ?? {}).length) clearSavedDraft(key, editedTemplate)
      reportNotice(kind === 'template' ? '默认模板已保存，今后此时点沿用当前文案' : '自动生成计划已保存')
    } catch (reason) { reportError((reason as Error).message) }
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
      let value = await api<ServiceCard>('/client-service/cards', { method: 'POST', body: JSON.stringify({
        request_id: crypto.randomUUID(), date, slot_id: slot, regenerate: !!card, model_mode: modelMode,
        generation_focus: generationFocus.trim() || undefined,
      }) })
      replaceCard(value)
      setGenerationFocus('')
      if (!contentEqual(value.content, content)) {
        value = await api<ServiceCard>(`/client-service/cards/${value.id}`, { method: 'PUT', body: JSON.stringify({ revision: value.revision, content }) })
        replaceCard(value)
      }
      clearSavedDraft(key, content); setNotice('采集已开始，关闭页面后任务仍会继续')
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }
  async function generateInstant(sourceCardId?: string) {
    if (busy) return
    setBusy('instant'); setError(''); setNotice('')
    try {
      let value = await api<ServiceCard>('/client-service/briefs', {
        method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID(), theme, model_mode: modelMode,
          generation_focus: generationFocus.trim() || undefined, ...(sourceCardId ? { source_card_id: sourceCardId } : {}) }),
      })
      replaceCard(value)
      setGenerationFocus('')
      setReplaySource(null)
      if (slot === 'realtime' && drafts[key] && content) {
        value = await api<ServiceCard>(`/client-service/cards/${value.id}`, { method: 'PUT', body: JSON.stringify({ revision: value.revision, content }) })
        replaceCard(value); clearSavedDraft(key, content)
      }
      setDate(value.service_date); setSlot(value.slot_id); setPreviewMode('image')
      setNotice(sourceCardId ? '已按原资料截止时间开始重新生成' : '实时股评已启动，Codex 正在检索并生成即时简报')
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
  function changeDate(value: string) {
    if (!value || value === date) return
    setDate(value)
    if (instant) setSlot('checkpoint')
    setGenerationFocus(''); setReplaySource(null); setNotice(''); setUndo(null)
  }
  function selectSlot(value: string) {
    const next = value === 'realtime' ? instantCards[0]?.slot_id || value : value
    setSlot(next)
    if (next !== slot) {
      setGenerationFocus('')
      setReplaySource(null)
    }
    setSlotDrawerOpen(false)
    setNotice('')
    setUndo(null)
    switchPane('edit')
  }
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

  function retrySettings() { setSettingsError(''); setRetry(value => value + 1) }

  if (serviceView === 'robots' || serviceView === 'deliveries') return <ClientServiceLayout key={serviceView} view={serviceView}>
    <ClientRobotPanel historyOnly={serviceView === 'deliveries'} />
  </ClientServiceLayout>

  if (serviceView === 'templates') return <ClientServiceLayout key="templates" view="templates">
    {(settingsError || scheduleError) && <div role="alert" className="workspace-error client-service-feedback">
      <span>{settingsError || scheduleError}</span>
      {settingsError && <button type="button" className="text-button workspace-button" onClick={retrySettings}>重新读取</button>}
    </div>}
    {scheduleNotice && <div role="status" className="workspace-feedback-success client-service-feedback"><Check size={16} />{scheduleNotice}</div>}
    {schedule && config ? <ClientServiceSchedule schedule={schedule} dirty={scheduleDirty} busy={!!busy} saving={busy === 'schedule'}
      onChange={value => { setSchedule(value); setScheduleError(''); setScheduleNotice('') }}
      onReset={() => { setSchedule(config); setScheduleError(''); setScheduleNotice('') }} onSave={() => void saveSettings('schedule')} />
      : !settingsError && <LoadingState label="正在读取生成计划与模板…" />}
  </ClientServiceLayout>

  const ready = !!(config && template && content)
  const templateStatus = settingsError ? null : <LoadingState label="正在读取服务模板…" />
  const slotLabel = effectiveTemplate ? (slot === 'realtime' ? effectiveTemplate.title : `${effectiveTemplate.time} ${effectiveTemplate.title}`) : ''
  const dates = <div className="client-service-actions">
    <div className="client-date-control">
      <button type="button" className="workspace-button" aria-label="前一天" onClick={() => changeDate(shiftDate(date, -1))}><ArrowLeft size={15} /></button>
      <input className="workspace-field" type="date" aria-label="服务日期" value={date} onChange={event => changeDate(event.target.value)} />
      <button type="button" className="workspace-button" aria-label="后一天" onClick={() => changeDate(shiftDate(date, 1))}><ArrowRight size={15} /></button>
      <button type="button" className="workspace-button client-date-reset" disabled={date === beijingDate()} onClick={() => changeDate(beijingDate())}>今天</button>
    </div>
    {config && <button type="button" className="secondary-button workspace-button client-slot-trigger" aria-label={`服务时点${slotLabel ? ` ${slotLabel}` : ''}`}
      aria-haspopup="dialog" aria-expanded={slotDrawerOpen} onClick={() => setSlotDrawerOpen(true)}>
      <PanelRightOpen size={16} aria-hidden="true" /><span>{slotLabel || '服务时点'}</span>
    </button>}
  </div>
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

  return <ClientServiceLayout key="cards" view="cards" pageRef={pageRef} ariaLabel="对客服务内容" actions={dates}>
    {(error || settingsError) && <div role="alert" className="workspace-error client-service-feedback"><AlertCircle size={17} /><span>{error || settingsError}</span><button className="workspace-button text-button" onClick={() => { setError(''); retrySettings() }}>重新读取</button></div>}
    {notice && <div role="status" className="client-service-feedback workspace-feedback-success"><Check size={16} /><span>{notice}</span>{undo?.key === key && <button className="workspace-button text-button" onClick={() => { setDrafts(current => ({ ...current, [key]: undo.content })); setUndo(null); setNotice('已撤销恢复，继续编辑') }}>撤销</button>}</div>}
    {slotDrawerOpen && config && <ConditionWorkspaceDrawer
      title={date === beijingDate() ? '今日服务时点' : `${date} 服务时点`}
      description={loaded ? `固定时点已采集 ${readyCount} / ${config.templates.length} · 即时简报 ${instantCards.length} 份` : '正在读取当日卡片…'}
      closeLabel="关闭服务时点" className="client-service-drawer client-slot-drawer" onClose={() => setSlotDrawerOpen(false)}>
      <nav className="client-slot-list" aria-label="服务时点">
        <button type="button" className="workspace-button" aria-label="实时股评卡片"
          aria-current={instant ? 'page' : undefined} onClick={() => selectSlot('realtime')}>
          <span className="client-slot-top"><Radio size={16} aria-hidden="true" /><strong>即时简报</strong></span>
          <span className={`client-slot-state is-${instantCards[0]?.state || 'empty'}`}>
            <span className="client-status-dot" />{instantCards[0] ? stateLabels[instantCards[0].state] : '随时生成'}
          </span>
        </button>
        {config.templates.map(item => {
          const existing = dayCards.find(value => value.slot_id === item.id)
          const title = existing?.template.title || item.title
          const status = existing ? stateLabels[existing.state] : new Date(`${date}T${item.time}:00+08:00`).getTime() > now ? '未到时点' : '待制作'
          return <button type="button" className="workspace-button" key={item.id}
            aria-current={slot === item.id ? 'page' : undefined} onClick={() => selectSlot(item.id)}>
            <span className="client-slot-top"><time>{existing?.template.time || item.time}</time><strong title={title}>{title}</strong></span>
            <span className={`client-slot-state is-${existing?.state || 'empty'}`}>
              <span className="client-status-dot" />{loaded ? status : '读取中'}
              {drafts[date + ':' + item.id] && <span className="client-draft-tag">草稿</span>}
            </span>
          </button>
        })}
      </nav>
      {!!instantCards.length && <section className="client-instant-history" aria-label="即时简报记录">
        <h3>即时简报记录</h3>
        <nav aria-label="即时简报选择">
          {instantCards.map(item => <button type="button" key={item.id} className="workspace-button"
            aria-current={slot === item.slot_id ? 'page' : undefined} onClick={() => selectSlot(item.slot_id)}>
            <time dateTime={item.cutoff}>资料截止 {new Date(item.cutoff).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time>
            <span>{item.market?.generated_at ? `生成时间 ${marketTime(item.market.generated_at)}` : stateLabels[item.state]}</span>
          </button>)}
        </nav>
      </section>}
    </ConditionWorkspaceDrawer>}
    {!ready && !researchSource && templateStatus}
    {(ready || researchSource) && (
      <ClientServiceStudio pane={pane} onChange={switchPane} label="卡片编辑与预览" showSwitch={ready}>
        <ClientServiceEditor label="卡片编辑" title={effectiveTemplate?.title || '卡片编辑'}
          actions={ready && <button type="button" className="workspace-button text-button" disabled={!dirty || !!busy} onClick={resetDraft}><RotateCcw size={14} />恢复</button>}
          generation={ready && <ClientServiceGeneration mode={modelMode} onModeChange={setModelMode}
            canGenerate={loaded && valid && !futureSlot} busy={pending || busy === 'generate' || busy === 'instant'} locked={!!busy}
            onGenerate={() => void (instant ? generateInstant(card?.id === replaySource ? replaySource : undefined) : generate())}
            focus={{ value: generationFocus, onChange: setGenerationFocus,
              example: '例如，重点看医药板块和成交量，简短说明观察条件。', submitted: card?.generation_focus }} />}
          footer={ready && <>
            <p className="client-editor-status"><span className={`client-status-dot ${dirty ? 'is-draft' : 'is-ready'}`} aria-hidden="true" />
              {dirty ? draftStorage.persisted ? '草稿已暂存本机，尚未保存' : '草稿暂未写入本机，请及时保存' : card ? '与已保存卡片一致' : '正在使用默认模板'}</p>
            <div className="client-editor-actions">
              <button type="button" className="primary-button workspace-button" disabled={!card || !!busy || !dirty || !valid} onClick={() => void saveCard()}><Save size={15} />{busy === 'save' ? '正在保存…' : '保存本次卡片'}</button>
              <button type="button" className="secondary-button workspace-button" disabled={!!busy || !valid || instant} onClick={() => void saveSettings('template')}>{busy === 'template' ? '正在保存…' : '保存为默认模板'}</button>
            </div>
            {!card && <small>采集后可保存本次卡片；提前准备的内容可保存为默认模板。</small>}
          </>}>
          {researchDraftPanel}
          {ready ? <>
          <div className="client-generation-status" role="status">
            <span className={`client-status-dot ${config.enabled ? 'is-ready' : ''}`} aria-hidden="true" />
            {config.enabled ? '自动生成已开启' : '自动生成未开启'} · 北京时间
          </div>
          <section className={`client-market-control ${card?.state === 'failed' ? 'has-error' : ''}`} aria-label="市场快照">
            <div>
              <span className="client-market-icon"><RefreshCw size={17} className={pending ? 'spin' : ''} aria-hidden="true" /></span>
              <div>
                <strong>市场快照 <small>{card ? stateLabels[card.state] : '尚未采集'}</small></strong>
                <p>{futureSlot ? `将于 ${effectiveTemplate?.time} 到达服务时点，可先准备文案。` : card?.message || '采集指数、成交与市场广度，附带信息来源。'}</p>
              </div>
            </div>
            {instant && card && <label className="client-market-option">
              <input type="checkbox" checked={replaySource === card.id} disabled={!!busy || pending}
                onChange={event => setReplaySource(event.target.checked ? card.id : null)} />
              沿用当前简报的资料截止时间
            </label>}
            {suggestedCopy.length > 0 && <details className="client-focused-copy">
              <summary>查看本次 AI 草稿</summary>
              {suggestedCopy.map(item => <div key={item.key}>
                <strong>{item.label}</strong><p>{item.value}</p>
                <button type="button" className="secondary-button workspace-button" disabled={!!busy}
                  onClick={() => update(item.key, item.value)}>采用{item.label}</button>
              </div>)}
            </details>}
          </section>
          <div className="client-content-fields client-identity-fields">{field('brand')}{field('headline')}</div>
          <div className="client-section-heading"><h3>核心内容</h3><span>{filled} / 3 项已填写</span></div>
          <div className="client-content-fields">
            {field('conclusion')}
            {replacement && content.conclusion === replacement.after && <button type="button" className="text-button workspace-button client-replacement-undo" onClick={undoResearchExcerpt}><RotateCcw size={13} />撤销替换今日判断</button>}
            {field('action')}{field('focus')}
          </div>
          <details className="client-brand-details"><summary>服务落款与风险提示<span>R4 · 固定展示</span></summary><div className="client-content-fields">{field('service')}</div><section className="client-fixed-disclosure" aria-label="固定风险提示与投顾信息"><header><strong>风险提示</strong><span>R4</span></header><p>{fixedDisclosure.risk}</p><div>{disclosureLines.slice(1).map(line => <p key={line}>{line}</p>)}</div><small>所有时点、套图和导出文案均固定附带以上信息。</small></section></details>
          </> : templateStatus}
        </ClientServiceEditor>
        {ready && <ClientServicePreview label="卡片预览" title={exportAsDraft ? '草稿预览' : '成品预览'}
          toolbar={<>
            <button type="button" className="secondary-button workspace-button" disabled={!currentPreview || !!previewError} onClick={openFullscreen}><Maximize2 size={14} />全屏查看</button>
            <ClientCardPreviewSwitch mode={previewMode} onChange={setPreviewMode} />
          </>}
          meta={<>
            <span>{themeLabel}{previewMode === 'image' && ' · 点击图片文字可编辑'}</span>
            {previewMode === 'image' && <span>{!valid ? '等待填写服务名称' : currentPreview ? `${currentPreview.width} × ${currentPreview.height} px` : previewError ? '预览暂不可用' : '正在同步…'}</span>}
          </>}
          status={<p>{exportAsDraft ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}{exportAsDraft ? `草稿 · ${draftReason}` : '成品 · 市场已核对，内容已保存'}</p>}
          actions={<>
            <button className="secondary-button workspace-button" disabled={!valid || !loaded} onClick={() => void copy()}><Copy size={15} />{exportAsDraft ? '复制草稿文案' : '复制文案'}</button>
            <button className="primary-button workspace-button" disabled={!currentPreview || !!previewError} onClick={download}><Download size={15} />{downloadLabel}</button>
            {!exportAsDraft && <button type="button" className="secondary-button workspace-button" aria-haspopup="dialog" disabled={!readyToSend} onClick={() => setSendTarget(readyToSend)}><Send size={15} aria-hidden="true" />发送到群</button>}
          </>}
          themes={<ClientThemePicker theme={theme} onSelect={value => update('theme', value)} caption="每套含 7 款时点插画"
            thumbnail={id => <span className="client-theme-thumbnail" style={{ backgroundImage: `url(/client-service/themes/${id}-logo-safe.png)`, backgroundPosition: cardArtworkPosition(slot) }} />}
            footer={<><span>已匹配{effectiveTemplate?.title}底图</span><button type="button" className="text-button workspace-button" disabled={!!busy} onClick={() => void saveThemeCollection()}>{busy === 'theme' ? '正在保存…' : '设为全时点默认'}</button></>} />}>
          {previewError && <div role="alert" className="workspace-error client-service-feedback"><span>{previewError}</span><button className="workspace-button text-button" onClick={() => setPreviewRetry(value => value + 1)}>重试预览</button></div>}
          {previewMode === 'image' ? <ClientCardImageStage pending={valid && !currentPreview && !previewError} onStep={switchTheme}>
            {visiblePreview ? <EditableClientCard key={key} preview={visiblePreview} content={content} alt={`${content.brand} ${content.headline || effectiveTemplate?.title}时点卡预览`} onApply={applyImageEdits} onFullscreen={openFullscreen} />
              : <div className="client-preview-placeholder"><Image size={26} aria-hidden="true" /><p>{!valid ? '填写服务名称后，即可预览卡片' : previewError ? '修改内容或重试以恢复图片预览' : '正在排版当前内容…'}</p></div>}
          </ClientCardImageStage> : <div className="client-text-preview" aria-label="文案预览"><pre>{text}</pre></div>}
          <div className="client-preview-details">
            {card?.market && <details className="client-evidence-details">
              <summary>市场来源与时点<span>{card.market.sources.length} 个来源 · {card.market.quality === 'partial' ? '部分待核实' : '已核对'}</span></summary>
              <section className="client-market-evidence" aria-label="市场来源与时点">
                <p>资料截止 {marketTime(card.cutoff)}（北京时间）</p>
                {card.market.generated_at && <p>生成时间 {marketTime(card.market.generated_at)}（北京时间）</p>}
                <dl>{(card.market.raw_metrics || card.market.metrics).map((metric, index) => <div key={index}><dt>{metric.label}</dt><dd>{metric.value}{metric.observed_at && <small>行情时点 {marketTime(metric.observed_at)}</small>}</dd></div>)}</dl>
                <ul>{card.market.sources.map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul>
                {!!card.market.limitations.length && <p>{card.market.limitations.join('；')}</p>}
              </section>
            </details>}
            {currentPreview?.checks?.state==='warning'&&<p className="client-layout-warning" role="status">排版提示：{[...new Set(currentPreview.checks.issues.map(issue=>issue.message))].join('；')}。</p>}
            <ClientCardReview card={card} dirty={dirty} imageHash={exportAsDraft ? currentPreview?.saved_image_hash : currentPreview?.image_hash} />
          </div>
        </ClientServicePreview>}
      </ClientServiceStudio>
    )}
    {fullscreen && <ClientCardFullscreen title={exportAsDraft ? '草稿全屏预览' : '成品全屏预览'}
      description={`${themeLabel} · ${content?.headline || effectiveTemplate?.title || '时点卡'}`} theme={themeLabel}
      downloadLabel={downloadLabel} canDownload={!!currentPreview && !previewError} onDownload={download} onStep={switchTheme}
      onClose={() => setFullscreen(false)}>
      {mode => visiblePreview ? <EditableClientCard key={key} preview={visiblePreview} content={content!} alt={exportAsDraft ? '全屏草稿图片' : '全屏成品图片'} mode={mode} onApply={applyImageEdits} />
        : previewError ? <div role="alert" className="client-fullscreen-error"><p>{previewError}</p><button className="workspace-button" onClick={() => setPreviewRetry(value => value + 1)}>重试预览</button></div> : <LoadingState label="正在同步卡片图片…" />}
    </ClientCardFullscreen>}
    {sendTarget && <ClientCardSendDialog
      card={sendTarget.card}
      kind={sendTarget.kind}
      preview={sendTarget.image}
      canSend={!!readyToSend && readyToSend.card.id === sendTarget.card.id && readyToSend.card.revision === sendTarget.card.revision && readyToSend.previewKey === sendTarget.previewKey}
      onClose={() => setSendTarget(null)}
      onManage={() => { setSendTarget(null); setNotice(''); changeView('robots') }}
    />}
  </ClientServiceLayout>
}
