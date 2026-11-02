import type { ConversationMessage } from '../../api'
import { answerSources } from './collectAnswerSources'

/** Keep the answer verbatim; metadata labels distinguish publication from retrieval. */
export function copyAnswerProvenance(message: ConversationMessage, resolved: Record<string, unknown>[]) {
  const sources = answerSources({ ...message, source_refs: [...resolved, ...message.source_refs] })
  const value = (source: Record<string, unknown>, key: string) => typeof source[key] === 'string' ? source[key].trim() : ''
  const fields = [['publisher', '发布方'], ['published_at', '发布日期'], ['publication_date', '发布日期'], ['published_date', '发布日期'], ['publisher_declared_date', '发布方声明日期'], ['available_at', '入库时间'], ['retrieved_at', '抓取时间'], ['recorded_at', '记录时间'], ['report_period', '报告期'], ['unit', '单位'], ['currency', '币种'], ['basis', '口径'], ['excerpt', '已有摘录']] as const
  return message.content + '\n\n---\n答复记录时间：' + (message.created_at || '未提供') + '\n来源信息（仅附已有记录，未提供的日期不推断）：\n' + (sources.length ? sources.map((source, index) => {
    const lines = [`${index + 1}. ${value(source, 'title') || value(source, 'source_id') || '来源'}`, source.relation === 'consulted' ? '关系：研究中查阅' : '关系：回答引用']
    const url = value(source, 'url')
    if (/^https?:\/\//i.test(url)) lines.push('链接：' + url)
    if (value(source, 'source_id')) lines.push('来源标识：' + value(source, 'source_id'))
    if (typeof source.page_number === 'number' && Number.isInteger(source.page_number) && source.page_number > 0) lines.push('引用页码：' + source.page_number)
    for (const [key, label] of fields) if (value(source, key)) lines.push(`${label}：${value(source, key)}`)
    return lines.join('\n')
  }).join('\n\n') : '未附来源。')
}
