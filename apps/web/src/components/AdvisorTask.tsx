import { useState } from 'react'
import { Check, Copy, FileText, ChevronDown } from 'lucide-react'
import StockSearch from './StockSearch'
import { advisorVerdicts, analysisDimensions, briefTime, defaultAdvisorScope, isStockKind,
  type AdvisorScope, type BriefKind, type BriefScope, type BriefDetail, type BriefItem, type AdvisorPoint } from '../intelligence'

export function AdvisorSettings({ kind, scope, disabled, onChange }: {
  kind: BriefKind; scope: BriefScope; disabled: boolean; onChange: (values: Partial<AdvisorScope>) => void
}) {
  const value = scope.advisor || defaultAdvisorScope
  return <section className="advisor-settings" aria-label="投顾任务设置">
    {kind === 'closing' ? <>
      <div className="advisor-setting-title"><h2>每日股评</h2><p>固定复盘日期，生成盘面回顾、热点板块与明日观察。</p></div>
      <p className="intelligence-caption" role="note">默认优先沪深两市成交额并使用同口径比较；事件换算为北京时间，区分盘前与收盘后；客户稿使用简明表达。</p>
      <div className="intelligence-form-grid">
        <label className="workspace-field-label">收评日期<input type="date" aria-label="收评日期" className="workspace-field" value={value.trade_date || ''} disabled={disabled} onChange={event => onChange({ trade_date: event.target.value || null })} /><small>留空使用研究截止日期；未收盘时生成盘中草稿。</small></label>
        <label className="workspace-field-label">稿件用途<select className="workspace-field" value={value.audience} disabled={disabled} onChange={event => onChange({ audience: event.target.value as AdvisorScope['audience'] })}><option value="client">客户每日股评</option><option value="internal">内部复盘记录</option></select></label>
      </div>
    </> : <>
      <div className="advisor-setting-title"><h2>{kind === 'stock-rationale' ? '先选股票，再核对推荐逻辑' : '选择诊股对象'}</h2><p>{kind === 'stock-rationale' ? '推荐背景帮助确定沟通场景，支持理由与反方证据由研究形成。' : '结合咨询问题与持有期限，形成分情形的研判与行动条件。'}</p></div>
      <div className="intelligence-form-grid">
        <div className="workspace-field-label"><span>研究股票</span><StockSearch label="投顾研究股票" value={value.stock_code || ''} disabled={disabled} onSelectionPending={() => onChange({ stock_code: null })} onChange={code => onChange({ stock_code: code })} /><small>从候选列表选择，或输入完整证券代码。</small></div>
        <label className="workspace-field-label">分析期限<select className="workspace-field" value={value.horizon} disabled={disabled} onChange={event => onChange({ horizon: event.target.value as AdvisorScope['horizon'] })}><option value="short">短期：数日到数周</option><option value="medium">中期：1–6个月</option><option value="long">长期：6个月以上</option></select></label>
        <label className="workspace-field-label">持仓状态<select className="workspace-field" value={value.position} disabled={disabled} onChange={event => onChange({ position: event.target.value as AdvisorScope['position'], ...(event.target.value === 'watching' ? { holding_cost: null } : {}) })}><option value="watching">尚未持有 / 正在观察</option><option value="holding">已经持有</option></select></label>
        {value.position === 'holding' && <label className="workspace-field-label">持仓成本（可选）<input type="number" min="0.01" step="0.01" className="workspace-field" value={value.holding_cost ?? ''} disabled={disabled} onChange={event => onChange({ holding_cost: event.target.value === '' ? null : Number(event.target.value) })} /></label>}
          <label className="workspace-field-label">客户风险偏好（可选）<select className="workspace-field" value={value.risk_preference} disabled={disabled} onChange={event => onChange({ risk_preference: event.target.value as AdvisorScope['risk_preference'] })}><option value="unspecified">未提供</option><option value="cautious">谨慎</option><option value="balanced">均衡</option><option value="growth">进取</option></select></label>
      </div>
      <label className="workspace-field-label">客户咨询 / 诊股问题<textarea className="workspace-field" rows={2} maxLength={600} value={value.question} disabled={disabled} placeholder="例如：现在能不能买入？已有持仓应继续持有还是等待变化？" onChange={event => onChange({ question: event.target.value })} /></label>
      {kind === 'stock-rationale' && <label className="workspace-field-label">推荐背景（可选）<textarea aria-label="推荐背景（可选）" className="workspace-field" rows={3} maxLength={1200} value={value.recommendation_background} disabled={disabled} placeholder="例如：已向客户提及这只股票，希望核对推荐逻辑并补充依据；也可填写已有观点和待确认的问题。" onChange={event => onChange({ recommendation_background: event.target.value })} /><small>背景会保留为用户输入，研究会同时检查支持与反方依据。</small></label>}
    </>}
  </section>
}

