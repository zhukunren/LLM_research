import type { Filter } from './api'
import type { Node } from './pages/StrategyPage'

export type LibraryScope = Filter['library']
export type LibrarySeed = { id: string; prompt?: string; source_document_id?: string; source_page?: number; title?: string }
export const libraryCopy = {
  technical: { title: '技术指标库', browse: '浏览指标', intro: '常见指标和自定义时序指标都可以描述，生成后先核对计算口径与实际行情。', promptTitle: '你想用哪些行情条件选股？', placeholder: '描述行情字段、计算窗口、比较方式和连续条件', examples: ['连续3日成交量高于此前20日均量', 'RSI14大于45，且近5个交易日涨幅超过3%', '当前收盘价距近20日最高收盘价不超过5%'] },
  report: { title: '研报库', browse: '阅读研报', intro: '阅读原文、核对证据，把研究想法整理为可复用的判断条件。', promptTitle: '你希望从研报中判断什么？', placeholder: '例如：公司订单实际增长，行业需求改善，区分已实现业绩与未来预测', examples: ['研报中有公司订单增长的实际证据，并区分已实现与未来预测', '过去365个自然日的研报显示公司毛利率改善', '研报提供行业需求回暖和库存下降的实际证据'] },
  news: { title: '资讯库', browse: '浏览资讯', intro: '在同一个地方浏览资讯、整理关注点、积累筛选条件。', promptTitle: '你希望关注什么资讯？', placeholder: '例如：近30个自然日资讯包含“回购”', examples: ['近30个自然日资讯包含“回购”', '近7个自然日资讯包含“订单”', '近30个自然日资讯包含“增持”'] },
} as const

export function writeCombination(tree: Node, name = '我的选股组合') {
  localStorage.setItem('workbench.tree', JSON.stringify(tree.op.endsWith('_ref') ? { op: 'all', children: [tree] } : tree))
  localStorage.setItem('workbench.strategyId', JSON.stringify(''))
  localStorage.setItem('workbench.strategyName', JSON.stringify(name))
  localStorage.setItem('workbench.section', JSON.stringify('compose'))
}

export function appendCombination(node: Node) {
  let previous: Node = { op: 'all', children: [] }
  try { const raw = localStorage.getItem('workbench.tree'); if (raw) previous = JSON.parse(raw) as Node } catch { /* Start an empty combination if browser storage is damaged. */ }
  const tree = previous.op === 'all' ? { ...previous, children: [...(previous.children ?? []), node] } : { op: 'all', children: [previous, node] }
  localStorage.setItem('workbench.tree', JSON.stringify(tree))
  localStorage.setItem('workbench.section', JSON.stringify('compose'))
}
