import { StockText } from './StockMentions'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Download, LoaderCircle, RotateCcw, Search, Star, TrendingUp, X } from 'lucide-react'
import { StockName } from './StockSearch'
import ScreeningResultMenu from './ScreeningResultMenu'
import { api } from '../api'
import { useSessionState } from '../useSessionState'
import { trapDialogTab } from '../keyboard'
import './screening-result-list.css'

export type UnifiedConditionDecision = {
  reference_id?: string
  condition_id?: string
  name: string
  state: string
  explanation: string
  actual?: number | string | null
  threshold?: number | string | null
  citation?: string
}

export type UnifiedDecisionItem = {
  stock_code: string
  state: string
  close?: number | null
  score?: number | null
  as_of?: string | null
  market?: string
  conditions: UnifiedConditionDecision[]
}

export type CoverageCounts = {
  target_total: number
  true_count: number
  false_count: number
  unknown_count: number
  failed_count?: number
  not_evaluated_count?: number
}

export interface ScreeningResultViewProps {
  title?: string
  asOf?: string | null
  revision?: number | string
  status: string
  isCurrent?: boolean
  progress?: { message: string; percent: number }
  coverage?: CoverageCounts
  decisions: UnifiedDecisionItem[]
  loading?: boolean
  error?: string
  total?: number
  offset?: number
  pageSize?: number
  stateFilter?: string
  query?: string
  onStateFilterChange?: (state: string) => void
  onQueryChange?: (query: string) => void
  onPageChange?: (offset: number) => void
  onCancel?: () => void
  onRetry?: () => void
  onExportUrl?: string
  exportLabel?: string
  onCopyAll?: () => void
  onAskStock?: (stockCode: string, state: string) => void
  onAddToWatchlist?: (stockCode: string) => void
  onViewChart?: (stockCode: string, asOf?: string) => void
  onAdjustRequirements?: () => void
  onReload?: () => void
  addingStockCode?: string | null
}

const stateLabels: Record<string, string> = {
  true: '符合',
  false: '不符合',
  unknown: '数据不足',
  queued: '等待执行',
  running: '正在筛选',
  succeeded: '已完成',
  partial: '部分结果',
  failed: '处理失败',
  cancelled: '已取消',
  blocked_dependency: '缺少所需数据',
}

function stateClass(state: string) {
  if (state === 'true' || state === 'succeeded') return 'positive'
  if (state === 'false') return 'negative'
  if (state === 'failed' || state === 'cancelled') return 'danger'
  return 'caution'
}

function conciseCondition(condition: UnifiedConditionDecision) {
  if (condition.actual != null) return `实际值：${condition.actual}`
  const values = (condition.explanation || '').match(/本次计算值[：:]\s*(.*?)(?:；(?:符合|不符合)条件|。|$)/)
  return values?.[1] || condition.explanation || condition.name
}

