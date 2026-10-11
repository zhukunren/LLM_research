type ProgressEvent = { method: string; payload: Record<string, unknown> }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const normalized = (value: unknown) => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : ''

// Only inspect event kinds and tool names. Queries, commands, outputs and
// reasoning text must never become the public progress indicator.
function toolLabel(item: Record<string, unknown>): string {
  const tool = record(item.tool)
  const fn = record(item.function)
  const name = normalized(typeof item.tool === 'string' ? item.tool : tool.name || item.name || item.toolName || item.tool_name || fn.name)
  if (/websearch|searchweb|searchquery|searchengine|browsersearch|searchnews|searchresearchsources/.test(name)) return '正在搜索网页'
  if (/readreportpage|readevidencechunk|readpdf|openpdf|extractpdf/.test(name)) return '正在阅读研报'
  if (/readnewschunk|readartifactchunk/.test(name)) return '正在阅读资料'
  if (/readweb|openweb|fetchweb|browseurl|openurl|fetchurl|visitpage|browseropen|readresearchsource|captureresearchpage|downloadresearchsource/.test(name)) return '正在阅读网页'
  if (/inspectresearchpdf|inspectresearchimage/.test(name)) return '正在核对原文与图表'
  if (/searchreportpages|listreportsources|listnewssources|localsearch|searchdocuments|searchfiles|filesearch/.test(name)) return '正在检索本地资料'
  if (/readmarketwindow|getmarketcoverage|searchsecurities|stockquote|marketdata|stockprice|finance|tushare/.test(name)) return '正在核验行情'
  if (/calculate|calculator|comput|python|executequery|runsql/.test(name)) return '正在计算与核对数据'
  return '正在查询资料与数据'
}

/** Translate runtime events into short, factual public activity labels. */
export function codexEventLabel(event: ProgressEvent): string | null {
  const method = event.method
  const payload = event.payload
  const item = record(payload.item)
  const type = normalized(item.type)
  const status = normalized(item.status)

  if (method === 'turn/started') return '正在开始研究'
  if (method === 'turn/failed') return '研究未能完成'
  if (method === 'turn/cancelled' || method === 'turn/interrupted') return '研究已停止'
  if (method === 'turn/completed') {
    const turnStatus = normalized(record(payload.turn).status || payload.status)
    if (turnStatus === 'failed') return '研究未能完成'
    if (turnStatus === 'cancelled' || turnStatus === 'interrupted') return '研究已停止'
    return '研究已完成'
  }
  if (method === 'error') return '研究服务返回错误'
  if (method.startsWith('item/reasoning/')) return '正在分析'
  if (method === 'item/agentMessage/delta' || method === 'item/agent_message/delta') return '正在生成答复'
  if (method !== 'item/started' && method !== 'item/completed') return null
  if (status === 'failed') return '当前步骤未能完成'

  if (type === 'reasoning') return '正在分析'
  if (type === 'websearch' || type === 'websearchcall') {
    if (method === 'item/completed') return '正在整理检索结果'
    const action = normalized(record(item.action).type)
    return action === 'openpage' || action === 'findinpage' || action === 'open' ? '正在阅读网页' : '正在搜索网页'
  }
  if (type === 'mcptoolcall' || type === 'toolcall' || type === 'functioncall' || type === 'dynamictoolcall') {
    if (method === 'item/completed') return '已取得工具结果'
    return toolLabel(item)
  }
  if (type === 'commandexecution') return method === 'item/completed' ? '正在整理计算结果' : '正在计算与核对数据'
  if (type === 'filechange') return '正在整理研究成果'
  if (type === 'agentmessage') return method === 'item/completed' ? '答复已生成' : '正在生成答复'
  return null
}

export type ResearchActivity = { id: string; label: string; text?: string; phase?: string; done: boolean }

/** Public commentary is separate from private reasoning and raw tool output. */
export function appendResearchActivity(previous: ResearchActivity[], event: ProgressEvent & { sequence?: number }): ResearchActivity[] {
  const item = record(event.payload.item)
  const type = normalized(item.type)
  const id = String(item.id || event.payload.itemId || event.payload.item_id || `${event.method}:${event.sequence ?? previous.length}`)
  const index = previous.findIndex(entry => entry.id === id)
  if (event.method === 'item/agentMessage/delta' || event.method === 'item/agent_message/delta') {
    if (index < 0 || previous[index].phase !== 'commentary' || typeof event.payload.delta !== 'string') return previous
    return previous.map((entry, position) => position === index ? { ...entry, text: (entry.text || '') + event.payload.delta } : entry)
  }
  if (!['item/started', 'item/completed', 'turn/started', 'turn/completed', 'turn/failed', 'turn/cancelled', 'turn/interrupted', 'error'].includes(event.method)) return previous
  const label = codexEventLabel(event)
  if (!label) return previous
  const phase = typeof item.phase === 'string' ? item.phase : undefined
  const publicCommentary = type === 'agentmessage' && phase === 'commentary'
  const entry: ResearchActivity = { id, label: publicCommentary ? '研究进展' : index >= 0 ? previous[index].label : label,
    done: event.method === 'item/completed' || event.method.startsWith('turn/'), phase,
    ...(publicCommentary && typeof item.text === 'string' ? { text: item.text } : {}) }
  if (index >= 0) return previous.map((old, position) => position === index ? { ...old, ...entry, text: entry.text ?? old.text } : old)
  return [...previous.slice(-199), entry]
}
