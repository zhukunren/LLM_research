import LoadingState from './LoadingState'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useRemoteResource } from '../useRemoteResource'
import { claimKinds, type CompanyDossier, type ResearchSource } from '../companyResearch'
import { noteStatuses } from '../research'
import ResearchChangesPanel from './ResearchChangesPanel'
import ResearchSourceReader, { CompanySources } from './ResearchSourceReader'
import DisclosuresPanel from './DisclosuresPanel'
import CompanyFinancialsPanel from './CompanyFinancialsPanel'
const MarketIndicatorChart = lazy(() => import('./MarketIndicatorChart').then(module => ({ default: module.MarketIndicatorChart })))

export default function CompanyResearchPanel({ projectId, code, asOf, onDateChange, writable = true, onOpenNote, onStartResearch }: { projectId: string; code: string; asOf: string; onDateChange: (date: string) => void; writable?: boolean; onOpenNote?: (id: string) => void; onStartResearch?: () => void }) {
  const { data: dossier, error, retry } = useRemoteResource<CompanyDossier>(`/research-projects/${projectId}/companies/${code}?as_of=${asOf}`)
  const [selected, setSelected] = useState<ResearchSource | null>(null)
  const chartFrame = useRef<HTMLDivElement>(null)
  const [chartWidth, setChartWidth] = useState(0)
  useEffect(() => setSelected(null), [projectId, code, asOf])
  useEffect(() => {
    if (!chartFrame.current) return
    const observer = new ResizeObserver(entries => setChartWidth(Math.floor(entries[0].contentRect.width)))
    observer.observe(chartFrame.current)
    return () => observer.disconnect()
  }, [dossier])
  const bars = dossier?.bars.filter(bar => bar.quality_valid) || []
  const qualityLabel = (value?: string) => !value || value === 'unknown' ? '待核实' : value
  return <section className="company-research-panel" aria-label="公司研究">
    <div className="research-section-heading"><h3>{dossier?.name || code} · 公司研究</h3><label className="company-research-date workspace-field-label">研究截至<input aria-label="公司研究截止日" type="date" value={asOf} onChange={event => { if (event.target.value) onDateChange(event.target.value) }} className="workspace-field" /></label></div>
    {error ? <p role="alert" className="research-error workspace-error">{error}<button className="text-button workspace-button" onClick={retry}>重新加载公司</button></p> : dossier ? <>
      <p className="research-secondary">{dossier.news.total} 份资讯 · {dossier.reports.total} 份研报 · {dossier.note_count} 份关联笔记{dossier.pending_report_count ? ` · ${dossier.pending_report_count} 份研报日期或证券归属待核验` : ''}</p>
      {onStartResearch && <button className="secondary-button workspace-button" disabled={!writable} onClick={onStartResearch}>继续研究这家公司</button>}
      {dossier.research && <div className="company-research-context"><h4>为什么关注与待验证问题</h4>
        {dossier.research.notes.length ? dossier.research.notes.map(note => <article className="company-research-note" key={note.id}><div className="research-section-heading"><strong>{note.title}</strong><span>{noteStatuses[note.status]} · 第 {note.revision} 版</span></div><p>验证计划：{note.validation_plan || '尚未填写'}</p><p>失效条件：{note.invalidation_condition || '尚未填写'}</p>{onOpenNote && <button className="text-button workspace-button" onClick={() => onOpenNote(note.id)}>打开这份研究笔记</button>}</article>) : <p className="research-secondary">尚无关联研究笔记，可从研究答复保存或在项目中添加。</p>}
        {dossier.research.claims.length > 0 && <details><summary>已保存判断与依据（{dossier.research.claims.length} 项）</summary>{dossier.research.claims.map(claim => <article className="company-research-note" key={claim.id}><strong>{claim.statement}</strong><p>{claimKinds[claim.kind]} · 资料截至 {claim.as_of} · {claim.evidence.length} 条原文依据 · {claim.numeric_evidence?.length || 0} 份数字依据{claim.needs_revalidation ? ' · 笔记已更新，旧依据待复核' : ''}</p>{onOpenNote && <button className="text-button workspace-button" onClick={() => onOpenNote(claim.note_id)}>查看判断与原文依据</button>}</article>)}</details>}
        {dossier.research.observations.length > 0 && <details><summary>本项目的观察记录</summary>{dossier.research.observations.map(item => <article className="company-research-note" key={item.id}><strong>{item.note || '观察记录'}</strong><p>验证：{item.verification || '待补充'}</p><p>失效：{item.invalidation || '待补充'}</p></article>)}</details>}
        <p className="research-secondary">{dossier.research.note}</p>
      </div>}
      {bars.length ? <><p className="research-secondary">行情实际截至 {dossier.market_as_of} · 价格口径 {qualityLabel(dossier.market_quality.price_basis)} · 成交量单位 {qualityLabel(dossier.market_quality.volume_unit)} · 成交额单位 {qualityLabel(dossier.market_quality.amount_unit)}{dossier.invalid_bars ? ` · 已跳过 ${dossier.invalid_bars} 条异常行情` : ''}</p><div className="company-research-chart" ref={chartFrame}><Suspense fallback={<p>正在打开行情图…</p>}><MarketIndicatorChart containerWidth={chartWidth || undefined} chart={{ bars, placement: 'overlay', lines: [], histogram: null, reference_lines: [] }} /></Suspense></div></> : <p className="research-secondary">该截止日前没有可用的有效行情。</p>}
      <p className="research-secondary">{dossier.coverage_note}</p>
      {[...dossier.news.items, ...dossier.reports.items].length > 0 && <details><summary>最近资料时间线</summary>{[...dossier.news.items, ...dossier.reports.items].sort((left, right) => new Date(right.available_at).valueOf() - new Date(left.available_at).valueOf()).slice(0, 12).map(item => <button className="company-source-row workspace-button" key={`${item.source_type}:${item.source_id}`} onClick={() => setSelected(item)}><strong>{item.title}</strong><span>{item.available_at} · {item.source_type === 'report' ? '研报' : '资讯'}</span></button>)}</details>}
      <CompanySources key={`${code}:${asOf}`} projectId={projectId} code={code} asOf={asOf} onChoose={setSelected} />
      <DisclosuresPanel stockCode={code} asOf={asOf} writable={writable} compact />
      <CompanyFinancialsPanel stockCode={code} asOf={asOf} writable={writable} />
      {selected && <ResearchSourceReader key={`${selected.source_id}:${asOf}`} projectId={projectId} code={code} asOf={asOf} source={selected} />}
      <ResearchChangesPanel key={`${projectId}:${code}`} projectId={projectId} code={code} asOf={asOf} writable={writable} onOpenNote={onOpenNote} />
    </> : <LoadingState compact label="正在汇集公司行情与资料…" />}
  </section>
}
