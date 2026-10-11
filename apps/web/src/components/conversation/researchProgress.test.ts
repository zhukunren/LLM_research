import { describe, expect, it } from 'vitest'
import { appendResearchActivity, codexEventLabel } from './researchProgress'

describe('public research activity labels', () => {
  it.each([
    [{ type: 'webSearch', action: { type: 'search', query: '今日热点' } }, '正在搜索网页'],
    [{ type: 'web_search', action: { type: 'open_page', url: 'https://example.com' } }, '正在阅读网页'],
    [{ type: 'webSearchCall', action: { type: 'findInPage' } }, '正在阅读网页'],
    [{ type: 'toolCall', name: 'web_search' }, '正在搜索网页'],
    [{ type: 'mcpToolCall', tool: 'mcp__research__search_report_pages' }, '正在检索本地资料'],
    [{ type: 'mcpToolCall', tool: 'list_news_sources' }, '正在检索本地资料'],
    [{ type: 'mcpToolCall', tool: 'read_report_page' }, '正在阅读研报'],
    [{ type: 'tool_call', name: 'read_pdf' }, '正在阅读研报'],
    [{ type: 'dynamicToolCall', tool: 'read_news_chunk' }, '正在阅读资料'],
    [{ type: 'function_call', function: { name: 'fetch_url' } }, '正在阅读网页'],
    [{ type: 'mcpToolCall', tool: { name: 'read_market_window' } }, '正在核验行情'],
    [{ type: 'toolCall', toolName: 'get_market_coverage' }, '正在核验行情'],
    [{ type: 'toolCall', tool_name: 'calculator' }, '正在计算与核对数据'],
    [{ type: 'commandExecution', command: 'PRIVATE_COMMAND' }, '正在计算与核对数据'],
    [{ type: 'reasoning', summary: 'PRIVATE_REASONING' }, '正在分析'],
    [{ type: 'agentMessage', text: 'PRIVATE_DRAFT' }, '正在生成答复'],
  ])('describes %j without leaking its payload', (item, expected) => {
    expect(codexEventLabel({ method: 'item/started', payload: { item } })).toBe(expected)
  })

  it('uses safe generic descriptions for unknown tools and omits diagnostic events', () => {
    expect(codexEventLabel({ method: 'item/started', payload: { item: { type: 'mcpToolCall', tool: 'PRIVATE_TOOL', arguments: { query: 'PRIVATE_QUERY' }, output: 'PRIVATE_OUTPUT' } } })).toBe('正在查询资料与数据')
    expect(codexEventLabel({ method: 'item/reasoning/summaryTextDelta', payload: { delta: 'PRIVATE_REASONING' } })).toBe('正在分析')
    expect(codexEventLabel({ method: 'item/commandExecution/outputDelta', payload: { delta: 'PRIVATE_STDOUT' } })).toBeNull()
    expect(codexEventLabel({ method: 'thread/tokenUsage/updated', payload: { usage: 100 } })).toBeNull()
  })

  it('reports terminal states and tool failures without claiming success', () => {
    expect(codexEventLabel({ method: 'turn/started', payload: {} })).toBe('正在开始研究')
    expect(codexEventLabel({ method: 'turn/completed', payload: { turn: { status: 'completed' } } })).toBe('研究已完成')
    expect(codexEventLabel({ method: 'turn/completed', payload: { turn: { status: 'failed' } } })).toBe('研究未能完成')
    expect(codexEventLabel({ method: 'turn/completed', payload: { turn: { status: 'interrupted' } } })).toBe('研究已停止')
    expect(codexEventLabel({ method: 'item/completed', payload: { item: { type: 'mcpToolCall', status: 'failed', error: 'PRIVATE_ERROR' } } })).toBe('当前步骤未能完成')
  })
})

it('streams explicit public commentary while excluding reasoning, final drafts and command output', () => {
  let items = appendResearchActivity([], { method: 'item/started', payload: { item: { id: 'public', type: 'agentMessage', phase: 'commentary', text: '' } } })
  items = appendResearchActivity(items, { method: 'item/agentMessage/delta', payload: { itemId: 'public', delta: '正在核对公告。' } })
  items = appendResearchActivity(items, { method: 'item/reasoning/summaryTextDelta', payload: { delta: 'PRIVATE_REASONING' } })
  items = appendResearchActivity(items, { method: 'item/agentMessage/delta', payload: { itemId: 'final', delta: 'PRIVATE_DRAFT' } })
  items = appendResearchActivity(items, { method: 'item/commandExecution/outputDelta', payload: { delta: 'PRIVATE_COMMAND_OUTPUT' } })
  expect(items).toHaveLength(1)
  expect(items[0].text).toBe('正在核对公告。')
  expect(JSON.stringify(items)).not.toContain('PRIVATE')
})

it('updates a tool step in place after its completion without repeating the activity', () => {
  let items = appendResearchActivity([], { method: 'item/started', payload: { item: { id: 'search', type: 'mcpToolCall', tool: 'search_research_sources' } } })
  items = appendResearchActivity(items, { method: 'item/completed', payload: { item: { id: 'search', type: 'mcpToolCall', tool: 'search_research_sources', result: 'PRIVATE_OUTPUT' } } })
  expect(items).toEqual([{ id: 'search', label: '正在搜索网页', done: true, phase: undefined, text: undefined }])
})
