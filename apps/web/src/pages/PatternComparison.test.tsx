import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import PatternComparison, { type PatternMatch } from './PatternComparison'

vi.mock('../components/MarketIndicatorChart', () => ({ ResponsiveMarketIndicatorChart: () => <div>原始行情图</div> }))
vi.mock('../components/StockSearch', () => ({ StockName: ({ code }: { code: string }) => <span>{code}</span> }))
const sample: PatternMatch = { stock_code: '600000.SH', similarity: 72, start_date: '2026-01-01', end_date: '2026-01-02', bars: [{ trade_date: '2026-01-01', open: 1, high: 2, low: 1, close: 2 }], template_points: [0, 1], candidate_points: [0.1, 0.9], distance_components: { path: 0.01, velocity: 0.02, body: 0.03 }, algorithm_version: 'candle-window-v2', normalization: 'first_price_relative_v2', match_age_bars: 4, end_lag_days: 6 }
const props = { target: <div>目标</div>, matchAction: <button>匹配</button>, loading: false, error: '', selectedKey: '', onSelect: vi.fn(), onRetry: vi.fn() }
it('shows backend evidence, coverage, weak-match reference and a keyboard-operated normalized overlay', async () => {
  const user = userEvent.setup()
  render(<PatternComparison {...props} result={{ ...sample, items: [sample], scanned_securities: 12, valid_securities: 8 }} minSimilarity={80} />)
  expect(screen.getByText('有效覆盖 8 / 已扫描 12 只证券')).not.toBeVisible()
  await user.click(screen.getByText('匹配范围与口径'))
  expect(screen.getByText('有效覆盖 8 / 已扫描 12 只证券')).toBeVisible()
  expect(screen.getByText(/低于选股参考阈值 80/)).toBeInTheDocument()
  expect(screen.getByText('相似度不是上涨概率。')).toBeVisible()
  const toggle = screen.getByRole('button', { name: '归一化叠加' })
  toggle.focus()
  await user.keyboard('{Enter}')
  expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('img', { name: '模板与候选归一化走势叠加' }).querySelectorAll('polyline')).toHaveLength(2)
  await user.click(screen.getByText('为什么相似 · 算法与误差'))
  expect(screen.getByText('算法版本：candle-window-v2')).toBeVisible()
  expect(screen.getByText('0.030000')).toBeVisible()
  expect(screen.getByText(/不是百分比、胜率或收益预测/)).toBeVisible()
  expect(within(screen.getByRole('region', { name: '候选K线对照' })).getByText(/距截止窗口 4 根/)).toBeInTheDocument()
})
it('does not invent explanations or threshold for an old response', () => {
  render(<PatternComparison {...props} result={{ bars: sample.bars, similarity: 50 }} />)
  expect(screen.getByRole('button', { name: '归一化叠加' })).toBeDisabled()
  expect(screen.queryByText('为什么相似 · 算法与误差')).not.toBeInTheDocument()
  expect(screen.queryByText(/低于选股参考阈值/)).not.toBeInTheDocument()
  expect(screen.getByText('原始行情图')).toBeInTheDocument()
})
it('rejects invalid overlay points and exposes template timing warnings on demand', async () => {
  const user = userEvent.setup()
  render(<PatternComparison {...props} result={{ ...sample, candidate_points: [NaN, 1], template_timing: 'post_hoc', timing_warning: '模板来源晚于截止日：事后构造' }} />)
  expect(screen.getByRole('button', { name: '归一化叠加' })).toBeDisabled()
  expect(screen.getByText('匹配范围与口径 · 事后构造')).toBeVisible()
  expect(screen.getByText('模板来源晚于截止日：事后构造')).not.toBeVisible()
  await user.click(screen.getByText('匹配范围与口径 · 事后构造'))
  expect(screen.getByText('模板来源晚于截止日：事后构造')).toBeVisible()
})
it('falls back to raw candles when a newly selected sample has no normalized evidence', async () => {
  const user = userEvent.setup()
  const { rerender } = render(<PatternComparison {...props} result={sample} />)
  await user.click(screen.getByRole('button', { name: '归一化叠加' }))
  rerender(<PatternComparison {...props} result={{ bars: sample.bars, stock_code: '000001.SZ' }} />)
  expect(screen.getByRole('button', { name: '原始 K 线' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('img', { name: '模板与候选归一化走势叠加' })).not.toBeInTheDocument()
  expect(screen.getByText('原始行情图')).toBeInTheDocument()
})
