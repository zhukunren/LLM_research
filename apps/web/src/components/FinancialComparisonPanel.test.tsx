import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import FinancialComparisonPanel from './FinancialComparisonPanel'
vi.mock('../api', () => ({ api: vi.fn() }))
const companies = [{ stock_code: '600519.SH', name: '甲' }, { stock_code: '000333.SZ', name: '乙' }, { stock_code: '300750.SZ', name: '丙' }]
function result(saved = false) {
  return { id: (saved ? 'b' : 'a').repeat(64), saved, request: { as_of: saved ? '2025-04-03' : '2026-04-03', basis: 'annual', mode: 'as_of' }, companies,
    metrics: [{ code: 'revenue', label: '营业收入', unit: '元' }], note: '缺口不补零',
    calculations: companies.map((company, index) => ({ request: { stock_code: company.stock_code }, calculation_id: String(index + (saved ? 4 : 1)).repeat(64),
      rows: [{ period: '2025-12-31', values: { revenue: { value: index === 2 ? null : String((saved ? 900 : 100) * 1e6), unit: '元', reason: index === 2 ? '缺少当时证据' : '可用' } } }] })) }
}
let canSave = true
beforeEach(() => {
  vi.clearAllMocks(); canSave = true
  vi.mocked(api).mockImplementation(async path => {
    if (path === '/financial-data/metrics') return { items: result().metrics, can_save: canSave } as never
    if (path.startsWith('/financial-data/compare?')) return result() as never
    if (path === '/financial-data/comparisons?project_id=project') return { items: [{ id: 'b'.repeat(64), request: result(true).request, created_at: '2025-04-03' }] } as never
    if (path === '/financial-data/comparisons/' + 'b'.repeat(64)) return result(true) as never
    if (path.startsWith('/financial-data/comparisons?expected_id=')) return { ...result(), saved: true } as never
    if (path.startsWith('/financial-data/calculations/')) return { id: 'e'.repeat(64), citation_url: '/proof/view' } as never
    throw new Error(path)
  })
})
it('aligns units, retains missing reasons and freezes the preview before making an independent numeric citation', async () => {
  render(<FinancialComparisonPanel projectId="project" companies={companies} asOf="2026-04-03" />)
  await screen.findByText('缺少当时证据')
  expect(screen.getAllByText('1')).toHaveLength(2)
  expect(screen.getByText('—')).toBeInTheDocument()
  await userEvent.click(screen.getAllByRole('button', { name: '数字依据' })[0])
  expect(await screen.findByRole('link', { name: '打开独立数字依据' })).toHaveAttribute('href', '/proof/view')
  const writes = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(writes[0][0]).toContain('expected_id=' + 'a'.repeat(64))
  expect(writes[1][0]).toBe('/financial-data/calculations/' + '1'.repeat(64) + '/evidence')
})
it('opens a saved historical comparison and cites its saved calculations without substituting the current preview', async () => {
  render(<FinancialComparisonPanel projectId="project" companies={companies} asOf="2026-04-03" />)
  await screen.findByRole('option', { name: /2025-04-03/ })
  await userEvent.selectOptions(screen.getByLabelText('保存的财务比较'), 'b'.repeat(64))
  await screen.findByText(/数据截至 2025-04-03/)
  expect(screen.getAllByText('9')).toHaveLength(2)
  await userEvent.click(screen.getAllByRole('button', { name: '数字依据' })[0])
  await screen.findByRole('link', { name: '打开独立数字依据' })
  const writes = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(writes).toHaveLength(1)
  expect(writes[0][0]).toBe('/financial-data/calculations/' + '4'.repeat(64) + '/evidence')
})
it('does not expose saving to read-only users and stops the preview when fewer than three companies are selected', async () => {
  canSave = false
  render(<FinancialComparisonPanel projectId="project" companies={companies} asOf="2026-04-03" />)
  await screen.findByText('缺少当时证据')
  expect(screen.queryByRole('button', { name: '保存本次比较' })).not.toBeInTheDocument()
  const picker = screen.getByRole('group', { name: '财务对比公司' })
  await userEvent.click(within(picker).getByRole('checkbox', { name: '甲' }))
  await screen.findByText('请选择 3 至 5 家公司。')
  expect(screen.queryByText('缺少当时证据')).not.toBeInTheDocument()
})