function Points({ title, points, items, onItem }: { title: string; points: AdvisorPoint[]; items: BriefItem[]; onItem: (key: string) => void }) {
  if (!points.length) return null
  return <section className="advisor-point-section"><h3>{title}</h3>{points.map((point, index) => <article key={point.title + index}><h4>{point.title}</h4><p>{point.explanation}</p><div>{point.evidence_keys.map(key => <button key={key} className="text-button workspace-button" onClick={() => onItem(key)}><FileText size={13} />{items.find(item => item.event_key === key)?.title || key}</button>)}</div></article>)}</section>
}

export function AdvisorResult({ run, onItem }: { run: BriefDetail; onItem: (key: string) => void }) {
  const report = run.result?.advisor_report
  const [format, setFormat] = useState<'client' | 'full'>('client')
  const [drafts, setDrafts] = useState({ client: report?.client_copy || '', full: report?.full_copy || '' })
  const [copied, setCopied] = useState(false), [error, setError] = useState('')
  if (!report) return null
  const context = run.advisor_context
  const closing = report.closing_review
  const name = run.kind === 'closing' ? '收评' : run.kind === 'stock-analysis' ? '个股分析' : '个股推荐理由'
  async function copy() {
    setError(''); setCopied(false)
    const closingTitle = report!.effective_date + ' A股' + (report!.session_status === 'not_closed' ? '盘中草稿' : report!.session_status === 'data_missing' ? '收评草稿（行情待补齐）' : '收评')
    const text = run.kind === 'closing' && format === 'client' ? closingTitle + '\n\n' + drafts.client
      : name + ' · 待投顾确认\n研究截止：' + briefTime(run.cutoff_at) + '\n研判：' + advisorVerdicts[report!.verdict] + '\n\n' + drafts[format]
    try { await navigator.clipboard.writeText(text); setCopied(true) } catch { setError('复制失败，请手动选择下方稿件正文。') }
  }
  return <section className="advisor-result" aria-label="投顾研判与稿件">
    <div className="advisor-verdict"><span>{advisorVerdicts[report.verdict]}</span>{context?.stock && <strong>{context.stock.name} · {context.stock.stock_code}</strong>}<small>{report.effective_date}</small>
      {report.session_status && <small>{({ closed: '已收盘复盘', not_closed: '盘中草稿 · 尚未收盘', data_missing: '所选日行情待补齐' })[report.session_status]}</small>}
    </div>
    {context?.observations && context.observations.length > 0 && <div className="advisor-market-reference" aria-label="本版日线参考">{context.observations.map(value => <span key={value.stock_code}><strong>{value.name}</strong><span>收盘 {value.close.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}</span><small>{value.trade_date} · 原始口径</small></span>)}</div>}
    <p className="advisor-conclusion">{report.conclusion}</p>
    <div className="advisor-context-line"><span>适用前提：{report.suitability}</span>{context?.actual_market_date && <span>行情实际截至 {context.actual_market_date}</span>}</div>
    <div className="advisor-point-grid"><Points title={run.kind === 'closing' ? '盘面主要依据' : '支持逻辑与依据'} points={report.supporting_points} items={run.result!.items} onItem={onItem} /><Points title="反方证据与分歧" points={report.contrary_points} items={run.result!.items} onItem={onItem} /></div>
    <div className="advisor-action-grid"><section><h3>{run.kind === 'closing' ? '次日观察与验证' : '行动与验证条件'}</h3><ul>{report.action_conditions.map(value => <li key={value}>{value}</li>)}</ul></section><section><h3>主要风险与失效条件</h3><ul>{[...report.risks, ...report.invalidation_conditions].map((value, index) => <li key={value + index}>{value}</li>)}</ul></section></div>
    {run.kind === 'closing' && closing && <details className="advisor-input-snapshot" aria-label="行情口径与事件北京时间"><summary><ChevronDown size={13} />本版行情口径与事件北京时间</summary>
      {closing.turnover && <p>成交额口径：{closing.turnover.market_scope === 'SH_SZ' ? '沪深两市' : '沪深京三市'} · {closing.turnover.amount_yi.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}亿元{closing.turnover.comparison && <>；较前一交易日同口径{closing.turnover.comparison.change_yi < 0 ? '减少' : '增加'}{Math.abs(closing.turnover.comparison.change_yi).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}亿元</>}</p>}
      {closing.events.length > 0 && <ul>{closing.events.map((event, index) => <li key={event.title + index}>{event.title}：{event.beijing_start ? <>北京时间{briefTime(event.beijing_start)} · {({ before_open: '盘前', during_session: '盘中', midday_break: '午间休市', after_close: '收盘后', non_trading_day: '周末非交易日' } as Record<string, string>)[event.session_relation] || '时段待核对'}（相对常规交易时段；原时区 {event.source_timezone}）</> : '时间待确认'}</li>)}</ul>}
      {closing.scope_notes && <p>{closing.scope_notes}</p>}
    </details>}
    <section className="advisor-draft" aria-label="投顾沟通稿">
      <header><div><h3>可编辑使用的沟通稿</h3><small>AI 生成 · 待投顾核对</small></div><div className="advisor-draft-actions"><button className="workspace-button" aria-pressed={format === 'client'} onClick={() => { setFormat('client'); setCopied(false) }}>客户短稿</button><button className="workspace-button" aria-pressed={format === 'full'} onClick={() => { setFormat('full'); setCopied(false) }}>完整稿</button><button className="secondary-button workspace-button" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : format === 'client' ? '复制短稿' : '复制完整稿'}</button></div></header>
      <textarea className="advisor-draft-body workspace-field" aria-label={format === 'client' ? '客户短稿正文' : '完整稿正文'} value={drafts[format]} rows={format === 'client' ? 6 : 14} onChange={event => { setDrafts(values => ({ ...values, [format]: event.target.value })); setCopied(false) }} />
      <footer><small>编辑后复制使用；导出与历史版本保留原始生成稿。</small>{drafts[format] !== (format === 'client' ? report.client_copy : report.full_copy) && <button className="text-button workspace-button" onClick={() => { setDrafts(values => ({ ...values, [format]: format === 'client' ? report.client_copy : report.full_copy })); setCopied(false) }}>恢复生成稿</button>}</footer>
      {error && <p role="alert" className="workspace-error">{error}</p>}
    </section>
    {context && <details className="advisor-input-snapshot"><summary><ChevronDown size={13} />本版咨询输入与数据范围</summary>{isStockKind(run.kind) && <><p>客户咨询：{context.advisor.question || '未填写额外问题'}</p>{context.advisor.recommendation_background && <p>推荐背景（用户输入）：{context.advisor.recommendation_background}</p>}<p>持仓：{context.advisor.position === 'holding' ? '已持有' : '观察中'}{context.advisor.holding_cost != null ? ' · 用户填写成本 ' + context.advisor.holding_cost : ''}</p></>}<ul>{context.gaps.map(value => <li key={value}>{value}</li>)}</ul></details>}
  </section>
}

export function EvidenceDimension({ dimension }: { dimension?: string | null }) {
  return dimension ? <span>{analysisDimensions[dimension] || dimension}</span> : null
}
