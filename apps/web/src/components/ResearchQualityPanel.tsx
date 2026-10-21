import { sourceTime } from '../companyResearch'
import type { ProjectQuality } from '../researchWorkbench'
import { useRemoteResource } from '../useRemoteResource'

const issueLabels: Record<string, string> = { note_revision_changed: '笔记已更新，旧依据待复核', quote_mismatch: '原文与保存引用不匹配', outside_cutoff: '资料日期超出截止日或缺失', cell_needs_review: '对比单元格需要复核', cell_pending: '对比单元格待填写或核验' }

export default function ResearchQualityPanel({ projectId, onOpenNote, onOpenMatrices }: { projectId: string; onOpenNote: (id: string) => void; onOpenMatrices: (matrixId?: string, runId?: string) => void }) {
  const resource = useRemoteResource<ProjectQuality>(`/research-projects/${projectId}/quality`)
  const data = resource.data
  return <section className="research-quality-panel" aria-label="研究质量评测">
    <div className="research-section-heading"><h3>研究质量评测</h3><button className="secondary-button workspace-button" onClick={resource.retry}>重新核验项目</button></div>
    {resource.error ? <p role="alert" className="research-error workspace-error">{resource.error}</p> : data ? <>
      <p className="research-secondary">核验于 {sourceTime(data.checked_at)} · 当前检查最多 {data.limits.claims} 项判断、{data.limits.matrix_runs} 次对比</p>
      <dl className="research-quality-metrics workspace-metric-grid"><div className="workspace-metric-card"><dt>保存判断</dt><dd>{data.metrics.claims}</dd></div><div className="workspace-metric-card"><dt>原文与日期核验</dt><dd>{data.metrics.valid_references} / {data.metrics.references}</dd></div><div className="workspace-metric-card"><dt>旧版本待复核</dt><dd>{data.metrics.stale_claims}</dd></div><div className="workspace-metric-card"><dt>对比人工修订</dt><dd>{data.metrics.reviewed_cells} / {data.metrics.matrix_cells}</dd></div></dl>
      <p>{data.note}</p>
      {data.issues.length ? <ul className="research-quality-issues">{data.issues.map((issue, index) => <li key={`${issue.id}:${issue.code}:${index}`}><div><strong>{issue.title}</strong><p>{issueLabels[issue.code] || issue.code}</p></div>{issue.note_id ? <button className="text-button workspace-button" onClick={() => onOpenNote(issue.note_id!)}>查看研究笔记</button> : <button className="text-button workspace-button" onClick={() => onOpenMatrices(issue.id, issue.run_id)}>查看同业对比</button>}</li>)}</ul> : <p>{data.metrics.claims || data.metrics.matrix_cells ? '本次自动核验未发现上述问题，仍需人工判断结论是否被证据支持。' : '项目尚无保存的判断或对比结果，添加带依据的研究后可在此核验。'}</p>}
      {data.issue_count > data.issues.length && <p>还有 {data.issue_count - data.issues.length} 项未展开，请分批核对。</p>}
      <details><summary>真实问题基准与人工评审</summary><p>配套题库含 31 项公开财报摘录任务，核对数字、单位、报告期、历史截止日和缺数拒答；支持真实模型运行及保存答案复评。每次记录模型、耗时与供应商返回的 token 用量，配置单价后可估算费用。</p><p>自动检查通过不能替代语义评审。运行后在人工评审表中记录结论是否充分、是否遗漏反证及是否存在推导错误。使用方式见项目 README 的研究质量评测说明。</p></details>
    </> : <p role="status">正在核验保存的研究证据…</p>}
  </section>
}
