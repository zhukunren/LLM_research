import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tushareColumns } from '../components/tushare/tushareColumnNames'
import TushareDownloadPage from './TushareDownloadPage'
import { readTushareResult } from './TushareDownloadResult'

const daily = {
  id: 'daily', category: 'A 股行情', label: 'A 股日线', description: '未复权日线。',
  mode: 'range', code_label: '股票代码', code_example: '600519.SH', market_wide: true, market_day_limit: true,
  date_label: '交易日期', points: 120, doc_url: 'https://tushare.pro/document/2?doc_id=27',
}
const month = {
  ...daily, id: 'broker_recommend', category: '特色数据', label: '券商月度金股', mode: 'month',
  code_label: '', code_example: null, market_wide: false, market_day_limit: false,
  date_label: null, points: 6000,
}
const catalog = { configured: true, earliest_date: '1990-01-01', market_days: 7, datasets: [daily, month] }
const catalogPath = '/api/v1/tushare-download/catalog'

beforeEach(async () => { vi.stubGlobal('Blob', (await new Response().blob()).constructor) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('shows Chinese headings and downloads all queried rows with the same headings', async () => {
  const csv = '\uFEFFts_code,trade_date,close,note\r\n600519.SH,20261120,10.1234567890123456,"长文本,含有""引号""\r\n下一行"\r\n'
    + Array.from({ length: 30 }, (_, index) => `600519.SH,20261120,,记录 ${index + 2}\r\n`).join('')
  const fetcher = vi.fn(async (path: string) => path === catalogPath ? Response.json(catalog) : new Response(csv, {
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="tushare-daily-600519.SH.csv"', 'X-Row-Count': '31' },
  }))
  vi.stubGlobal('fetch', fetcher)
  const started: string[] = []
  const exported: Blob[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { started.push(this.download) })
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn((blob: Blob) => { exported.push(blob); return 'blob:csv' })
    static revokeObjectURL = vi.fn()
  })

  render(<TushareDownloadPage onSettings={vi.fn()} />)
  const action = await screen.findByRole('button', { name: '查询数据' })
  expect(screen.queryByRole('button', { name: '下载 CSV' })).not.toBeInTheDocument()
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([catalogPath])
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('股票代码（选填）'), '600519.sh')
  fireEvent.change(screen.getByLabelText('开始交易日期'), { target: { value: '2026-11-20' } })
  fireEvent.change(screen.getByLabelText('结束交易日期'), { target: { value: '2026-11-20' } })
  await user.click(action)
  expect(await screen.findByRole('table', { name: '查询结果' })).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('共 31 条记录')
  expect(screen.getByRole('columnheader', { name: '证券代码' })).toHaveAttribute('title', 'ts_code')
  expect(screen.getByRole('columnheader', { name: '收盘价' })).toHaveAttribute('title', 'close')
  expect(screen.getByText('10.1234567890123456')).toBeInTheDocument()
  expect(screen.getByText('长文本,含有"引号" 下一行')).toBeInTheDocument()
  expect(screen.queryByText('记录 31')).not.toBeInTheDocument()
  expect(started).toEqual([])
  expect(exported).toEqual([])
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/v1/tushare-download/daily?code=600519.SH&start_date=2026-11-20&end_date=2026-11-20')
  await user.click(screen.getByRole('button', { name: '下一页' }))
  expect(screen.getByText('记录 31')).toBeInTheDocument()
  expect(screen.queryByText('10.1234567890123456')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '下载 CSV' }))
  expect(started).toEqual(['tushare-daily-600519.SH.csv'])
  const translated = csv.replace('ts_code,trade_date,close,note', '证券代码,交易日期,收盘价,备注')
  expect(Array.from(new Uint8Array(await exported[0].arrayBuffer()))).toEqual(Array.from(new TextEncoder().encode(translated)))
  expect(fetcher).toHaveBeenCalledTimes(2)
  await user.selectOptions(screen.getByLabelText('数据类型'), 'broker_recommend')
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '下载 CSV' })).not.toBeInTheDocument()
})

