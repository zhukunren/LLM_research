import type { ResearchReadingBrief } from '../../api'
import './research-summary.css'

const pointLabels = { fact: '有据事实', inference: '研究推断', unknown: '待核实' }

export default function ResearchSummary({ value }: { value?: ResearchReadingBrief | null }) {
  if (!value?.conclusion || value.version !== 1) return null
  return <section className="research-reading-brief" aria-label="研究摘要">
    <header><span>研究摘要</span><small>依据与完整论证见下文</small></header>
    <p className="research-brief-conclusion">{value.conclusion}</p>
    {!!value.key_points.length && <div className="research-brief-points"><h3>核心依据与判断</h3><ul>{value.key_points.map((point, index) => <li key={index}><span className={`research-brief-kind research-brief-kind-${point.kind}`}>{pointLabels[point.kind]}</span><span>{point.text}</span></li>)}</ul></div>}
    <div className="research-brief-followup">
      {!!value.risks.length && <div><h3>主要风险</h3><ul>{value.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></div>}
      {!!value.next_steps.length && <div><h3>待验证事项</h3><ul>{value.next_steps.map((step, index) => <li key={index}>{step}</li>)}</ul></div>}
    </div>
    <footer><span>{value.data_as_of ? `资料截至 ${value.data_as_of}` : '资料未统一截止日'}</span>{value.data_note && <span>{value.data_note}</span>}</footer>
  </section>
}
