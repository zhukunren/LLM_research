import catalog from './catalog.json'

export type PanelView = {
  layout: 'table' | 'list' | 'library' | 'pattern' | 'strategy' | 'timeline' | 'coverage'
  heading?: string
  title?: string
  summary?: string
  badge?: string
  facts?: readonly string[]
  filterTabs?: string
}

export const panelViews: Record<keyof typeof catalog, PanelView> = {
  projects: { layout: 'list', title: 'name', summary: 'objective', badge: 'status', filterTabs: 'status', facts: ['company_count', 'note_count', 'updated_at'] },
  research: { layout: 'list', title: 'title', badge: 'last_turn_state', facts: ['assistant.name', 'updated_at'] },
  'screening-plans': { layout: 'list', heading: '我的方案', title: 'name', facts: ['version', 'created_at'] },
  'screening-runs': { layout: 'table' },
  conditions: { layout: 'list', title: 'name', summary: 'description', badge: 'library', filterTabs: 'library', facts: ['version'] },
  patterns: { layout: 'pattern', title: 'name', facts: ['version', 'created_at'] },
  observation: { layout: 'table' },
  intelligence: { layout: 'list', title: 'title', badge: 'state', facts: ['kind', 'cutoff_at', 'item_count'] },
  reports: { layout: 'library', title: 'title', facts: ['stock_code', 'publication_date', 'pages'] },
  news: { layout: 'library', title: 'title', summary: 'snippet', facts: ['source', 'published_at'] },
  'daily-signals': { layout: 'strategy', title: 'strategy_title', badge: 'covers_date', facts: ['buy_count', 'sell_count', 'win_rate', 'avg_trade_return', 'ann_return'] },
  'client-service': { layout: 'timeline', title: 'template.title', badge: 'state', facts: ['service_date', 'revision'] },
  'data-status': { layout: 'coverage', heading: '数据与服务' },
}

export function stateTone(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'success' : 'warning'
  if (['active', 'succeeded', 'ready', 'completed', 'success'].includes(String(value))) return 'success'
  if (['partial', 'running', 'pending', 'draft', 'processing'].includes(String(value))) return 'warning'
  if (['failed', 'error'].includes(String(value))) return 'danger'
  if (value === 'priority') return 'primary'
  return 'neutral'
}
