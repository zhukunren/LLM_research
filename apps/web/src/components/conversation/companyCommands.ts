import type { Security } from '../StockSearch'

export type CommandCompany = Pick<Security, 'stock_code' | 'name'>
export type CompanyCommandKind = 'financials' | 'disclosures' | 'company' | 'reports' | 'news' | 'market'
export type CompanyCommand = { kind: CompanyCommandKind; name: string; aliases: string[]; label: string; description: string }
export const companyCommands: CompanyCommand[] = [
  { kind: 'financials', name: '财务', aliases: ['财务', '查财务'], label: '查财务', description: '打开年度、单季与 TTM 财务序列' },
  { kind: 'disclosures', name: '披露', aliases: ['披露', '原始披露', '打开原始披露'], label: '打开原始披露', description: '查看公司归档的原文与修订版本' },
  { kind: 'company', name: '公司', aliases: ['公司', '切换公司'], label: '切换公司', description: '设置后续提问使用的当前公司' },
  { kind: 'reports', name: '研报', aliases: ['研报', '查研报', '打开研报'], label: '查看公司研报', description: '按公司归属查看本地研报与 PDF 原文' },
  { kind: 'news', name: '资讯', aliases: ['资讯', '查资讯', '打开资讯'], label: '查看公司资讯', description: '查看已关联公司的资讯和正文' },
  { kind: 'market', name: '行情', aliases: ['行情', '查行情'], label: '查看公司行情', description: '查看本地日线和实际行情日期' },
]

export function parseCompanyCommand(value: string) {
  const text = value.trimStart()
  if (!text.startsWith('/')) return null
  const token = text.slice(1).split(/\s/u)[0]
  const command = companyCommands.find(item => item.aliases.includes(token))
  return command
    ? { stage: 'company' as const, command, query: text.slice(token.length + 1).trim(), multiline: /[\r\n]/.test(text) }
    : { stage: 'command' as const, term: token, commands: companyCommands.filter(item => item.aliases.some(alias => alias.startsWith(token))) }
}

function normalize(value: string) {
  const text = value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  return text.replace(/^(sh|sz|bj)(\d{6})$/, '$2.$1').replace(/^(\d{6})(sh|sz|bj)$/, '$1.$2')
}

export function matchCommandCompanies(items: Security[], query: string): CommandCompany[] {
  const needle = normalize(query)
  if (!needle) return []
  return items.filter(item => /^\d{6}\.(SH|SZ|BJ)$/.test(item.stock_code) && item.market !== '指数')
    .map((item, index) => {
      const code = normalize(item.stock_code), name = normalize(item.name)
      const exact = [code, name, code.slice(0, 6)].includes(needle)
      const searchable = [code, name, normalize(item.pinyin || ''), normalize(item.initials || '')]
      const score = exact ? 0 : searchable.some(value => value.startsWith(needle)) ? 1 : searchable.some(value => value.includes(needle)) ? 2 : 3
      return { item, index, score }
    })
    .filter(item => item.score < 3)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, 8).map(({ item }) => ({ stock_code: item.stock_code, name: item.name }))
}

export function companyQuestion(value: string, company: CommandCompany | null) {
  return company ? '当前研究公司：' + company.name + '（' + company.stock_code + '）。\n' + value : value
}
