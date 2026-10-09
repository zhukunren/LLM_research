import { expect, it } from 'vitest'
import { createStockMatcher } from './stockMentions'
const stocks = [
  { stock_code: '600519.SH', name: '贵州茅台', market: 'SH' },
  { stock_code: '000001.SZ', name: '平安银行', market: 'SZ' },
  { stock_code: '000001.SH', name: '上证指数', market: '指数' },
  { stock_code: '600000.SH', name: '同名公司', market: 'SH' },
  { stock_code: '000002.SZ', name: '同名公司', market: 'SZ' },
]
it('recognizes verified names and qualified, bare and exchange-prefixed codes', () => {
  const text = '贵州茅台 600519.SH、600519、SH600519、600519.sh与平安银行'
  const tokens = createStockMatcher(stocks).split(text)
  expect(tokens.filter(t => t.code).map(t => t.code)).toEqual(['600519.SH','600519.SH','600519.SH','600519.SH','600519.SH','000001.SZ'])
  expect(tokens.map(t => t.text).join('')).toBe(text)
  expect(createStockMatcher(stocks)).toBe(createStockMatcher(stocks))
})
it('leaves dates, amounts, paths, indices and ambiguous names intact', () => {
  expect(createStockMatcher(stocks).split('20261009 16005190 abc600519 600519.5 收入600519元 ￥600519 同名公司 上证指数 000001.SH 茅台镇 https://example.com/贵州茅台/600519.SH 贵州茅台.pdf').filter(t => t.code)).toEqual([])
  expect(createStockMatcher(stocks).split('000001')).toEqual([{ text: '000001', code: '000001.SZ' }])
  expect(createStockMatcher(stocks).split('茅台')).toEqual([{ text: '茅台', code: '600519.SH' }])
})
