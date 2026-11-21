import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Check, Copy, Download, Image, Maximize2, Send, Sparkles } from 'lucide-react'
import { api } from '../api'
import { cardThemes, disclosureLines, marketTime, withoutWebLinks, type CardTheme, type RebalanceCardContent } from '../clientService'
import { ClientCardFullscreen, ClientCardImageStage, ClientCardPreviewSwitch, type CardPreviewMode } from '../components/ClientCardPreview'
import { ClientBroadcastPanel } from '../components/ClientRobotOperations'
import ClientThemePicker from '../components/ClientThemePicker'
import ConditionWorkspaceDrawer from '../components/ConditionWorkspaceDrawer'
import EditableClientCard from '../components/EditableClientCard'
import LoadingState from '../components/LoadingState'
import { useSecurities } from '../components/StockSearch'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import { useClientCardPreview } from '../useClientCardPreview'
import { useClientServiceCollection } from '../useClientServiceCollection'
import { useRemoteResource } from '../useRemoteResource'
import { useSessionState } from '../useSessionState'
import { useWorkspaceSession } from '../WorkspaceSession'
import './client-service.css'
import './rebalance-suggestion.css'

const endpoint = '/client-service/rebalance-suggestions'
const codePattern = /^[0-9]{6}(?:\.(SH|SZ|BJ))?$/
const modes = [
  { id: 'instant', label: '即时', model: 'GPT-6.2 Astra · Low · Fast' },
  { id: 'deep', label: '深度', model: 'GPT-6.2 Sol · Max' },
] as const
type Mode = typeof modes[number]['id']
type Quote = { code: string; price: string; observed_at: string; source: string; kind: 'live' | 'latest' | 'close' }
const initial = {
  product: '丰收成长尊享（全账户）', code: '', name: '', direction: '',
  before: '', after: '', price: '', reason: '', basis: '',
}
type Fields = typeof initial
type Draft = Fields & { appliedRequest: string; theme?: CardTheme; mode?: Mode; quote?: Quote }
const initialDraft: Draft = { ...initial, appliedRequest: '' }
const directions = ['开仓买入', '加仓', '减仓', '止盈调出', '止损调出', '调出']
type Request = { id: string; code: string; direction: string; accepted: boolean; mode?: Mode }
type Report = { document_id?: string; url?: string; title: string; broker: string; authors: string; publication_date: string }
type Evidence = { url: string; title: string; published_at: string | null; quote: string }
type Collected = {
  state: 'succeeded'; reason: string; basis: string; report?: Report | null; sources?: Evidence[]
  market?: { trade_date: string; close: string; pct_change: string | null } | null
}
type Status = {
  request_id: string; code: string; stock_name: string; direction: string; cutoff: string; message: string; mode?: Mode | null
} & (Collected | { state: 'awaiting_agent' | 'running' | 'no_evidence' | 'failed' | 'cancelled' })
type SuccessfulStatus = Extract<Status, Collected>
type Broadcast = { text: string; card?: RebalanceCardContent; image?: string }

const normalizeCode = (code: string) => code.trim().toUpperCase()
const submission = (request: Request) => ({ request_id: request.id, code: request.code, direction: request.direction, mode: request.mode })
const clean = (value: string) => withoutWebLinks(value).trim()
const priceValid = (value: string) => /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0

function validQuote(value: unknown): value is Quote {
  const quote = value as Partial<Quote> | null
  return !!quote && typeof quote.code === 'string' && codePattern.test(quote.code)
    && typeof quote.price === 'string' && priceValid(quote.price)
    && typeof quote.observed_at === 'string' && Number.isFinite(Date.parse(quote.observed_at))
    && typeof quote.source === 'string' && ['live', 'latest', 'close'].includes(quote.kind || '')
}

function validDraft(value: unknown): value is Draft {
  const draft = value as Partial<Draft> | null
  return !!draft && typeof draft === 'object' && Object.keys(initial).every(key => typeof draft[key as keyof Fields] === 'string')
    && typeof draft.appliedRequest === 'string' && (!draft.theme || cardThemes.some(item => item.id === draft.theme))
    && (!draft.mode || modes.some(item => item.id === draft.mode)) && (!draft.quote || validQuote(draft.quote))
}

