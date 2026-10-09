import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import { SecuritiesProvider } from './StockSearch'
import { StockInteractionsProvider, StockText } from './StockMentions'
import ResearchAnswer from './conversation/ResearchAnswer'
vi.mock('../api', () => ({ api: vi.fn() }))
vi.mock('./StockChartDialog', () => ({ default: ({ code, onClose, onAddToWatchlist, watched }: { code: string; onClose: () => void; onAddToWatchlist?: () => void; watched?: boolean }) => <section role="dialog" aria-label="股票行情"><p>{code}行情</p><button onClick={onClose}>关闭走势</button><button onClick={onAddToWatchlist} disabled={watched}>加入观察池</button></section> }))
const stocks = [{ stock_code: '600519.SH', name: '贵州茅台', market: 'SH' }, { stock_code: '000001.SZ', name: '平安银行', market: 'SZ' }]
function setup(body: React.ReactNode) {
  vi.mocked(api).mockImplementation(async path => path === '/security-catalog' ? { items: stocks } : { status: 'watching' })
  return render(<SecuritiesProvider><StockInteractionsProvider>{body}</StockInteractionsProvider></SecuritiesProvider>)
}
it('links prose, titles and tables without rewriting code or citation destinations', async () => {
  const user = userEvent.setup()
  setup(<ResearchAnswer conversationId="research" content={'# 贵州茅台\n\n平安银行（000001.SZ）\n\n| 股票 | 公司 |\n| --- | --- |\n| 600519.SH | 贵州茅台 |\n\n`600519.SH`\n\n```python\nload("600519.SH")\n```\n\n[贵州茅台原文](https://example.com/report)'} />)
  await screen.findByRole('link', { name: '查看平安银行行情' })
  expect(screen.getAllByRole('link', { name: '查看贵州茅台行情' })).toHaveLength(2)
  expect(screen.getByText('load("600519.SH")', { selector: 'code' }).querySelector('a')).toBeNull()
  expect(screen.getAllByRole('link', { name: '查看600519.SH行情' })).toHaveLength(2)
  const citation = screen.getByRole('link', { name: '贵州茅台原文' })
  expect(citation).toHaveAttribute('href', 'https://example.com/report')
  await user.click(citation.querySelector('.stock-mention')!)
  expect(await screen.findByRole('dialog', { name: '股票行情' })).toHaveTextContent('600519.SH')
})
it('does not write on hover and reuses the exact request after a lost response', async () => {
  const user = userEvent.setup()
  setup(<StockText><p>贵州茅台</p></StockText>)
  await user.hover(await screen.findByRole('link', { name: '查看贵州茅台行情' }))
  const menu = await screen.findByRole('dialog', { name: '贵州茅台股票操作' })
  expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  let attempts = 0
  vi.mocked(api).mockImplementation(async () => { if (attempts++ === 0) throw new Error('网络中断'); return { status: 'watching' } })
  await user.click(within(menu).getByRole('button', { name: '加入观察池' }))
  await screen.findByRole('alert')
  await user.click(within(menu).getByRole('button', { name: '加入观察池' }))
  await waitFor(() => expect(within(menu).getByRole('button', { name: '已加入观察池' })).toBeDisabled())
  const bodies = vi.mocked(api).mock.calls.filter(([path]) => path === '/observation/quick-add').map(([, init]) => JSON.parse(String(init?.body)))
  expect(bodies).toHaveLength(2); expect(bodies[0]).toEqual(bodies[1]); expect(bodies[0].stock_code).toBe('600519.SH')
})
it('avoids nested interactive controls and provides a watch action in the quote for touch users', async () => {
  const user = userEvent.setup(), parent = vi.fn()
  setup(<StockText><button onClick={parent}>选择贵州茅台</button><input value="600519.SH" readOnly aria-label="股票输入" /><select aria-label="公司"><option>贵州茅台</option></select><p>600519.SH</p></StockText>)
  await screen.findByRole('link', { name: '查看600519.SH行情' })
  const button = screen.getByRole('button', { name: '选择贵州茅台' })
  expect(button.querySelector('a,button')).toBeNull()
  await user.click(button.querySelector('.stock-mention')!)
  expect(parent).not.toHaveBeenCalled()
  const quote = await screen.findByRole('dialog', { name: '股票行情' })
  await user.click(within(quote).getByRole('button', { name: '加入观察池' }))
  await screen.findByRole('status')
  await user.click(within(quote).getByRole('button', { name: '关闭走势' }))
  await user.click(button); expect(parent).toHaveBeenCalledOnce()
})
it('closes keyboard stock actions with Escape without reopening when focus returns', async () => {
  const user = userEvent.setup()
  setup(<StockText><p>贵州茅台</p></StockText>)
  const link = await screen.findByRole('link', { name: '查看贵州茅台行情' })
  link.focus()
  await user.keyboard('{ArrowDown}')
  const menu = await screen.findByRole('dialog', { name: '贵州茅台股票操作' })
  await waitFor(() => expect(within(menu).getByRole('button', { name: '查看贵州茅台行情' })).toHaveFocus())
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '贵州茅台股票操作' })).not.toBeInTheDocument()
  expect(link).toHaveFocus()
})
