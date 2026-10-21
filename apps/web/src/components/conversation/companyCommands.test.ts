import { expect, it } from 'vitest'
import { matchCommandCompanies, parseCompanyCommand } from './companyCommands'

const securities = [
  { stock_code: '000001.SH', name: '上证指数', market: '指数' },
  { stock_code: '000001.SZ', name: '平安银行', market: 'SZ' },
  { stock_code: '600519.SH', name: '贵州茅台', market: 'SH' },
  { stock_code: '600519.SZ', name: '同号测试公司', market: 'SZ' },
  { stock_code: '000333.SZ', name: '美的集团', market: 'SZ' },
]

it('matches exact names before substrings and resolves qualified codes without guessing the exchange', () => {
  expect(matchCommandCompanies(securities, '贵州茅台').map(item => item.stock_code)).toEqual(['600519.SH'])
  expect(matchCommandCompanies(securities, '茅台').map(item => item.stock_code)).toEqual(['600519.SH'])
  expect(matchCommandCompanies(securities, '600519').map(item => item.stock_code)).toEqual(['600519.SH', '600519.SZ'])
  expect(matchCommandCompanies(securities, '600519.sh').map(item => item.stock_code)).toEqual(['600519.SH'])
  expect(matchCommandCompanies(securities, 'SH600519').map(item => item.stock_code)).toEqual(['600519.SH'])
  expect(matchCommandCompanies(securities, '０００３３３').map(item => item.stock_code)).toEqual(['000333.SZ'])
  expect(matchCommandCompanies(securities, '000001').map(item => item.stock_code)).toEqual(['000001.SZ'])
  expect(matchCommandCompanies(securities, '999999')).toEqual([])
})

it('accepts the requested long command names and keeps ordinary questions outside command dispatch', () => {
  expect(parseCompanyCommand('/查财务 贵州茅台')).toMatchObject({ stage: 'company', command: { kind: 'financials' }, query: '贵州茅台' })
  expect(parseCompanyCommand('/打开原始披露 000333.SZ')).toMatchObject({ stage: 'company', command: { kind: 'disclosures' } })
  expect(parseCompanyCommand('/切换公司 600519')).toMatchObject({ stage: 'company', command: { kind: 'company' } })
  expect(parseCompanyCommand('解释 /财务 命令')).toBeNull()
  expect(parseCompanyCommand('/财务 贵州茅台\n并分析增长')).toMatchObject({ multiline: true })
})