it('uses dataset-specific meanings and preserves a CSV body served without a BOM', async () => {
  expect(tushareColumns('daily', ['amount'])[0].label).toBe('成交额（千元）')
  expect(tushareColumns('fund_portfolio', ['amount'])[0].label).toBe('持仓股数')
  expect(tushareColumns('repurchase', ['end_date'])[0].label).toBe('回购截止日期')
  expect(tushareColumns('cn_pmi', ['pmi010501'])[0].label).toBe('大型企业制造业新订单指数')

  const response = new Response('ts_code,end_date,total_assets\r\n600519.SH,20251231,1234567890.01\r\n', {
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="balance.csv"', 'X-Row-Count': '1' },
  })
  const result = await readTushareResult(response, { id: 'balancesheet', label: '资产负债表' })
  expect(result.columns.map(column => column.label)).toEqual(['证券代码', '报告期末', '资产总计'])
  expect(await result.file.text()).toBe('证券代码,报告期末,资产总计\r\n600519.SH,20251231,1234567890.01\r\n')
})

it('switches to the monthly filters and reports a denied request without starting a download', async () => {
  const fetcher = vi.fn(async (path: string) => path === catalogPath ? Response.json(catalog) : Response.json({
    code: 'tushare_denied', message: '当前 Tushare 连接没有此数据的接口权限。',
  }, { status: 403 }))
  vi.stubGlobal('fetch', fetcher)
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click')
  render(<TushareDownloadPage onSettings={vi.fn()} />)
  const user = userEvent.setup()
  await user.selectOptions(await screen.findByLabelText('数据类型'), 'broker_recommend')
  expect(screen.queryByLabelText('开始交易日期')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('月份'), { target: { value: '2026-10' } })
  await user.click(screen.getByRole('button', { name: '查询数据' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('没有此数据的接口权限')
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/v1/tushare-download/broker_recommend?month=2026-10')
  expect(download).not.toHaveBeenCalled()
})

it('submits GDP quarter ranges and shows the category filter for industry data', async () => {
  const gdp = { ...month, id: 'cn_gdp', category: '宏观经济', label: '国内生产总值（GDP）', mode: 'quarters' }
  const classify = {
    ...month, id: 'index_classify', category: '行业与板块', label: '申万行业分类', mode: 'snapshot',
    choice: { label: '行业层级', options: [['L1', '一级'], ['L2', '二级']] },
  }
  const fetcher = vi.fn(async (path: string) => path === catalogPath
    ? Response.json({ ...catalog, datasets: [daily, gdp, classify] })
    : Response.json({ code: 'tushare_empty', message: '所选条件暂无数据。' }, { status: 404 }))
  vi.stubGlobal('fetch', fetcher)
  render(<TushareDownloadPage onSettings={vi.fn()} />)
  const user = userEvent.setup()
  const picker = await screen.findByLabelText('数据类型')
  await user.selectOptions(picker, 'cn_gdp')
  await user.selectOptions(screen.getByLabelText('开始季度'), '2024Q1')
  await user.selectOptions(screen.getByLabelText('结束季度'), '2024Q4')
  await user.click(screen.getByRole('button', { name: '查询数据' }))
  expect(await screen.findByRole('status')).toHaveTextContent('暂无数据')
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/v1/tushare-download/cn_gdp?start_quarter=2024Q1&end_quarter=2024Q4')
  await user.selectOptions(picker, 'index_classify')
  expect(screen.queryByLabelText('开始季度')).not.toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('行业层级'), 'L2')
  await user.click(screen.getByRole('button', { name: '查询数据' }))
  expect(await screen.findByRole('status')).toHaveTextContent('暂无数据')
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/v1/tushare-download/index_classify?option=L2')
})
