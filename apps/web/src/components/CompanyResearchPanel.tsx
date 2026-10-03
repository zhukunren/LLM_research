import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { type CompanyDossier, type ResearchSource } from '../companyResearch'
import ResearchSourceReader, { CompanySources } from './ResearchSourceReader'
const MarketIndicatorChart = lazy(() => import('../pages/TechnicalBrowser').then(module => ({ default: module.MarketIndicatorChart })))

export default function CompanyResearchPanel({ projectId, code, asOf, onDateChange }: { projectId: string; code: string; asOf: string; onDateChange: (date: string) => void }) {
  const [dossier, setDossier] = useState<CompanyDossier | null>(null)
  const [selected, setSelected] = useState<ResearchSource | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const chartFrame = useRef<HTMLDivElement>(null)
  const [chartWidth, setChartWidth] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setDossier(null); setSelected(null); setError('')
    api<CompanyDossier>(`/research-projects/${projectId}/companies/${code}?as_of=${asOf}`, { signal: controller.signal })
      .then(setDossier).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
    return () => controller.abort()
  }, [projectId, code, asOf, reload])
  useEffect(() => {
    if (!chartFrame.current) return
    const observer = new ResizeObserver(entries => setChartWidth(Math.floor(entries[0].contentRect.width)))
    observer.observe(chartFrame.current)
    return () => observer.disconnect()
  }, [dossier])
  const bars = dossier?.bars.filter(bar => bar.quality_valid) || []
  const qualityLabel = (value?: string) => !value || value === 'unknown' ? '待核实' : value
  return <section className="company-research-panel" aria-label="公司研究">
    <div className="research-section-heading"><h3>{dossier?.name || code} · 公司研究</h3><label className="company-research-date">研究截至<input aria-label="公司研究截止日" type="date" value={asOf} onChange={event => { if (event.target.value) onDateChange(event.target.value) }} /></label></div>
    {error ? <p role="alert" className="research-error">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重新加载公司</button></p> : dossier ? <>
      <p className="research-secondary">{dossier.news.total} 份资讯 · {dossier.reports.total} 份研报 · {dossier.note_count} 份关联笔记{dossier.pending_report_count ? ` · ${dossier.pending_report_count} 份研报日期或证券归属待核验` : ''}</p>
      {bars.length ? <><p className="research-secondary">行情实际截至 {dossier.market_as_of} · 价格口径 {qualityLabel(dossier.market_quality.price_basis)} · 成交量单位 {qualityLabel(dossier.market_quality.volume_unit)} · 成交额单位 {qualityLabel(dossier.market_quality.amount_unit)}{dossier.invalid_bars ? ` · 已跳过 ${dossier.invalid_bars} 条异常行情` : ''}</p><div className="company-research-chart" ref={chartFrame}><Suspense fallback={<p>正在打开行情图…</p>}><MarketIndicatorChart containerWidth={chartWidth || undefined} chart={{ bars, placement: 'overlay', lines: [], histogram: null, reference_lines: [] }} /></Suspense></div></> : <p className="research-secondary">该截止日前没有可用的有效行情。</p>}
      <p className="research-secondary">{dossier.coverage_note}</p>
      <CompanySources key={`${code}:${asOf}`} projectId={projectId} code={code} asOf={asOf} onChoose={setSelected} />
      {selected && <ResearchSourceReader key={`${selected.source_id}:${asOf}`} projectId={projectId} code={code} asOf={asOf} source={selected} />}
    </> : <p role="status">正在汇集公司行情与资料…</p>}
  </section>
}
