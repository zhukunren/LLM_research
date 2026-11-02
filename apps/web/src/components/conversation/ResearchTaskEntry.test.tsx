import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { SecuritiesProvider } from '../StockSearch'
import ResearchTaskEntry from './ResearchTaskEntry'

it('resolves a company by code and prepares editable research without submitting a task', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [{ stock_code: '600519.SH', name: '贵州茅台', market: 'SH' }] }), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup(), onPrompt = vi.fn(), onScreening = vi.fn(), onReports = vi.fn()
  render(<SecuritiesProvider><ResearchTaskEntry disabled={false} onPrompt={onPrompt} onScreening={onScreening} onReports={onReports} /></SecuritiesProvider>)
  await user.click(screen.getByRole('button', { name: /看懂一只股票/ }))
  const search = screen.getByRole('combobox', { name: '搜索研究公司名称或代码' })
  await user.type(search, '600519')
  await user.click(await screen.findByRole('option', { name: /贵州茅台/ }))
  expect(onPrompt).toHaveBeenLastCalledWith(expect.stringContaining('贵州茅台（600519.SH）'))
  expect(onPrompt).toHaveBeenLastCalledWith(expect.stringContaining('经营变化'))
  await user.click(screen.getByRole('button', { name: '主要风险' }))
  expect(onPrompt).toHaveBeenLastCalledWith(expect.stringContaining('反方证据'))
  await user.click(screen.getByRole('button', { name: /按条件找股票/ }))
  await user.click(screen.getByRole('button', { name: /读懂一份研报/ }))
  expect(onScreening).toHaveBeenCalledOnce()
  expect(onReports).toHaveBeenCalledOnce()
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
})
