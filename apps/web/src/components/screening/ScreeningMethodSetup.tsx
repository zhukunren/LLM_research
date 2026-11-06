import { useEffect, type ReactNode } from 'react'
import { ArrowRight, BookOpen, Bookmark, History, Play } from 'lucide-react'
import type { DataStatus } from '../../api'
import { isText, useSessionState } from '../../useSessionState'
import { evidenceBasisLabels, evidenceScreeningPrompt, screeningMethodLabel, templateDescription, type EvidenceBasis, type ScreeningFormMethod } from '../../screeningMethods'
import type { ScreeningTemplate } from '../conversation/ScreeningTemplates'
import ScreeningReadiness from '../conversation/ScreeningReadiness'
import { TechnicalRuleFields, TechnicalRuleTrial, useTechnicalRules } from './TechnicalRuleEditor'
import { screeningMethodIcons } from './ScreeningMethodCards'
import './screening-methods.css'

export function EvidenceConditionFields({ method, lookback, basis, onLookback, onBasis, disabled }: {
  method: 'news' | 'report'; lookback: string; basis: EvidenceBasis; onLookback: (value: string) => void; onBasis: (value: EvidenceBasis) => void; disabled?: boolean
}) {
  return <div className="screening-evidence-options">
    <label className="workspace-field-label">{method === 'news' ? '资讯发布窗口' : '研报发布窗口'}<span className="screening-lookback-field"><span>近</span><input type="number" aria-label={method === 'news' ? '资讯发布窗口天数' : '研报发布窗口天数'} min={1} max={3650} step={1} value={lookback} disabled={disabled} onChange={event => onLookback(event.target.value)} className="workspace-field" /><span>自然日</span></span></label>
    {method === 'report' && <label className="workspace-field-label">证据口径<select aria-label="研报证据口径" className="workspace-field workspace-select" value={basis} disabled={disabled} onChange={event => onBasis(event.target.value as EvidenceBasis)}>{Object.entries(evidenceBasisLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>}
  </div>
}

const examples = {
  news: ['有公司实际实施回购的资讯依据，排除仅提出回购计划的公司', '有签订新增订单的原文依据，区分正式合同与意向协议', '有股东已实施增持的资讯，区分增持计划与完成情况'],
  report: ['研报提供订单实际增长的证据，区分已签订单与预期订单', '研报提供毛利率已经改善的实际数据，注明比较期', '研报提供行业需求回暖与库存下降的证据，区分事实和预测'],
  technical: ['连续3个交易日成交量高于此前20日均量', '14日RSI大于45，且近5个交易日涨幅超过3%', '收盘价距离近20日最高收盘价不超过5%'],
}

export default function ScreeningMethodSetup({ method, requirement, onRequirement, asOf, pool, watchlists, onDate, onPool, data, disabled, modelUnavailable, settings, indicators, descriptionKey = 0, onSubmit, onTemplate, onSaved, onHistory, onBrowse, onOpenData }: {
  method: ScreeningFormMethod; requirement: string; onRequirement: (value: string) => void; asOf: string; pool: string; watchlists: { id: string; name: string }[]
  onDate: (value: string) => void; onPool: (value: string) => void; data?: DataStatus | null; disabled: boolean; modelUnavailable?: boolean
  settings: ReactNode; indicators?: ReactNode; descriptionKey?: number
  onSubmit: (content: string, previewOnly?: boolean) => void; onTemplate: (template: ScreeningTemplate, parameters: Record<string, number>) => void
  onSaved?: () => void; onHistory?: () => void; onBrowse?: (kind: 'news' | 'reports') => void; onOpenData?: () => void
}) {
  const [mode, setMode] = useSessionState(`screening.method.${method}.mode`, requirement ? 'describe' : 'rules', (value): value is string => value === 'describe' || value === 'rules')
  const [lookback, setLookback] = useSessionState(`screening.method.${method}.lookback`, method === 'report' ? '365' : '30', isText)
  const [basis, setBasis] = useSessionState<EvidenceBasis>(`screening.method.${method}.basis`, 'actual', (value): value is EvidenceBasis => value === 'actual' || value === 'forecast' || value === 'separate')
  const rules = useTechnicalRules(method === 'technical', 'screening.technical')
  useEffect(() => { if (descriptionKey) setMode('describe') }, [descriptionKey])
  const fixed = method === 'technical' && mode === 'rules'
  const useModel = !fixed || !!requirement.trim()
  const evidenceInvalid = method !== 'technical' && (!/^\d+$/.test(lookback) || Number(lookback) < 1 || Number(lookback) > 3650)
  const dateInvalid = !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !!data?.last_date && asOf > data.last_date
  const poolInvalid = pool !== 'all' && !watchlists.some(item => item.id === pool)
  const ready = !disabled && !dateInvalid && !poolInvalid && !evidenceInvalid && (!useModel || !modelUnavailable) && (fixed ? !rules.invalid : !!requirement.trim())
  const Icon = screeningMethodIcons[method]
  function submit(previewOnly = false) {
    if (!ready) return
    if (fixed && !requirement.trim() && !previewOnly && rules.selected) { onTemplate(rules.selected, rules.parameters); return }
    const content = method === 'technical'
      ? fixed && rules.selected ? `请筛选同时满足以下要求的股票：\n${templateDescription(rules.selected, rules.parameters)}\n\n补充条件：\n${requirement.trim()}` : requirement
      : evidenceScreeningPrompt(method, requirement, { lookback: Number(lookback), basis }, asOf)
    onSubmit(content, previewOnly)
  }
  return <section className={`screening-method-setup screening-method-${method} workspace-tool-page page-content`} aria-label={screeningMethodLabel(method)}>
    <header className="screening-method-heading"><div><span className="screening-method-eyebrow"><Icon size={15} />选股工作台</span><h1>{screeningMethodLabel(method)}</h1><p>{method === 'technical' ? '明确规则和参数，先试算，再筛选。' : method === 'news' ? '从事件与原文出发，找到有依据的股票。' : '先明确经营判断，再逐只核对研报证据。'}</p></div><nav aria-label="统一选股管理">{onSaved && <button type="button" className="text-button workspace-button" onClick={onSaved}><Bookmark size={15} />我的方案</button>}{onHistory && <button type="button" className="text-button workspace-button" onClick={onHistory}><History size={15} />筛选记录</button>}</nav></header>
    <div className="screening-method-layout">
      <form className="screening-method-form workspace-form" onSubmit={event => { event.preventDefault(); submit() }}>
        <div className="screening-method-scope"><label className="workspace-field-label">股票范围<select aria-label="选股股票范围" className="workspace-field workspace-select" disabled={disabled} value={pool} onChange={event => onPool(event.target.value)}><option value="all">全部 A 股</option>{watchlists.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="workspace-field-label">截止日期<input type="date" aria-label="选股截止日期" className="workspace-field" value={asOf} max={data?.last_date} disabled={disabled} onChange={event => onDate(event.target.value)} /></label></div>
        {dateInvalid && <p className="workspace-inline-error" role="alert">请填写有效截止日期，不能晚于本地行情最新日期。</p>}{poolInvalid && <p className="workspace-inline-error" role="alert">当前股票池不可用，请重新选择范围。</p>}
        {method === 'technical' ? <>
          <div className="screening-rule-mode" role="group" aria-label="技术条件编写方式"><button type="button" className="workspace-button" aria-pressed={fixed} disabled={disabled} onClick={() => setMode('rules')}>固定规则</button><button type="button" className="workspace-button" aria-pressed={!fixed} disabled={disabled} onClick={() => setMode('describe')}>描述自定义条件</button><span>{indicators}</span></div>
          {fixed && <TechnicalRuleFields rules={rules} disabled={disabled} />}
        </> : <EvidenceConditionFields method={method} lookback={lookback} basis={basis} onLookback={setLookback} onBasis={setBasis} disabled={disabled} />}
        {evidenceInvalid && <p role="alert" className="workspace-inline-error">资料窗口应为 1–3650 个自然日。</p>}
        <label className="screening-method-requirement workspace-field-label">{fixed ? '补充其他条件（可选）' : method === 'news' ? '事件与判断要求' : method === 'report' ? '希望研报证实什么' : '技术条件描述'}<textarea aria-label="专用选股要求" className="workspace-field" value={requirement} maxLength={6500} rows={fixed ? 3 : 5} disabled={disabled} onChange={event => onRequirement(event.target.value)} placeholder={fixed ? '例如：同时需要近30日有回购实施的资讯依据。填写后由模型组合规则。' : examples[method][0]} /></label>
        {!fixed && <div className="screening-method-examples" role="group" aria-label="选股要求示例">{examples[method].map((text, index) => <button type="button" className="workspace-button" key={text} disabled={disabled} onClick={() => onRequirement(text)}>{method === 'news' ? ['回购实施', '新增订单', '股东增持'][index] : method === 'report' ? ['订单增长', '毛利率改善', '需求与库存'][index] : ['连续放量', 'RSI 与涨幅', '接近区间高点'][index]}<ArrowRight size={13} /></button>)}</div>}
        <footer className="screening-method-submit"><div>{settings}{useModel ? <small>生成方案后执行；关键要求不清楚时先澄清。</small> : <small className="screening-fixed-note">固定日线规则 · 直接计算</small>}</div><div>{useModel && <button type="button" className="secondary-button workspace-button" disabled={!ready} onClick={() => submit(true)}>只生成方案</button>}<button type="submit" className="primary-button workspace-button" disabled={!ready}><Play size={15} />{disabled ? '正在准备…' : useModel ? '生成并筛选' : '开始筛选'}</button></div></footer>
        {useModel && modelUnavailable && <p role="alert" className="workspace-inline-error">当前模型不可用，请在选股设置中选择可用模型。</p>}
      </form>
      <aside className="screening-method-aside">{method === 'technical' && fixed ? <TechnicalRuleTrial rules={rules} asOf={asOf} disabled={disabled || dateInvalid} /> : <section className="screening-evidence-guide"><h2>{method === 'news' ? '核对事件，再看名单' : method === 'report' ? '让每个判断有原文依据' : '自定义指标与规则'}</h2><ol>{(method === 'news' ? ['按时间窗口查找相关事件', '确认事件与公司的实际关联', '逐只给出判断和资讯原文'] : method === 'report' ? ['按发布日期限定研报范围', '区分实际数据、观点与预测', '给出股票判断、页码和原文'] : ['描述指标、窗口与比较方式', '核对生成的条件和试算', '确认后复用或叠加其他条件']).map(item => <li key={item}>{item}</li>)}</ol><p>符合、不符合与数据不足分别展示。结果保存在统一的筛选记录中。</p>{method !== 'technical' && onBrowse && <button type="button" className="secondary-button workspace-button" onClick={() => onBrowse(method === 'news' ? 'news' : 'reports')}><BookOpen size={16} />{method === 'news' ? '查看资讯原文' : '查看研报原文'}</button>}</section>}
        <ScreeningReadiness data={data} scope={method} task={null} asOf={asOf} onOpenData={onOpenData} compact showScope={false} />
      </aside>
    </div>
  </section>
}