function validRequest(value: unknown): value is Request | null {
  if (value === null) return true
  const item = value as Partial<Request> | undefined
  return typeof item?.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(item.id)
    && typeof item.code === 'string' && codePattern.test(item.code) && typeof item.direction === 'string'
    && typeof item.accepted === 'boolean' && (!item.mode || modes.some(mode => mode.id === item.mode))
}

function percentage(input: string) {
  const value = input.trim().replace(/[％%]$/, '').trim()
  return /^[0-9]{1,3}(?:\.[0-9]+)?$/.test(value) && Number(value) <= 100 ? value + '%' : ''
}

function sameStock(first: string, second: string) {
  const a = normalizeCode(first), b = normalizeCode(second)
  return a === b || (a.slice(0, 6) === b.slice(0, 6) && (a.length === 6 || b.length === 6))
}

function matchesDraft(status: Status, draft: Draft) {
  return status.direction === clean(draft.direction) && sameStock(status.code, draft.code)
    && (!status.mode || status.mode === (draft.mode || 'instant'))
}

function applyCollection(draft: Draft, result: SuccessfulStatus) {
  return { ...draft, name: draft.name || result.stock_name, reason: result.reason, basis: result.basis, appliedRequest: result.request_id }
}

export default function RebalanceSuggestionPage() {
  const { active } = useWorkspaceSession()
  const { items } = useSecurities()
  const [draft, setDraft] = useSessionState('client-service.rebalance.draft', initialDraft, validDraft)
  const [request, setRequest] = useSessionState<Request | null>('client-service.rebalance.request', null, validRequest)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [basisOpen, setBasisOpen] = useState(false)
  const [previewMode, setPreviewMode] = useState<CardPreviewMode>('image')
  const [mobilePane, setMobilePane] = useState<'edit' | 'preview'>('edit')
  const [fullscreen, setFullscreen] = useState(false)
  const pageRef = useRef<HTMLDivElement>(null)
  const mobileScroll = useRef<Partial<Record<typeof mobilePane, number>>>({})
  const [quoteBusy, setQuoteBusy] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [quoteRefresh, setQuoteRefresh] = useState(0)
  const consumedRefresh = useRef(0)
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null)
  const [sending, setSending] = useState(false)
  const robots = useRemoteResource<{ items: { id: string; name: string; enabled: boolean }[] }>(
    broadcast ? '/client-service/robots' : null,
  )

  const onResult = useCallback((value: Status) => {
    if (value.state !== 'succeeded') return
    setDraft(current => {
      if (!matchesDraft(value, current) || current.appliedRequest === value.request_id) return current
      return current.reason.trim() || current.basis.trim()
        ? { ...current, name: current.name || value.stock_name }
        : applyCollection(current, value)
    })
  }, [setDraft])
  const { current, error, busy, stopping, begin, stop, retry, stopError } = useClientServiceCollection(endpoint, request, setRequest, submission, onResult)
  const collection = current?.state === 'succeeded' && matchesDraft(current, draft) ? current : null
  const code = normalizeCode(draft.code)
  const direction = clean(draft.direction)
  const matchingStocks = useMemo(() => codePattern.test(code) ? items.filter(item =>
    item.market !== '指数' && (item.stock_code === code || item.stock_code.slice(0, 6) === code),
  ) : [], [code, items])
  const name = clean(draft.name) || (matchingStocks.length === 1 ? clean(matchingStocks[0].name) : '')
  const codeReady = codePattern.test(code) && matchingStocks.length <= 1
  const before = percentage(draft.before), after = percentage(draft.after)
  const price = draft.price.trim()
  const priceReady = priceValid(price)
  const ready = !!(clean(draft.product) && codeReady && name && direction && before && after && priceReady)
  const mode = draft.mode || 'instant'
  const theme = draft.theme || 'river'
  const themeLabel = cardThemes.find(item => item.id === theme)!.name
  const selectedMode = modes.find(item => item.id === mode)
  const quote = draft.quote && sameStock(draft.quote.code, code) && draft.quote.price === price ? draft.quote : null
  const imageValues: Fields = { product: draft.product, code, name, direction, before: draft.before, after: draft.after,
    price: draft.price, reason: draft.reason, basis: draft.basis }
  const card: RebalanceCardContent = { ...imageValues, theme }
  const { preview: currentPreview, visible: visiblePreview, error: previewError, retry: retryPreview } =
    useClientCardPreview(endpoint + '/preview', JSON.stringify(card))

  const text = [
    [
      `投顾产品：${clean(draft.product)}`,
      `股票名称：${[name, codeReady ? code.slice(0, 6) : ''].filter(Boolean).join(' ')}`,
      `调仓方向：${direction}`,
      `仓位变化：${before || after ? before + '—' + after : ''}`,
      `参考价格：${priceReady ? price : ''}`,
    ].join('\n'),
    clean(draft.reason) && `调仓理由：${clean(draft.reason)}`,
    clean(draft.basis) && `调仓依据：${clean(draft.basis)}`,
    disclosureLines.join('\n'),
  ].filter(Boolean).join('\n\n')

  useEffect(() => {
    setQuoteError('')
    setQuoteBusy(false)
    if (!active || !codeReady) return
    const original = draftRef.current
    const refresh = quoteRefresh !== consumedRefresh.current
    if (!refresh && original.price && !original.quote) return
    consumedRefresh.current = quoteRefresh
    const controller = new AbortController()
    setQuoteBusy(true)
    const timer = setTimeout(() => {
      api<Quote>(endpoint + '/quote?code=' + encodeURIComponent(code), { signal: controller.signal })
        .then(value => {
          if (controller.signal.aborted) return
          if (!validQuote(value) || !sameStock(value.code, code)) throw new Error('暂时没有可核对的报价。')
          setDraft(current => normalizeCode(current.code) === code && current.price === original.price && current.quote === original.quote
            ? { ...current, price: value.price, quote: value } : current)
        }).catch(reason => { if (!controller.signal.aborted) setQuoteError((reason as Error).message) })
        .finally(() => { if (!controller.signal.aborted) setQuoteBusy(false) })
    }, 180)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, code, codeReady, quoteRefresh, setDraft])

  function change(field: keyof Fields, value: string) {
    setNotice('')
    if (field === 'code') setQuoteError('')
    setDraft(current => {
      const differentStock = field === 'code' && !!current.code && !sameStock(current.code, value)
      const differentDirection = field === 'direction' && clean(current.direction) !== clean(value)
      const resetReason = !!current.appliedRequest && (differentStock || differentDirection)
      return { ...current,
        ...(differentStock ? { name: '', price: '', quote: undefined } : {}),
        ...(resetReason ? { reason: '', basis: '', appliedRequest: '' } : {}),
        ...(field === 'price' ? { quote: undefined } : {}),
        [field]: value,
      }
    })
  }

  function collect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!codeReady || !direction || busy || stopping) return
    setActionError(''); setNotice('')
    begin({ id: crypto.randomUUID(), code, direction, mode, accepted: false })
  }

  function selectTheme(value: CardTheme) {
    setDraft(current => ({ ...current, theme: value }))
  }

  function switchTheme(direction: -1 | 1) {
    const index = cardThemes.findIndex(item => item.id === theme)
    selectTheme(cardThemes[(index + direction + cardThemes.length) % cardThemes.length].id)
  }

  function switchMobilePane(next: typeof mobilePane) {
    if (next === mobilePane) return
    const page = pageRef.current
    if (page) mobileScroll.current[mobilePane] = page.scrollTop
    setMobilePane(next)
    requestAnimationFrame(() => { if (page?.isConnected) page.scrollTop = mobileScroll.current[next] ?? 0 })
  }

  function openFullscreen() {
    setFullscreen(true)
  }

  function applyImageEdits(values: Record<string, string | null>) {
    for (const [key, value] of Object.entries(values)) {
      if (Object.hasOwn(initial, key) && value !== null) change(key as keyof Fields, value)
    }
  }

  async function copy() {
    if (!ready) return
    try {
      await navigator.clipboard.writeText(text)
      setActionError('')
      setNotice('文案已复制，含风险提示和投顾落款')
    } catch { setActionError('复制失败，请在文案预览中选中文案后手动复制。') }
  }

  function download() {
    if (!ready || !currentPreview) return
    const link = document.createElement('a')
    link.href = currentPreview.image
    link.download = `调仓建议-${code.slice(0, 6)}.png`
    link.click()
  }

  return <div ref={pageRef} className="page-content workspace-tool-page client-service-page rebalance-suggestion-page">
    <WorkspacePageHeading actions={null}><h1>调仓建议</h1></WorkspacePageHeading>
    <div className="client-mobile-pane-switch" role="group" aria-label="调仓建议编辑视图">
      <button type="button" className="workspace-button" aria-pressed={mobilePane === 'edit'} onClick={() => switchMobilePane('edit')}>编辑</button>
      <button type="button" className="workspace-button" aria-pressed={mobilePane === 'preview'} onClick={() => switchMobilePane('preview')}>预览</button>
    </div>
    <div className="client-service-studio" data-mobile-pane={mobilePane}>
      <form className="client-card-editor" aria-label="模板编辑" onSubmit={collect}>
        <header className="client-editor-title"><h2>模板编辑</h2></header>
        <div className="client-content-fields rebalance-suggestion-fields">
          <label className="rebalance-suggestion-wide">投顾产品<input className="workspace-field" maxLength={80} value={draft.product} onChange={event => change('product', event.target.value)} /></label>
          <label>股票代码<input className="workspace-field" placeholder="如 603650" maxLength={15} autoComplete="off" value={draft.code} onChange={event => change('code', event.target.value)} /></label>
          <label>股票名称<input className="workspace-field" value={draft.name || name} maxLength={50} onChange={event => change('name', event.target.value)} /></label>
          {code && !codeReady && <p className="rebalance-suggestion-wide rebalance-suggestion-feedback">请输入六位 A 股代码，可带 .SH、.SZ 或 .BJ。</p>}
          <label>调仓方向<input className="workspace-field" list="rebalance-directions" placeholder="选择或输入" maxLength={30} value={draft.direction} onChange={event => change('direction', event.target.value)} /><datalist id="rebalance-directions">{directions.map(item => <option key={item} value={item} />)}</datalist></label>
          <div className="rebalance-quote">
            <label>参考价格<input className="workspace-field" inputMode="decimal" placeholder="输入股票代码后取价" maxLength={18}
              value={draft.price} onChange={event => change('price', event.target.value)} aria-invalid={!!draft.price && !priceReady} /></label>
            {codeReady && <button type="button" className="text-button workspace-button" disabled={quoteBusy} onClick={() => setQuoteRefresh(value => value + 1)}>{quoteBusy ? '正在取价…' : '取最新价'}</button>}
            {quote && <small>{quote.kind === 'live' ? '实时行情' : quote.kind === 'close' ? '最近收盘' : '最近报价'} · {marketTime(quote.observed_at)} · {quote.source}</small>}
            {quoteError && !quote && <small>{quoteError}</small>}
          </div>
          <fieldset className="rebalance-suggestion-wide">
            <legend>仓位变化</legend>
            <div className="rebalance-suggestion-percentages">
              <label>调仓前（%）<input className="workspace-field" inputMode="decimal" maxLength={12} value={draft.before} onChange={event => change('before', event.target.value)} aria-invalid={!!draft.before && !before} /></label>
              <label>调仓后（%）<input className="workspace-field" inputMode="decimal" maxLength={12} value={draft.after} onChange={event => change('after', event.target.value)} aria-invalid={!!draft.after && !after} /></label>
            </div>
          </fieldset>
        </div>
        <div className="client-section-heading"><h3>核心内容</h3></div>
        <div className="rebalance-suggestion-collection">
          <label className="rebalance-mode-select">
            <span>AI 生成档位</span>
            <select className="workspace-field" aria-label="AI 生成档位" value={mode} disabled={busy || stopping}
              onChange={event => {
                const next = event.currentTarget.value as Mode
                setDraft(current => ({ ...current, mode: next }))
              }}>
              {modes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <button type="submit" className="primary-button workspace-button" disabled={!codeReady || !direction || busy || stopping}><Sparkles size={16} />AI 生成理由</button>
          <small className="rebalance-mode-detail">{selectedMode?.model}</small>
          {busy && <LoadingState compact label={current?.state === 'running' ? '正在核对资料并编写理由…' : '等待开始生成…'} />}
          {busy && request?.accepted && <button type="button" className="text-button workspace-button" disabled={stopping} onClick={() => void stop()}>{stopping ? '正在停止…' : '停止生成'}</button>}
        </div>
        {error && <div role="alert" className="workspace-error rebalance-suggestion-feedback">{error.message} {error.retry && <button type="button" className="text-button workspace-button" onClick={retry}>重试连接</button>}</div>}
        {stopError && <p role="alert" className="workspace-error rebalance-suggestion-feedback">{stopError}</p>}
        {current && !busy && !error && <p role="status" className="rebalance-suggestion-feedback">{current.message}</p>}
        {collection && (draft.reason !== collection.reason || draft.basis !== collection.basis) &&
          <button type="button" className="secondary-button workspace-button" onClick={() => setBasisOpen(true)}>查看本次 AI 草稿</button>}
        <div className="client-content-fields">
          <label className="rebalance-suggestion-wide"><span>调仓理由 <small>选填</small></span><textarea aria-label="调仓理由" className="workspace-field" rows={6}
            maxLength={1600} value={draft.reason} onChange={event => change('reason', event.target.value)} /></label>
        </div>
      </form>
      <section className="client-preview-workspace" aria-label="调仓卡片预览">
        <section className="client-preview-panel" aria-label="草稿预览">
          <header>
            <h2>草稿预览</h2>
            <div className="client-preview-toolbar">
              <button type="button" className="secondary-button workspace-button" onClick={() => setBasisOpen(true)}>查看依据</button>
              <button type="button" className="secondary-button workspace-button" disabled={!currentPreview} onClick={openFullscreen}>
                <Maximize2 size={14} />全屏查看
              </button>
              <ClientCardPreviewSwitch mode={previewMode} onChange={setPreviewMode} />
            </div>
          </header>
          <div className="client-preview-meta">
            <span>{themeLabel}{previewMode === 'image' && ' · 点击图片文字可编辑'}</span>
            {previewMode === 'image' && <span>{currentPreview ? `${currentPreview.width} × ${currentPreview.height} px`
              : previewError ? '预览暂不可用' : '正在同步…'}</span>}
          </div>
          {previewError && previewMode === 'image' && <div role="alert" className="workspace-error client-service-feedback">
            <span>{previewError}</span><button type="button" className="workspace-button text-button" onClick={retryPreview}>重试预览</button>
          </div>}
          {previewMode === 'image' ? <ClientCardImageStage pending={!currentPreview && !previewError} onStep={switchTheme}>
            {visiblePreview ? <EditableClientCard preview={visiblePreview} editableValues={imageValues} alt="调仓建议图片预览"
              onApply={applyImageEdits} onFullscreen={currentPreview ? openFullscreen : undefined} /> :
              previewError ? <div className="client-preview-placeholder"><Image size={34} /><p>重试后可查看图片</p></div> :
                <LoadingState label="正在排版卡片…" />}
          </ClientCardImageStage> : <div className="client-text-preview" aria-label="文案预览"><pre aria-label="可复制文案预览">{text}</pre></div>}
          <div className="client-export-bar">
            {!ready && <p>填齐产品、股票、方向、前后仓位和参考价格后即可导出。</p>}
            {actionError && <p role="alert" className="workspace-error">{actionError}</p>}
            {notice && <p role="status" className="workspace-feedback-success"><Check size={15} />{notice}</p>}
            <div>
              <button type="button" className="primary-button workspace-button" onClick={() => void copy()} disabled={!ready}><Copy size={16} />复制文案</button>
              <button type="button" className="secondary-button workspace-button" disabled={!ready || !currentPreview} onClick={download}><Download size={15} />下载图片</button>
              <button type="button" className="secondary-button workspace-button" disabled={!ready || (previewMode === 'image' && !currentPreview)}
                onClick={() => setBroadcast({ text, card: currentPreview ? card : undefined, image: currentPreview?.image })}><Send size={15} />发送到群</button>
            </div>
          </div>
        </section>
        <ClientThemePicker theme={theme} onSelect={selectTheme} ariaLabel="调仓卡片底图" caption="调仓专用底图"
          thumbnail={id => <img className="client-theme-thumbnail rebalance-theme-thumbnail" alt="" loading="lazy" decoding="async"
            src={`/client-service/rebalance-themes/${id}.png`} />} />
      </section>
    </div>
    {basisOpen && <ConditionWorkspaceDrawer title="调仓依据" closeLabel="关闭调仓依据" className="client-service-drawer" onClose={() => setBasisOpen(false)}>
      <div className="rebalance-basis">
        {collection && <>
          <p>研究截至 {marketTime(collection.cutoff)}</p>
          <p>{collection.reason}</p>
          {(collection.report || collection.sources?.length || collection.market) ? <ul>
            {collection.report && <li><a href={collection.report.document_id ? '/api/v1/documents/' + encodeURIComponent(collection.report.document_id) + '/pdf' : collection.report.url}
              target="_blank" rel="noreferrer">打开研报原文</a> · {collection.report.title} · {collection.report.publication_date}</li>}
            {collection.sources?.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
              {source.published_at && <small> · {source.published_at.slice(0, 10)}</small>}{source.quote && <p>{source.quote}</p>}</li>)}
            {collection.market && <li>本地日线 {collection.market.trade_date} 收盘 {collection.market.close} 元（未复权）</li>}
          </ul> : <p>本次生成的是条件性理由。</p>}
          {(draft.reason !== collection.reason || draft.basis !== collection.basis) &&
            <button type="button" className="secondary-button workspace-button" onClick={() => {
              setDraft(current => matchesDraft(collection, current) ? applyCollection(current, collection) : current)
              setNotice('AI 文案已填入，可继续编辑')
            }}>填入理由和依据</button>}
        </>}
        <label><span>依据文案 <small>选填</small></span><textarea aria-label="依据文案" className="workspace-field" rows={5} maxLength={650}
          value={draft.basis} onChange={event => change('basis', event.target.value)} /></label>
      </div>
    </ConditionWorkspaceDrawer>}
    {broadcast && <ConditionWorkspaceDrawer title="内容群发" closeLabel="关闭内容群发" className="client-service-drawer" closeDisabled={sending} onClose={() => setBroadcast(null)}>
      {robots.loading ? <LoadingState label="正在读取群机器人…" /> : robots.error ?
        <p role="alert" className="workspace-error">{robots.error} <button type="button" className="text-button workspace-button" onClick={robots.retry}>重试</button></p> :
        <ClientBroadcastPanel robots={robots.data?.items || []} text={broadcast.text} card={broadcast.card} image={broadcast.image} onBusy={setSending} />}
    </ConditionWorkspaceDrawer>}
    {fullscreen && <ClientCardFullscreen title="草稿全屏预览" description={themeLabel} theme={themeLabel} downloadLabel="下载图片"
      canDownload={ready && !!currentPreview} onDownload={download} onStep={switchTheme} onClose={() => setFullscreen(false)}>
      {mode => visiblePreview ? <EditableClientCard preview={visiblePreview} editableValues={imageValues} alt="调仓建议全屏预览"
        mode={mode} onApply={applyImageEdits} /> :
        previewError ? <p role="alert" className="client-fullscreen-error">{previewError}</p> : <LoadingState label="正在同步卡片图片…" />}
    </ClientCardFullscreen>}
  </div>
}
