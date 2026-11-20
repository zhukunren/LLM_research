import { useEffect, useState } from 'react'
import { BookOpenText, ChartNoAxesCombined, Plus, RefreshCw, TrendingUp } from 'lucide-react'
import { api, type ConversationSourceReference, type Pattern } from '../../api'
import { evidenceScreeningPrompt, templateDescription, type EvidenceBasis } from '../../screeningMethods'
import ConditionWorkspaceDrawer from '../ConditionWorkspaceDrawer'
import { EvidenceConditionFields } from './ScreeningMethodSetup'
import { TechnicalRuleFields, useTechnicalRules } from './TechnicalRuleEditor'

export type AddedScreeningSource = { reference: ConversationSourceReference; label: string }
const extensionKinds = [
  { id: 'technical', label: '固定规则', icon: TrendingUp },
  { id: 'materials', label: '资料条件', icon: BookOpenText },
  { id: 'pattern', label: '已保存形态', icon: ChartNoAxesCombined },
] as const
type ExtensionKind = (typeof extensionKinds)[number]['id']

export default function ScreeningAddConditions({ asOf, disabled, onPrepare, materialsOnly = false }: { asOf: string; disabled?: boolean; materialsOnly?: boolean; onPrepare: (text: string, source?: AddedScreeningSource) => boolean | void }) {
  const [open, setOpen] = useState(false)
  return <><button type="button" className="secondary-button workspace-button screening-add-condition" disabled={disabled} onClick={() => setOpen(true)}><Plus size={15} />{materialsOnly ? '添加资料条件' : '叠加条件'}</button>{open && <ConditionBuilder asOf={asOf} materialsOnly={materialsOnly} onClose={() => setOpen(false)} onPrepare={(text, source) => { if (onPrepare(text, source) !== false) setOpen(false) }} />}</>
}

function ConditionBuilder({ asOf, materialsOnly, onClose, onPrepare }: { asOf: string; materialsOnly: boolean; onClose: () => void; onPrepare: (text: string, source?: AddedScreeningSource) => void }) {
  const [method, setMethod] = useState<ExtensionKind>(materialsOnly ? 'materials' : 'technical')
  const [sourceKind, setSourceKind] = useState<'news' | 'report'>('news')
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
  const lookback = windows[sourceKind]
  const requirement = requirements[sourceKind] || ''
  const invalid = method === 'technical' ? rules.invalid : method === 'pattern' ? !selectedPattern : !requirement.trim() || !/^\d+$/.test(lookback) || Number(lookback) < 1 || Number(lookback) > 3650
  function prepare() {
    if (invalid) return
    const condition = method === 'technical' ? templateDescription(rules.selected!, rules.parameters)
      : method === 'pattern' ? `采用已保存形态“${selectedPattern!.name}”第 ${selectedPattern!.version} 版作为新增形态条件，沿用模板记录的相似度与匹配窗口设置。`
        : evidenceScreeningPrompt(sourceKind, requirement, { lookback: Number(lookback), basis }, asOf)
    onPrepare(`请在当前筛选方案上增加以下条件，保留已有条件及参数、原组合关系、股票范围和截止日期；新增条件与原整组条件需全部满足。\n\n${condition}`,
      selectedPattern && method === 'pattern' ? { reference: { kind: 'pattern', source_id: selectedPattern.id, version: selectedPattern.version }, label: `${selectedPattern.name} · v${selectedPattern.version}` } : undefined)
  }
  return <ConditionWorkspaceDrawer title={materialsOnly ? '添加资料条件' : '叠加选股条件'} description="先把条件加入待发送要求，再选择只改方案或重新筛选。" closeLabel={materialsOnly ? '关闭资料条件' : '关闭叠加条件'} className="screening-condition-builder" onClose={onClose} footer={<><span>沿用当前截止日期 {asOf || '待核对'}</span><button type="button" className="primary-button workspace-button" disabled={invalid} onClick={prepare}>加入待发送要求</button></>}>
    {!materialsOnly && <div className="screening-extension-methods" role="group" aria-label="新增条件类型">{extensionKinds.map(({ id, label, icon: Icon }) => (
      <button type="button" className="workspace-button" aria-pressed={method === id} key={id} onClick={() => setMethod(id)}><Icon size={16} aria-hidden="true" />{label}</button>
    ))}</div>}
    {method === 'technical' ? <TechnicalRuleFields rules={rules} /> : method === 'pattern' ? <div className="screening-extension-patterns">
      {loading && <p role="status">正在读取已保存形态…</p>}{error && <p role="alert" className="workspace-error">{error}<button type="button" className="text-button workspace-button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />重试</button></p>}
      <label className="workspace-field-label">已保存形态<select className="workspace-field workspace-select" aria-label="叠加的形态模板" value={patternId} disabled={loading} onChange={event => setPatternId(event.target.value)}><option value="">选择模板</option>{patterns.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name} · v{item.version}</option>)}</select></label>
      {!loading && !error && !patterns.length && <p>暂无已保存形态。可从「选取形态样本」新建并保存。</p>}
      {selectedPattern && <p>固定使用 v{selectedPattern.version}。相似度参考 {String(selectedPattern.params.min_similarity ?? 80)} 分，{selectedPattern.params.match_mode === 'recent' ? '回看近期区间' : '对照截止日窗口'}。</p>}
    </div> : <>
      <label className="workspace-field-label">资料来源<select aria-label="资料来源" className="workspace-field workspace-select" value={sourceKind} onChange={event => setSourceKind(event.target.value as 'news' | 'report')}><option value="news">资讯</option><option value="report">研报</option></select></label>
      <EvidenceConditionFields method={sourceKind} lookback={lookback} basis={basis} onLookback={value => setWindows(current => ({ ...current, [sourceKind]: value }))} onBasis={setBasis} />
      <label className="workspace-field-label">新增判断要求<textarea className="workspace-field" aria-label="新增判断要求" rows={5} maxLength={3000} value={requirement} onChange={event => setRequirements(current => ({ ...current, [sourceKind]: event.target.value }))} placeholder={sourceKind === 'news' ? '例如：有已实施回购的资讯依据' : '例如：研报提供订单实际增长的证据'} /></label>
    </>}
  </ConditionWorkspaceDrawer>
}
