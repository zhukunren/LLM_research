import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Download, Image, PartyPopper } from 'lucide-react'
import { api } from '../api'
import { marketTime, type CardPreview } from '../clientService'
import { ClientCardImageStage } from '../components/ClientCardPreview'
import LoadingState from '../components/LoadingState'
import { useSessionState } from '../useSessionState'
import ClientServiceLayout, { ClientServiceEditor, ClientServicePreview, ClientServiceStudio, useClientServicePane } from './ClientServiceLayout'
import './celebration.css'

const modes = [
  { id: 'close', label: '收盘涨超', description: '最近已收盘交易日' },
  { id: 'intraday_high', label: '盘中最高', description: '截至行情时点' },
] as const
const themes = [
  { id: 'red_gold', label: '经典红金', thumbnail: '/client-service/celebrations/soochow-red-thumbnail.webp' },
  { id: 'blue_gold', label: '蓝金建筑', thumbnail: '/client-service/celebrations/soochow-blue-thumbnail.webp' },
] as const
type Mode = typeof modes[number]['id']
type Theme = typeof themes[number]['id']
type Draft = { portfolioName: string; code: string; mode: Mode; theme?: Theme }
type Poster = CardPreview & {
  code: string; stock_name: string; mode_label: string; change_percent: string; trade_date: string
  theme: Theme; closing_threshold: string | null; observed_at: string; source: string; source_url: string
}
const initial: Draft = { portfolioName: '', code: '', mode: 'intraday_high' }
const codePattern = /^[0-9]{6}(?:\.(SH|SZ|BJ))?$/
const compactStudioQuery = '(max-width: 850px)'

function subscribeToStudioWidth(onChange: () => void) {
  const media = window.matchMedia?.(compactStudioQuery)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}

const compactStudio = () => window.matchMedia?.(compactStudioQuery).matches ?? false

function validDraft(value: unknown): value is Draft {
  const draft = value as Partial<Draft> | null
  return !!draft && typeof draft.portfolioName === 'string' && typeof draft.code === 'string'
    && modes.some(mode => mode.id === draft.mode)
    && (draft.theme === undefined || themes.some(theme => theme.id === draft.theme))
}

export default function CelebrationPage() {
  const [draft, setDraft] = useSessionState('client-service.celebration.draft', initial, validDraft)
  const [poster, setPoster] = useState<Poster | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { pageRef, pane, switchPane } = useClientServicePane()
  const codeHelp = useId()
  const compact = useSyncExternalStore(subscribeToStudioWidth, compactStudio)
  const activeRequest = useRef<AbortController | null>(null)
  useEffect(() => () => activeRequest.current?.abort(), [])

  const code = draft.code.trim().toUpperCase()
  const codeReady = codePattern.test(code)
  const portfolioName = draft.portfolioName.trim()
  const theme = draft.theme ?? themes[0].id
  const riseLabel = poster?.closing_threshold ? '实际收盘涨幅' : '盘中最高涨幅'

  function update(patch: Partial<Draft>) {
    setDraft(previous => ({ ...previous, ...patch }))
    setPoster(null)
    setError('')
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (activeRequest.current || !portfolioName || !codeReady) return
    const controller = new AbortController()
    activeRequest.current = controller
    setBusy(true)
    setError('')
    setPoster(null)
    try {
      const result = await api<Poster>('/client-service/celebrations', {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ portfolio_name: portfolioName, code, mode: draft.mode, theme }),
      })
      if (!controller.signal.aborted) {
        setPoster(result)
        switchPane('preview')
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '喜报暂未生成，请重试。')
        switchPane('edit')
      }
    } finally {
      activeRequest.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const themeOptions = <fieldset className="celebration-options celebration-themes" disabled={busy}>
    <legend>选择套图</legend>
    <div>{themes.map(option => <label key={option.id}>
      <img src={option.thumbnail} alt="" width={144} height={256} />
      <span>
        <input type="radio" name="celebration-theme" value={option.id} checked={theme === option.id}
          onChange={() => update({ theme: option.id })} />
        <strong>{option.label}</strong>
      </span>
    </label>)}</div>
  </fieldset>

  return <ClientServiceLayout view="celebrations" pageRef={pageRef}>
    <ClientServiceStudio pane={pane} onChange={switchPane} label="喜报编辑与预览">
      <ClientServiceEditor title="喜报内容" label="生成喜报" onSubmit={generate} footer={<>
        {error && <div className="workspace-error client-service-feedback" role="alert">{error}</div>}
        <div className="client-editor-actions">
          <button type="submit" className="primary-button workspace-button" disabled={busy || !portfolioName || !codeReady}>
            <PartyPopper size={17} aria-hidden="true" />{busy ? '正在生成…' : '生成喜报'}
          </button>
        </div>
      </>}>
        <div className="client-content-fields">
          <label><span>组合名称</span>
            <input className="workspace-field" value={draft.portfolioName} required maxLength={32}
              placeholder="如 行业轮动掘金" disabled={busy} onChange={event => update({ portfolioName: event.target.value })} />
          </label>
          <div className="celebration-code-field">
            <label><span>股票代码</span>
              <input className="workspace-field" value={draft.code} required maxLength={9} placeholder="如 300315"
                spellCheck={false} autoCapitalize="characters" aria-describedby={codeHelp} aria-invalid={!!code && !codeReady}
                disabled={busy} onChange={event => update({ code: event.target.value })} />
            </label>
            <small id={codeHelp}>6 位 A 股代码，可带 .SH、.SZ 或 .BJ 后缀</small>
          </div>
        </div>
        <fieldset className="celebration-options celebration-modes" disabled={busy}>
          <legend>行情口径</legend>
          <div>
            {modes.map(mode => <label key={mode.id}>
              <input type="radio" name="celebration-mode" value={mode.id} checked={draft.mode === mode.id}
                onChange={() => update({ mode: mode.id })} aria-label={mode.label} />
              <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
            </label>)}
          </div>
        </fieldset>
        {compact && themeOptions}
      </ClientServiceEditor>
      <ClientServicePreview label="喜报图片" title="喜报预览" busy={busy}
        themes={!compact && <aside className="client-theme-picker celebration-theme-rail" aria-label="喜报套图">{themeOptions}</aside>}
        meta={poster && <>
          <span>行情时点 {marketTime(poster.observed_at)}（北京时间）</span>
          <a href={poster.source_url} target="_blank" rel="noreferrer">{poster.source}</a>
        </>}
        actions={poster ? <a className="primary-button workspace-button" href={poster.image}
            download={`喜报-${poster.trade_date}-${poster.code.split('.')[0]}-${poster.mode_label}${poster.theme === 'blue_gold' ? '-蓝金建筑' : ''}.png`}>
          <Download size={16} aria-hidden="true" />下载 PNG
        </a> : <button type="button" className="primary-button workspace-button" disabled><Download size={16} aria-hidden="true" />下载 PNG</button>}>
        <ClientCardImageStage pending={busy}>
          {poster ? <img className="celebration-poster" src={poster.image} width={poster.width} height={poster.height}
            alt={`${poster.stock_name} ${riseLabel} ${poster.change_percent} 的喜报`} />
            : busy ? <LoadingState label="正在核对行情并排版…" />
            : <div className="client-preview-placeholder"><Image size={28} aria-hidden="true" /><p>填写组合名称和股票代码后生成喜报</p></div>}
        </ClientCardImageStage>
      </ClientServicePreview>
    </ClientServiceStudio>
  </ClientServiceLayout>
}
