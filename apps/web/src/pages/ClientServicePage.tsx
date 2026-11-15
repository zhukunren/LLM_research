import { useEffect, useRef, useState } from 'react'
import { Check, Clock3, Copy, Download, Image, RefreshCw, Save, Send } from 'lucide-react'
import { api } from '../api'
import LoadingState from '../components/LoadingState'
import { useWorkspaceSession } from '../WorkspaceSession'
import { useSessionState } from '../useSessionState'
import { beijingDate, cardText, contentFields, marketTime, type CardContent, type ServiceCard, type ServiceSettings } from '../clientService'
import './client-service.css'

type Drafts = Record<string, CardContent>
function isDrafts(value: unknown): value is Drafts {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item =>
    !!item && typeof item === 'object' && contentFields.every(field => typeof item[field.key] === 'string' && item[field.key].length <= field.max))
}
const stateLabels = { awaiting_agent: '等待采集', running: '采集中', ready: '已生成', failed: '采集失败' }

export default function ClientServicePage() {
  const { active } = useWorkspaceSession()
  const [config, setConfig] = useState<ServiceSettings | null>(null)
  const [date, setDate] = useState(beijingDate)
  const [slot, setSlot] = useState('checkpoint')
  const [cards, setCards] = useState<ServiceCard[]>([])
  const [drafts, setDrafts] = useSessionState<Drafts>('client-service.drafts.v1', {}, isDrafts)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('')
  const [retry, setRetry] = useState(0)
  const [preview, setPreview] = useState<{ image: string; width: number; height: number; key: string } | null>(null)
  const [previewError, setPreviewError] = useState('')
  const previousPreview = useRef('')
  const editor = useRef<HTMLElement>(null), previewPanel = useRef<HTMLElement>(null)
  const template = config?.templates.find(item => item.id === slot)
  const card = cards.find(item => item.slot_id === slot && item.service_date === date)
  const key = date + ':' + slot
  const content = drafts[key] || card?.content || template?.content
  const effectiveTemplate = card?.template || template
  const previewBody = effectiveTemplate && content ? JSON.stringify({ template: effectiveTemplate, date, content, card_id: card?.id || null }) : ''
  const previewKey = previewBody + JSON.stringify(card?.market || null)
  const pending = card?.state === 'awaiting_agent' || card?.state === 'running'
  const futureSlot = !!effectiveTemplate && new Date(card?.cutoff || `${date}T${effectiveTemplate.time}:00+08:00`).getTime() > Date.now()
  const dirty = !!content && !!card && JSON.stringify(content) !== JSON.stringify(card.content)

  useEffect(() => {
    const controller = new AbortController()
    api<ServiceSettings>('/client-service/settings', { signal: controller.signal }).then(setConfig)
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setCards([])
    async function load() {
      try {
        const result = await api<{ items: ServiceCard[] }>(`/client-service/cards?date=${date}`, { signal: controller.signal })
        if (!controller.signal.aborted) setCards(result.items)
      } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message) }
      if (!controller.signal.aborted) timer = setTimeout(() => { if (document.hidden) timer = setTimeout(load, 10000); else void load() }, 5000)
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [date, retry, active])

  useEffect(() => {
    if (!previewBody || !active) return
    const controller = new AbortController()
    previousPreview.current = previewKey
    const timer = setTimeout(() => {
      setPreviewError('')
      void api<{ image: string; width: number; height: number }>('/client-service/preview', { method: 'POST', signal: controller.signal, body: previewBody })
        .then(value => { if (!controller.signal.aborted && previousPreview.current === previewKey) setPreview({ ...value, key: previewKey }) })
        .catch(reason => { if (!controller.signal.aborted) setPreviewError(reason.message) })
    }, 220)
    return () => { clearTimeout(timer); controller.abort() }
  }, [previewBody, previewKey, active])

  function update(field: keyof CardContent, value: string) {
    if (!content) return
    setDrafts(current => ({ ...current, [key]: { ...content, [field]: value } }))
    setNotice('')
  }
  function replaceCard(value: ServiceCard) { setCards(current => [...current.filter(item => item.id !== value.id), value]) }
  async function saveCard() {
    if (!card || !content) return
    setBusy('save'); setError(''); setNotice('')
    try {
      const value = await api<ServiceCard>(`/client-service/cards/${card.id}`, { method: 'PUT', body: JSON.stringify({ revision: card.revision, content }) })
      replaceCard(value); setNotice('本次卡片已保存')
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }
  async function saveTemplate() {
    if (!config || !content) return
    setBusy('template'); setError(''); setNotice('')
    try {
      const next = { ...config, templates: config.templates.map(item => item.id === slot ? { ...item, content } : item) }
      setConfig(await api<ServiceSettings>('/client-service/settings', { method: 'PUT', body: JSON.stringify(next) }))
      setNotice('默认模板和生成计划已保存')
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }
  async function generate() {
    if (!content) return
    setBusy('generate'); setError(''); setNotice('')
    try {
      let value = await api<ServiceCard>('/client-service/cards', { method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID(), date, slot_id: slot, regenerate: !!card }) })
      if (JSON.stringify(value.content) !== JSON.stringify(content)) {
        value = await api<ServiceCard>(`/client-service/cards/${value.id}`, { method: 'PUT', body: JSON.stringify({ revision: value.revision, content }) })
      }
      replaceCard(value); setNotice('采集已开始，关闭页面后任务仍会继续')
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }
  async function copy() {
    if (!effectiveTemplate || !content) return
    try { await navigator.clipboard.writeText(cardText(effectiveTemplate, content, card, date)); setNotice('当前文案已复制') }
    catch { setError('复制失败，请稍后重试。') }
  }
  function download() {
    if (!preview || preview.key !== previewKey) return
    const link = document.createElement('a')
    link.href = preview.image; link.download = `market-card-${date}-${slot}.png`; link.click()
  }

  return <div className="page-content workspace-tool-page client-service-page" role="region" aria-label="对客服务内容" tabIndex={0}>
    <header className="client-service-heading"><div><h1><Send size={23} />对客服务</h1><p>市场状态由 Codex 采集，其余内容按您的服务模板呈现。</p></div><label>服务日期<input className="workspace-field" type="date" aria-label="服务日期" value={date} onChange={event => { if (event.target.value) { setDate(event.target.value); setNotice('') } }} /></label></header>
    {error && <div role="alert" className="workspace-error client-service-feedback"><span>{error}</span><button className="text-button workspace-button" onClick={() => { setError(''); setRetry(value => value + 1) }}>重新读取</button></div>}
    {notice && <p role="status" className="client-service-feedback workspace-feedback-success"><Check size={16} />{notice}</p>}
    {!config || !template || !content ? <LoadingState label="正在读取服务模板…" /> : <>
      <nav className="client-slot-tabs" aria-label="服务时点">{config.templates.map(item => {
        const existing = cards.find(value => value.slot_id === item.id)
        return <button className="workspace-button" key={item.id} aria-current={slot === item.id ? 'page' : undefined} onClick={() => { setSlot(item.id); setNotice('') }}><time>{existing?.template.time || item.time}</time><strong>{existing?.template.title || item.title}</strong><small className={existing?.state === 'ready' ? 'is-ready' : ''}>{existing ? stateLabels[existing.state] : '尚未生成'}</small></button>
      })}</nav>
      <div className="client-service-studio">
        <aside ref={editor} className="client-card-editor" aria-label="卡片编辑"><div className="client-editor-title"><h2>编辑内容</h2><span>{dirty ? '本次修改待保存' : '修改后同步预览'}</span><button className="text-button workspace-button client-mobile-jump" onClick={() => previewPanel.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>查看预览</button></div>
          <section className="client-market-control" aria-label="市场采集"><div><strong>市场状态</strong><span>{card ? stateLabels[card.state] : '尚未采集'}</span></div><p>{futureSlot ? '尚未到所选服务时点，可以先编辑内容和模板。' : card?.message || '核对当前时点的指数、成交与市场广度，并保留来源。'}</p><button type="button" className="primary-button workspace-button" disabled={!!busy || pending || futureSlot || date > beijingDate()} onClick={() => void generate()}><RefreshCw size={15} className={pending ? 'spin' : ''} />{pending ? 'Codex 正在采集…' : card ? '重新采集市场状态' : 'Codex 采集市场状态'}</button></section>
          <div className="client-content-fields">{contentFields.map(field => <label key={field.key}><span>{field.label}<small>{content[field.key].length}/{field.max}</small></span>{field.rows ? <textarea className="workspace-field" aria-label={field.label} value={content[field.key]} rows={field.rows} maxLength={field.max} onChange={event => update(field.key, event.target.value)} placeholder={`填写${field.label}`} /> : <input className="workspace-field" aria-label={field.label} value={content[field.key]} maxLength={field.max} onChange={event => update(field.key, event.target.value)} placeholder={field.key === 'headline' ? effectiveTemplate?.title : field.label} />}</label>)}</div>
          <div className="client-editor-actions"><button className="primary-button workspace-button" disabled={!card || !!busy || !dirty} onClick={() => void saveCard()}><Save size={15} />保存本次卡片</button><button className="secondary-button workspace-button" disabled={!!busy} onClick={() => void saveTemplate()}>保存为默认模板</button></div>
        </aside>
        <section ref={previewPanel} className="client-preview-panel" aria-label="图片预览"><header><div><h2><Image size={18} />时点卡预览</h2><p>{preview && preview.key === previewKey ? `${preview.width} × ${preview.height} 像素` : '正在同步当前内容…'}</p></div><div><button className="secondary-button workspace-button client-mobile-jump" onClick={() => editor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>返回编辑</button><button className="secondary-button workspace-button" onClick={() => void copy()}><Copy size={15} />复制文案</button><button className="primary-button workspace-button" disabled={!preview || preview.key !== previewKey || !!previewError} onClick={download}><Download size={15} />下载 PNG</button></div></header>
          {previewError && <p role="alert" className="workspace-error">{previewError}</p>}
          <div className="client-card-canvas" aria-busy={!preview || preview.key !== previewKey}>{preview ? <img src={preview.image} alt={`${content.brand} ${content.headline || effectiveTemplate?.title}时点卡预览`} width={preview.width} height={preview.height} /> : <LoadingState label="正在生成图片预览…" />}</div>
          {card?.market && <section className="client-market-evidence" aria-label="市场来源与时点"><h3>市场来源与时点</h3><p>信息截至 {marketTime(card.cutoff)}（北京时间）{card.market.quality === 'partial' ? ' · 部分数据待核实' : ''}</p><dl>{card.market.metrics.map((metric, index) => <div key={index}><dt>{metric.label}</dt><dd>{metric.value}{metric.observed_at && <small>数据时点 {marketTime(metric.observed_at)}</small>}</dd></div>)}</dl><ul>{card.market.sources.map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul>{!!card.market.limitations.length && <p>{card.market.limitations.join('；')}</p>}</section>}
        </section>
      </div>
      <section className="client-schedule" aria-label="每日生成计划"><header><div><h2><Clock3 size={18} />每日生成计划</h2><p>北京时间，页面关闭后仍按计划运行。09:45 和午间卡生成后由您判断是否使用。</p></div><label><input type="checkbox" checked={config.enabled} onChange={event => setConfig({ ...config, enabled: event.target.checked })} />开启每日自动生成</label></header>
        <div className="client-weekdays" role="group" aria-label="生成日期">{['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((day, index) => <label key={day}><input type="checkbox" checked={config.weekdays.includes(index)} onChange={event => setConfig({ ...config, weekdays: event.target.checked ? [...config.weekdays, index].sort() : config.weekdays.filter(value => value !== index) })} />{day}</label>)}</div>
        <div className="client-schedule-times">{config.templates.map(item => <label key={item.id}><span><input type="checkbox" checked={item.enabled} onChange={event => setConfig({ ...config, templates: config.templates.map(value => value.id === item.id ? { ...value, enabled: event.target.checked } : value) })} />{item.title}</span><input type="time" aria-label={`${item.title}生成时间`} className="workspace-field" value={item.time} onChange={event => { if (event.target.value) setConfig({ ...config, templates: config.templates.map(value => value.id === item.id ? { ...value, time: event.target.value } : value) }) }} /></label>)}</div>
        <button type="button" className="secondary-button workspace-button" disabled={!!busy || !config.weekdays.length} onClick={() => void saveTemplate()}><Save size={15} />保存模板和计划</button>
      </section>
    </>}
  </div>
}
