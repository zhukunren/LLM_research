import type { SavedScreeningTask } from '../../api'
import { TaskLogic, taskUniverseLabel } from './TaskBrief'

function savedTime(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(date) : '未记录'
}

export default function SavedPlanDetails({ item }: { item: SavedScreeningTask }) {
  const task = item.task, ranking = task.scope.ranking
  const metricReference = ranking ? task.references.find(reference => reference.reference_id === ranking.metric_reference_id) : undefined
  const metric = task.conditions.find(condition => condition.condition_id === metricReference?.condition_id)
  const population = ranking?.population_logic_tree
  const priceBasis: Record<string, string> = { unadjusted: '未复权', qfq: '前复权', hfq: '后复权', forward_adjusted: '前复权', backward_adjusted: '后复权', unknown: '口径待确定' }
  return <div className="saved-plan-details-content">
    <section><h3>保存版本与范围</h3><dl className="saved-plan-metadata">
      <div><dt>方案版本</dt><dd>v{item.version}</dd></div>
      <div><dt>保存时间</dt><dd>{savedTime(item.created_at)}</dd></div>
      <div><dt>来源方案修订</dt><dd>第 {task.revision} 版</dd></div>
      <div><dt>原截止日</dt><dd>{task.scope.as_of || '未指定'}</dd></div>
      <div><dt>股票范围</dt><dd>{taskUniverseLabel(task)}</dd></div>
      <div><dt>行情口径</dt><dd>{task.scope.price_basis ? priceBasis[task.scope.price_basis] ?? task.scope.price_basis : '未指定'}</dd></div>
      {task.scope.report_lookback_calendar_days != null && <div><dt>研报回看</dt><dd>{task.scope.report_lookback_calendar_days} 个自然日</dd></div>}
      {task.scope.news_lookback_calendar_days != null && <div><dt>资讯回看</dt><dd>{task.scope.news_lookback_calendar_days} 个自然日</dd></div>}
    </dl>{!!task.scope.universe?.stock_codes.length && <p className="saved-plan-universe-codes">指定证券：<code>{task.scope.universe.stock_codes.join('、')}</code></p>}</section>
    <section><h3>完整条件逻辑</h3><TaskLogic task={task} /></section>
    {ranking && <section><h3>排序规则</h3><p>{metric?.description || String(ranking.metric_name || '排序指标')}</p><dl className="saved-plan-metadata">
      <div><dt>排序范围</dt><dd>{{ all_a_shares: '全部 A 股', watchlist: '自选股票池', after_filters: '通过条件后的股票', industry: '行业内' }[String(ranking.ranking_universe)] ?? '沿用保存范围'}</dd></div>
      <div><dt>排序方向</dt><dd>{ranking.direction === 'ascending' ? '从低到高' : '从高到低'}</dd></div>
      <div><dt>保留数量</dt><dd>{typeof ranking.top_n === 'number' ? `${ranking.top_n} 只` : typeof ranking.top_fraction === 'number' ? `前 ${Number((ranking.top_fraction * 100).toFixed(4))}%（向上取整）` : '未指定'}</dd></div>
      <div><dt>同分处理</dt><dd>{ranking.ties_policy === 'include_all' ? '保留全部同分项' : '按证券代码稳定排序'}</dd></div>
      <div><dt>缺失值处理</dt><dd>{ranking.missing_policy === 'exclude_with_notice' ? '排除并说明' : '保留为数据不足'}</dd></div>
      <div><dt>计算顺序</dt><dd>{ranking.rank_after_filters ? '先筛选，再排名' : '先排名，再筛选'}</dd></div>
    </dl>{population && typeof population === 'object' && !Array.isArray(population) ? <details><summary>排名计算范围的条件</summary><TaskLogic task={task} node={population as Record<string, unknown>} /></details> : null}</section>}
    {!!task.original_user_messages.length && <details className="saved-plan-original-requirements"><summary>保存时的原始要求</summary>{task.original_user_messages.map((message, index) => <p key={index}>{message}</p>)}</details>}
  </div>
}