export default function ScreeningResultView({
  title,
  asOf,
  revision,
  status,
  isCurrent = true,
  progress,
  coverage,
  decisions,
  loading = false,
  error = '',
  total = 0,
  offset = 0,
  pageSize = 20,
  stateFilter = 'true',
  query = '',
  onStateFilterChange,
  onQueryChange,
  onPageChange,
  onCancel,
  onRetry,
  onExportUrl,
  exportLabel = '导出当前筛选全部页',
  onCopyAll,
  onAskStock,
  onAddToWatchlist,
  onViewChart,
  onAdjustRequirements,
  onReload,
  addingStockCode,
}: ScreeningResultViewProps) {
  const [copying, setCopying] = useState(false)
  const [listMode, setListMode] = useSessionState<'compact' | 'detailed'>('screening.resultListMode', 'compact', (value): value is 'compact' | 'detailed' => value === 'compact' || value === 'detailed')
  const [expandedCode, setExpandedCode] = useState('')
  const [selectedCodes, setSelectedCodes] = useState<string[]>([])
  const [addingSelected, setAddingSelected] = useState(false)
  const [batchMessage, setBatchMessage] = useState('')
  const [batchError, setBatchError] = useState('')
  const batchLock = useRef(false)
  const requests = useRef(new Map<string, string>())
  const detailClose = useRef<HTMLButtonElement>(null)
  const activeDecision = decisions.find(item => item.stock_code === expandedCode)
  useEffect(() => { setSelectedCodes([]); setExpandedCode(''); setBatchMessage(''); setBatchError('') }, [query, stateFilter, offset, asOf, revision, title, loading])
  useEffect(() => {
    if (!expandedCode) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; detailClose.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [expandedCode])
  function selectCode(code: string) { setSelectedCodes(current => current.includes(code) ? current.filter(item => item !== code) : [...current, code]) }
  async function copySelected() {
    try { await navigator.clipboard.writeText(selectedCodes.join('\n')); setBatchMessage(`已复制所选 ${selectedCodes.length} 只股票代码。`); setBatchError('') }
    catch { setBatchError('复制失败，可使用导出所选。') }
  }
  function exportSelected() {
    const rows = decisions.filter(item => selectedCodes.includes(item.stock_code))
    const csv = '\uFEFF证券代码,判断,数据截止日\r\n' + rows.map(item => [item.stock_code, stateLabels[item.state] || item.state, item.as_of || asOf || ''].map(value => '"' + String(value).replace(/"/g, '""') + '"').join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `所选筛选结果-${asOf || '未指定日期'}.csv`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function addSelected() {
    if (batchLock.current || !selectedCodes.length) return
    batchLock.current = true; setAddingSelected(true); setBatchMessage(''); setBatchError('')
    const codes = [...selectedCodes], failed: string[] = [], reasons: string[] = []
    for (const code of codes) {
      if (!requests.current.has(code)) requests.current.set(code, crypto.randomUUID())
      try { await api('/observation/quick-add', { method: 'POST', body: JSON.stringify({ request_id: requests.current.get(code), stock_code: code }) }) }
      catch (reason) { failed.push(code); reasons.push(`${code}：${(reason as Error).message}`) }
    }
    setSelectedCodes(failed); setBatchMessage(`已加入或复用 ${codes.length - failed.length} 只股票的观察记录。`)
    if (failed.length) setBatchError(`${failed.length} 只未完成：${failed.join('、')}。${reasons.slice(0, 2).join('；')}。保留勾选，可再次加入。`)
    if (codes.length > failed.length) window.dispatchEvent(new Event('observation:changed'))
    setAddingSelected(false); batchLock.current = false
  }
  const [copyNotice, setCopyNotice] = useState('')
  const copyLock = useRef(false)

  const isRunning = status === 'queued' || status === 'running'
  const resolvedCount = coverage ? coverage.true_count + coverage.false_count : 0
  const completeNoMatches = status === 'succeeded' && coverage && coverage.target_total > 0
    && coverage.true_count === 0 && coverage.unknown_count === 0
    && resolvedCount === coverage.target_total && !coverage.failed_count && !coverage.not_evaluated_count
  const incompleteNoMatches = coverage?.true_count === 0 && !completeNoMatches
    && ['succeeded', 'partial'].includes(status)

  function showAllResults() {
    onQueryChange?.('')
    onStateFilterChange?.('')
    onPageChange?.(0)
  }

  async function copyCodes() {
    if (copyLock.current || loading || error || !decisions.length) return
    const target = decisions
    const codes = target.map(d => d.stock_code).join('\n')
    if (!codes) return
    copyLock.current = true
    try {
      if (!navigator.clipboard?.writeText) throw new Error('复制不可用')
      await navigator.clipboard.writeText(codes)
      setCopying(true)
      setCopyNotice(`已复制本页 ${target.length} 只股票代码，包含本页显示的全部判断状态。`)
      globalThis.setTimeout(() => {
        setCopying(false)
        setCopyNotice('')
      }, 2000)
    } catch {
      setCopyNotice('复制未成功，请允许浏览器复制或使用导出按钮。')
    } finally { copyLock.current = false }
  }

  function decisionDetails(decision: UnifiedDecisionItem) {
    return <>
                  {decision.conditions.map((condition, idx) => (
                    <div className="conversation-condition-result" key={condition.reference_id ?? `${condition.name}-${idx}`}>
                      <strong>
                        {condition.name} · {stateLabels[condition.state] ?? condition.state}
                      </strong>
                      <p>{condition.explanation || '未提供判断说明'}</p>
                      {condition.actual != null && <small>实际值：{condition.actual}</small>}
                      {condition.threshold != null && <small>条件阈值：{condition.threshold}</small>}
                      {condition.citation && (
                        <small className="result-citation">{condition.citation}</small>
                      )}
                    </div>
                  ))}

                  <div className="conversation-decision-actions">
                    <div className="decision-actions-group">
                      {onAskStock && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => { setExpandedCode(''); onAskStock(decision.stock_code, decision.state) }}
                        >
                          追问这只股票
                        </button>
                      )}
                      {onViewChart && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => { setExpandedCode(''); onViewChart(decision.stock_code, decision.as_of ?? asOf ?? undefined) }}
                        >
                          <TrendingUp size={12} />
                          查看走势
                        </button>
                      )}
                    </div>
                    {onAddToWatchlist && (
                      <button
                        type="button"
                        className="text-button conversation-add-watchlist-btn"
                        disabled={addingStockCode === decision.stock_code}
                        onClick={() => onAddToWatchlist(decision.stock_code)}
                      >
                        <Star size={12} />
                        {addingStockCode === decision.stock_code ? '加入中…' : '加入观察池'}
                      </button>
                    )}
                  </div>

    </>
  }

  return (
    <StockText><div className={`screening-result-view screening-list-${listMode}`}>
      <div className="conversation-run-title">
        <span>{title || `${isCurrent ? '当前运行' : '历史运行'} · v${revision ?? 1}`}</span>
        <span className={`conversation-turn-state ${stateClass(status)}`}>{stateLabels[status] ?? status}</span>
      </div>

      <p className="conversation-result-date">数据截止日：{asOf || '未提供'}</p>

      {isRunning && progress && (
        <div className="conversation-run-progress">
          <p>{progress.message || '正在执行全市场扫描…'}</p>
          <progress aria-label="筛选运行进度" max={1} value={progress.percent} />
          {onCancel && (
            <button type="button" className="text-button" onClick={onCancel}>
              取消运行
            </button>
          )}
        </div>
      )}

      {coverage && (
        <section aria-label="本次运行覆盖情况">
          <div className="conversation-run-counts">
            <div><span>符合</span><strong>{coverage.true_count}</strong></div>
            <div><span>已判断覆盖</span><strong>{resolvedCount} / {coverage.target_total}</strong></div>
            <div><span>数据不足</span><strong>{Math.max(0, coverage.unknown_count - (coverage.failed_count ?? 0) - (coverage.not_evaluated_count ?? 0))}</strong></div>
          </div>
          <p className="conversation-coverage-note">已有明确判断 {resolvedCount} / {coverage.target_total} 只；不符合 {coverage.false_count} 只。尚无法判断共 {coverage.unknown_count} 只，包含 {coverage.failed_count ?? 0} 只处理失败、{coverage.not_evaluated_count ?? 0} 只未处理。</p>
          {coverage.unknown_count > 0 && <p className="conversation-coverage-note">结果覆盖不完整，未能判断的股票不等于不符合。</p>}
        </section>
      )}

      {!isRunning && (
        <>
          <div className="conversation-decision-controls">
            {onStateFilterChange && <select
              aria-label="判断状态"
              disabled={addingSelected}
              value={stateFilter}
              onChange={(e) => onStateFilterChange?.(e.target.value)}
            >
              <option value="">全部判断</option>
              <option value="true">符合</option>
              <option value="false">不符合</option>
              <option value="unknown">尚无法判断（含失败 / 未处理）</option>
            </select>}
            {onQueryChange && <label className="conversation-search">
              <Search size={14} />
              <input
                aria-label="搜索股票名称或代码"
                disabled={addingSelected}
                value={query}
                onChange={(e) => onQueryChange?.(e.target.value)}
                placeholder="名称、拼音或代码"
              />
            </label>}
            <ScreeningResultMenu context={JSON.stringify([status, revision, asOf, offset, stateFilter, query, loading, error])}>{closeMenu => <><button
              type="button"
              role="menuitem"
              className="secondary-button compact conversation-copy-button"
              title="仅复制当前页显示的股票代码，包含本页全部判断状态；不包含其他页"
              disabled={loading || !!error || !decisions.length}
              onClick={() => { closeMenu(); void copyCodes() }}
            >
              <Copy size={13} />
              <span>{copying ? '已复制' : '复制本页代码'}</span>
            </button>
            {onCopyAll && <button type="button" role="menuitem" className="secondary-button compact" onClick={() => { closeMenu(); onCopyAll() }}>{query ? '复制搜索范围全部符合项' : '复制全部符合项'}</button>}
            {onExportUrl && (
              <a
                role="menuitem"
                className="secondary-button compact"
                href={onExportUrl}
                title="按当前状态和搜索条件导出所有页，不限当前页"
                onClick={closeMenu}
              >
                <Download size={13} />
                <span>{exportLabel}</span>
              </a>
            )}
            </>}</ScreeningResultMenu>
            {onRetry && ['failed', 'cancelled', 'partial'].includes(status) && (
              <button
                type="button"
                className="secondary-button compact"
                onClick={onRetry}
                title="重试运行"
              >
                <RotateCcw size={13} />
                <span>重试</span>
              </button>
            )}
          </div>

          {copyNotice && <div className="inline-feedback-badge">{copyNotice}</div>}
          <div className="screening-list-toolbar"><div role="group" aria-label="筛选结果显示方式"><button type="button" aria-pressed={listMode === 'compact'} onClick={() => setListMode('compact')}>紧凑列表</button><button type="button" aria-pressed={listMode === 'detailed'} onClick={() => setListMode('detailed')}>详细卡片</button></div><span>{decisions.length ? `本页 ${decisions.length} 只 · 点击查看完整依据` : ''}</span></div>
          {!!selectedCodes.length && <div className="screening-selection-toolbar" role="group" aria-label="所选结果操作"><strong>已选 {selectedCodes.length} 只</strong><button type="button" className="text-button" disabled={addingSelected || loading} onClick={() => void copySelected()}>复制所选</button><button type="button" className="text-button" disabled={addingSelected || loading} onClick={exportSelected}>导出所选</button><button type="button" className="secondary-button compact" disabled={addingSelected || loading} title="所选股票加入手动观察，已有关注记录直接复用" onClick={() => void addSelected()}>{addingSelected ? '正在加入…' : '加入观察池'}</button><button type="button" className="text-button" disabled={addingSelected} onClick={() => setSelectedCodes([])}>清除勾选</button></div>}
          {batchMessage && <p role="status" className="screening-selection-message">{batchMessage}</p>}{batchError && <p role="alert" className="screening-selection-error">{batchError}</p>}


          {!loading && !error && completeNoMatches && (
            <div className="conversation-result-guidance">
              <strong>本次没有找到符合条件的股票</strong>
              <p>目标范围内的股票均已有明确判断。可查看不符合项的条件明细，再决定是否调整要求。</p>
              {onStateFilterChange && <button type="button" className="text-button" onClick={showAllResults}>查看全部判断与原因</button>}
              {onAdjustRequirements && <button type="button" className="text-button" onClick={onAdjustRequirements}>调整筛选要求</button>}
            </div>
          )}

          {!loading && !error && incompleteNoMatches && (
            <div className="conversation-result-guidance">
              <strong>{coverage?.target_total === 0 ? '本次没有可筛选的股票' : '暂未确认符合项，仍有未完成的判断'}</strong>
              <p>{coverage?.target_total === 0 ? '请检查目标范围后再运行。' : '当前结果不能说明目标范围内没有符合项。请查看数据不足、处理失败或未处理的记录及原因。'}</p>
              {onStateFilterChange && <button type="button" className="text-button" onClick={showAllResults}>查看全部判断与原因</button>}
              {onAdjustRequirements && coverage?.target_total === 0 && <button type="button" className="text-button" onClick={onAdjustRequirements}>检查筛选范围</button>}
            </div>
          )}

          {!loading && !error && ['failed', 'cancelled'].includes(status) && (
            <div className="conversation-result-guidance">
              <strong>{status === 'failed' ? '这次筛选未能完成' : '这次筛选已取消'}</strong>
              {progress?.message && <p>{progress.message}</p>}
              <p>这不是零匹配结论。请先检查运行信息；已有记录可在全部判断中查看。</p>
              {onStateFilterChange && <button type="button" className="text-button" onClick={showAllResults}>查看全部判断与原因</button>}
            </div>
          )}

          <div className="conversation-decision-list" aria-busy={loading}>
            {loading ? (
              <p className="conversation-muted" role="status">
                <LoaderCircle size={14} className="spin" /> 正在更新结果…
              </p>
            ) : error ? (
              <div className="saved-task-empty" role="alert">
                <strong>筛选结果加载失败</strong><p>{error}</p><p>结果尚未读取成功，请重新加载；这不是零匹配结论。</p>
                {onReload && (
                  <button type="button" className="secondary-button compact" onClick={onReload}>
                    重新加载结果
                  </button>
                )}
              </div>
            ) : (
              listMode === 'compact' && decisions.length ? <div className="screening-compact-scroll"><table className="screening-compact-table" aria-label="筛选结果股票列表"><thead><tr><th><input type="checkbox" aria-label="勾选本页全部筛选结果" checked={decisions.length > 0 && decisions.every(item => selectedCodes.includes(item.stock_code))} disabled={addingSelected} onChange={event => setSelectedCodes(event.target.checked ? decisions.map(item => item.stock_code) : [])} /></th><th>股票</th><th>判断</th><th>关键值与条件</th><th>完整依据</th></tr></thead><tbody>{decisions.map(decision => <tr key={decision.stock_code}>
                <td data-label="勾选"><input type="checkbox" aria-label={`勾选筛选结果 ${decision.stock_code}`} checked={selectedCodes.includes(decision.stock_code)} disabled={addingSelected} onChange={() => selectCode(decision.stock_code)} /></td>
                <td data-label="股票"><StockName code={decision.stock_code} />{typeof decision.close === 'number' && <small>收盘 {decision.close.toFixed(2)}（行情原始单位）</small>}</td>
                <td data-label="判断"><span className={`conversation-turn-state ${stateClass(decision.state)}`}>{stateLabels[decision.state] || decision.state}</span><small>{decision.conditions.length ? `${decision.conditions.filter(item => item.state === 'true').length} / ${decision.conditions.length} 条符合` : '暂无条件明细'}</small></td>
                <td data-label="关键值与条件" className="screening-key-values">{decision.conditions.slice(0, 2).map((condition, index) => <span key={condition.reference_id || index} title={`${condition.name}：${condition.explanation}`}><i className={`screening-condition-marker ${condition.state}`} aria-label={stateLabels[condition.state] || condition.state} />{stateLabels[condition.state] || condition.state} · {conciseCondition(condition)}</span>)}</td>
                <td data-label="完整依据"><button type="button" className="text-button" aria-label={`查看 ${decision.stock_code} 条件与依据`} onClick={() => setExpandedCode(decision.stock_code)}>查看依据</button></td>
              </tr>)}</tbody></table></div> : decisions.map((decision) => (
                <details key={decision.stock_code} className="conversation-decision-row">
                  <summary>
                    <div className="decision-summary-content">
                      <div className="decision-summary-left">
                        <StockName code={decision.stock_code} />
                        {typeof decision.close === 'number' && (
                          <span className="stock-close-value">¥{decision.close.toFixed(2)}</span>
                        )}
                      </div>
                      <div className="decision-evidence-preview">
                        {decision.conditions.filter(condition => condition.explanation || condition.actual != null).slice(0, 2).map((condition, index) => (
                          <p key={condition.reference_id ?? index}>
                            {condition.name}（{stateLabels[condition.state] ?? condition.state}）：{condition.explanation || `实际值 ${condition.actual}`}
                          </p>
                        ))}
                        <small>{decision.conditions.length ? '展开查看全部条件与证据' : '未提供条件明细；展开查看操作'}</small>
                      </div>
                    </div>
                    <span className={`conversation-turn-state ${stateClass(decision.state)}`}>
                      {stateLabels[decision.state] ?? decision.state}
                    </span>
                  </summary>

                  {decisionDetails(decision)}
                </details>
              ))
            )}

            {!loading && !error && !decisions.length && !completeNoMatches && !incompleteNoMatches && !['failed', 'cancelled'].includes(status) && (
              <div className="saved-task-empty">
                <p>
                  {query || stateFilter
                    ? '当前搜索或状态下没有股票记录。'
                    : '本次运行暂无逐股记录。'}
                </p>
                {(query || stateFilter) && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={showAllResults}
                  >
                    查看全部结果
                  </button>
                )}
              </div>
            )}
          </div>

          {total > pageSize && onPageChange && (
            <div className="conversation-pagination">
              <button
                type="button"
                className="secondary-button compact"
                disabled={addingSelected || loading || offset === 0}
                onClick={() => onPageChange?.(Math.max(0, offset - pageSize))}
              >
                上一页
              </button>
              <span>
                {offset + 1}-{Math.min(offset + pageSize, total)} / {total}
              </span>
              <button
                type="button"
                className="secondary-button compact"
                disabled={addingSelected || loading || offset + pageSize >= total}
                onClick={() => onPageChange?.(offset + pageSize)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>{activeDecision && createPortal(<div className="screening-evidence-layer"><div className="screening-evidence-backdrop" onClick={() => setExpandedCode('')} aria-hidden="true" /><section className="screening-evidence-drawer" role="dialog" aria-modal="true" aria-label="个股条件与依据" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpandedCode('') }; trapDialogTab(event) }}><header><div><StockName code={activeDecision.stock_code} /><p>数据截止日：{activeDecision.as_of || asOf || '未提供'}</p></div><button ref={detailClose} type="button" className="icon-button" aria-label="关闭个股依据" onClick={() => setExpandedCode('')}><X size={19} /></button></header><div className="screening-evidence-body">{decisionDetails(activeDecision)}</div></section></div>, document.body)}</StockText>
  )
}
