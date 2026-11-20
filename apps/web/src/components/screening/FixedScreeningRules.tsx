import { useEffect, useState } from 'react'
import { Play, Plus } from 'lucide-react'
import { api } from '../../api'
import { templateDescription } from '../../screeningMethods'
import type { IndustryValuationSelection, ScreeningTemplate } from '../conversation/ScreeningTemplates'
import ConditionWorkspaceDrawer from '../ConditionWorkspaceDrawer'
import { TechnicalRuleFields, TechnicalRuleTrial, useTechnicalRules } from './TechnicalRuleEditor'

export type FixedRuleScope = { asOf: string; pool: string; industry?: IndustryValuationSelection }
type Industry = { code: string; name: string; level: number }
const industryLevels = ['一级行业', '二级行业', '三级行业']

export default function FixedScreeningRules({ date, pool, latestDate, watchlists, disabled, running, onClose, onPrepare, onRun }: {
  date: string
  pool: string
  latestDate?: string
  watchlists: { id: string; name: string }[]
  disabled: boolean
  running: boolean
  onClose: () => void
  onPrepare: (requirement: string) => boolean
  onRun: (template: ScreeningTemplate, parameters: Record<string, number>, scope: FixedRuleScope) => Promise<boolean>
}) {
  const rules = useTechnicalRules(true, 'screening.fixedRules', false, true)
  const [editedDate, setEditedDate] = useState<string | null>(null)
  const asOf = editedDate ?? (date || latestDate || '')
  const [selectedPool, setSelectedPool] = useState(pool === 'all' || watchlists.some(item => item.id === pool) ? pool : 'all')
  const [error, setError] = useState('')
  const [industries, setIndustries] = useState<Industry[] | null>(null)
  const [industryError, setIndustryError] = useState('')
  const [industryRetry, setIndustryRetry] = useState(0)
  const [industryQuery, setIndustryQuery] = useState('')
  const [industryCode, setIndustryCode] = useState('')
  const [peComparison, setPeComparison] = useState<IndustryValuationSelection['pe_comparison']>('at_most')
  const [maxPe, setMaxPe] = useState('40')
  const requiresIndustry = rules.selected?.requires_industry === true

  useEffect(() => {
    if (!requiresIndustry || industries !== null) return
    const controller = new AbortController()
    setIndustryError('')
    api<{ items: Industry[] }>('/screening-industries', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setIndustries(result.items)
    }).catch(reason => {
      if (!controller.signal.aborted) setIndustryError((reason as Error).message)
    })
    return () => controller.abort()
  }, [requiresIndustry, industries, industryRetry])

  const selectedIndustry = industries?.find(item => item.code === industryCode)
  const validPe = peComparison === 'below_industry_median' || Number.isFinite(Number(maxPe)) && Number(maxPe) > 0
  const industry: IndustryValuationSelection | undefined = requiresIndustry && selectedIndustry && validPe
    ? { industry_code: selectedIndustry.code, pe_comparison: peComparison, ...(peComparison !== 'below_industry_median' ? { max_pe_ttm: Number(maxPe) } : {}) }
    : undefined
  const query = industryQuery.trim().toLowerCase()
  const visibleIndustries = industries?.filter(item => item.code === industryCode || item.name.includes(query) || item.code.toLowerCase().includes(query)) ?? []
  const invalidDate = !asOf || !!latestDate && asOf > latestDate
  const canUse = !disabled && !rules.loading && !rules.error && !rules.invalid && !!rules.selected && (!requiresIndustry || !!industry)

  async function run() {
    if (!canUse || invalidDate || !rules.selected) return
    setError('')
    try { if (await onRun(rules.selected, rules.parameters, { asOf, pool: selectedPool, industry })) onClose() }
    catch (reason) { setError((reason as Error).message) }
  }

  function prepare() {
    if (!canUse || !rules.selected) return
    if (industry && selectedIndustry) {
      const pe = industry.pe_comparison === 'below_industry_median'
        ? '正市盈率（TTM）低于行业中位数'
        : `正市盈率（TTM）${industry.pe_comparison === 'at_most' ? '不高于' : '低于'} ${industry.max_pe_ttm} 倍`
      const { amount_window, min_daily_amount_yi } = rules.parameters
      if (onPrepare(`申万${selectedIndustry.name}行业（${industry.industry_code}），${pe}，近 ${amount_window} 个交易日的日均成交额不低于 ${min_daily_amount_yi} 亿元`)) onClose()
    } else if (onPrepare(templateDescription(rules.selected, rules.parameters))) onClose()
  }

  return <ConditionWorkspaceDrawer
    title="固定规则与试算"
    description="调整规则后可先试算一只股票。也可加入当前要求，或按固定规则启动一项独立筛选。"
    closeLabel="关闭固定规则与试算"
    className="screening-fixed-rules"
    closeDisabled={running}
    onClose={onClose}
    footer={<>
      <button type="button" className="secondary-button workspace-button" disabled={!canUse} onClick={prepare}><Plus size={15} />加入当前要求</button>
      <button type="button" className="primary-button workspace-button" disabled={!canUse || invalidDate} onClick={() => void run()}><Play size={15} />{running ? '正在启动…' : '按固定规则筛选'}</button>
    </>}
  >
    <div className="screening-fixed-rules-body">
      <TechnicalRuleFields rules={rules} disabled={disabled} />
      {requiresIndustry && <div className="scope-picker">
        {industryError ? <p role="alert" className="workspace-error">{industryError} <button type="button" className="text-button workspace-button" onClick={() => setIndustryRetry(value => value + 1)}>重试读取行业</button></p>
          : industries === null ? <p role="status">正在读取申万行业…</p>
          : <>
            <label className="workspace-field-label">搜索行业<input className="workspace-field" placeholder="行业名称或代码" value={industryQuery} disabled={disabled} onChange={event => setIndustryQuery(event.target.value)} /></label>
            <label className="workspace-field-label">申万行业<select aria-label="申万行业" className="workspace-field workspace-select" value={industryCode} disabled={disabled} onChange={event => setIndustryCode(event.target.value)}>
              <option value="">{visibleIndustries.length ? '请选择行业' : '没有匹配的行业'}</option>
              {industryLevels.map((label, index) => {
                const group = visibleIndustries.filter(item => item.level === index + 1)
                return group.length > 0 && <optgroup key={label} label={label}>{group.map(item => <option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}</optgroup>
              })}
            </select></label>
          </>}
        <label className="workspace-field-label">估值条件<select aria-label="估值条件" className="workspace-field workspace-select" value={peComparison} disabled={disabled} onChange={event => setPeComparison(event.target.value as IndustryValuationSelection['pe_comparison'])}>
          <option value="at_most">市盈率不高于指定值</option>
          <option value="below_value">市盈率低于指定值</option>
          <option value="below_industry_median">市盈率低于行业中位数</option>
        </select></label>
        {peComparison !== 'below_industry_median' && <label className="workspace-field-label">市盈率上限（倍）<input className="workspace-field" type="number" step="any" value={maxPe} disabled={disabled} onChange={event => setMaxPe(event.target.value)} /></label>}
        {!validPe && <p role="alert" className="workspace-inline-error">市盈率上限必须大于 0。</p>}
      </div>}
      <div className="scope-picker">
        <label className="workspace-field-label">股票范围<select aria-label="固定规则股票范围" className="workspace-field workspace-select" value={selectedPool} disabled={disabled} onChange={event => setSelectedPool(event.target.value)}><option value="all">全部 A 股</option>{watchlists.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="workspace-field-label">行情截止日期<input aria-label="固定规则截止日期" type="date" className="workspace-field" value={asOf} max={latestDate} disabled={disabled} onChange={event => setEditedDate(event.target.value)} /></label>
      </div>
      {asOf && invalidDate && <p role="alert" className="workspace-error">截止日期超出本地行情覆盖范围。</p>}
      {error && <p role="alert" className="workspace-error">{error}</p>}
      <TechnicalRuleTrial rules={rules} asOf={asOf} industry={industry} disabled={disabled || invalidDate || rules.loading || !!rules.error || requiresIndustry && !industry} />
    </div>
  </ConditionWorkspaceDrawer>
}
