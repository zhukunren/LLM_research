import { useEffect, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { api, type ConversationSourceReference, type Pattern } from '../../api'
import { evidenceScreeningPrompt, screeningMethods, templateDescription, type EvidenceBasis, type ScreeningMethod } from '../../screeningMethods'
import ConditionWorkspaceDrawer from '../ConditionWorkspaceDrawer'
import { EvidenceConditionFields } from './ScreeningMethodSetup'
import { TechnicalRuleFields, useTechnicalRules } from './TechnicalRuleEditor'
import { screeningMethodIcons } from './ScreeningMethodCards'

export type AddedScreeningSource = { reference: ConversationSourceReference; label: string }

export default function ScreeningAddConditions({ asOf, disabled, onPrepare }: { asOf: string; disabled?: boolean; onPrepare: (text: string, source?: AddedScreeningSource) => boolean | void }) {
  const [open, setOpen] = useState(false)
  return <><button type="button" className="secondary-button workspace-button screening-add-condition" disabled={disabled} onClick={() => setOpen(true)}><Plus size={15} />叠加条件</button>{open && <ConditionBuilder asOf={asOf} onClose={() => setOpen(false)} onPrepare={(text, source) => { if (onPrepare(text, source) !== false) setOpen(false) }} />}</>
}

function ConditionBuilder({ asOf, onClose, onPrepare }: { asOf: string; onClose: () => void; onPrepare: (text: string, source?: AddedScreeningSource) => void }) {
  const [method, setMethod] = useState<ScreeningMethod>('technical')
  const [requirements, setRequirements] = useState<Record<string, string>>({})
  const [windows, setWindows] = useState({ news: '30', report: '365' })
  const [basis, setBasis] = useState<EvidenceBasis>('actual')
  const [patterns, setPatterns] = useState<Pattern[]>([]), [patternId, setPatternId] = useState('')
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const rules = useTechnicalRules(method === 'technical', 'screening.extend.technical')
  useEffect(() => {
    if (method !== 'pattern') return
    const controller = new AbortController(); setLoading(true); setError('')
    api<{ items: Pattern[] }>('/patterns', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setPatterns(result.items) }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [method, retry])
  const selectedPattern = patterns.find(item => `${item.id}@${item.version}` === patternId)
  const lookback = method === 'news' || method === 'report' ? windows[method] : ''
  const requirement = requirements[method] || ''
  const invalid = method === 'technical' ? rules.invalid : method === 'pattern' ? !selectedPattern : !requirement.trim() || !/^\d+$/.test(lookback) || Number(lookback) < 1 || Number(lookback) > 3650
  function prepare() {
    if (invalid) return
    const condition = method === 'technical' ? templateDescription(rules.selected!, rules.parameters)
      : method === 'pattern' ? `采用已保存形态“${selectedPattern!.name}”第 ${selectedPattern!.version} 版作为新增形态条件，沿用模板记录的相似度与匹配窗口设置。`
        : evidenceScreeningPrompt(method, requirement, { lookback: Number(lookback), basis }, asOf)
    onPrepare(`请在当前筛选方案上增加以下条件，保留已有条件及参数、原组合关系、股票范围和截止日期；新增条件与原整组条件需全部满足。\n\n${condition}`,
      selectedPattern && method === 'pattern' ? { reference: { kind: 'pattern', source_id: selectedPattern.id, version: selectedPattern.version }, label: `${selectedPattern.name} · v${selectedPattern.version}` } : undefined)
  }
  return <ConditionWorkspaceDrawer title="叠加选股条件" description="保留当前方案，再增加一种判断依据。确认后先放入对话，发送时才修改和筛选。" closeLabel="关闭叠加条件" className="screening-condition-builder" onClose={onClose} footer={<><span>沿用当前截止日期 {asOf || '待核对'}</span><button type="button" className="primary-button workspace-button" disabled={invalid} onClick={prepare}>加入待发送要求</button></>}>
    <div className="screening-extension-methods" role="group" aria-label="新增条件来源">{screeningMethods.map(item => { const Icon = screeningMethodIcons[item.id]; return <button type="button" className="workspace-button" aria-pressed={method === item.id} key={item.id} onClick={() => setMethod(item.id)}><Icon size={16} />{item.label}</button> })}</div>
    {method === 'technical' ? <TechnicalRuleFields rules={rules} /> : method === 'pattern' ? <div className="screening-extension-patterns">
      {loading && <p role="status">正在读取已保存形态…</p>}{error && <p role="alert" className="workspace-error">{error}<button type="button" className="text-button workspace-button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />重试</button></p>}
      <label className="workspace-field-label">已保存形态<select className="workspace-field workspace-select" aria-label="叠加的形态模板" value={patternId} disabled={loading} onChange={event => setPatternId(event.target.value)}><option value="">选择模板</option>{patterns.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name} · v{item.version}</option>)}</select></label>
      {!loading && !error && !patterns.length && <p>暂无已保存形态。可先在形态选股中建立并保存目标。</p>}
      {selectedPattern && <p>固定使用 v{selectedPattern.version}。相似度参考 {String(selectedPattern.params.min_similarity ?? 80)} 分，{selectedPattern.params.match_mode === 'recent' ? '回看近期区间' : '对照截止日窗口'}。</p>}
    </div> : <>
      <EvidenceConditionFields method={method} lookback={lookback} basis={basis} onLookback={value => setWindows(current => ({ ...current, [method]: value }))} onBasis={setBasis} />
      <label className="workspace-field-label">新增判断要求<textarea className="workspace-field" aria-label="新增判断要求" rows={5} maxLength={3000} value={requirement} onChange={event => setRequirements(current => ({ ...current, [method]: event.target.value }))} placeholder={method === 'news' ? '例如：有已实施回购的资讯依据' : '例如：研报提供订单实际增长的证据'} /></label>
    </>}
  </ConditionWorkspaceDrawer>
}
