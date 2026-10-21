import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import FinancialOriginalEvidence from './FinancialOriginalEvidence'
vi.mock('../api', () => ({ api: vi.fn() }))
const props = { factId: 'fact', record: { report_period: '2025-12-31', scope: 'consolidated' },
  calculation: { calculation_id: 'a'.repeat(64), request: { stock_code: '600519.SH', as_of: '2026-04-03', start_year: 2025, basis: 'annual', mode: 'as_of', metrics: ['revenue'] } },
  metric: 'revenue', period: '2025-12-31', writable: true }
let saved: Record<string, unknown>[]
beforeEach(() => {
  vi.clearAllMocks(); saved = []
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.startsWith('/disclosures?')) return { items: [{ id: 'v1', pages: 3, metadata: { title: '原始报告', revision: 2 } }] } as never
    if (path.startsWith('/disclosures/versions/')) return { text: 'Revenue 100.00 CNY', char_start: 0, next_offset: null } as never
    if (path.startsWith('/financial-facts/')) {
      if (options?.method === 'POST') {
        const request = JSON.parse(String(options.body)); saved.push(request)
        return { id: 'link', status: request.manually_confirmed ? 'conflict' : 'document_related' } as never
      }
      return { items: [] } as never
    }
    if (path === '/research-evidence/financial') return { id: 'e'.repeat(64), title: '独立数字', citation_url: '/api/v1/research-evidence/' + 'e'.repeat(64) + '/view' } as never
    throw new Error(path)
  })
})
async function choose() {
  await userEvent.click(screen.getByText('关联或核对本输入的原文'))
  await screen.findByRole('option', { name: '原始报告' })
  await userEvent.selectOptions(screen.getByLabelText('对应报告期原文'), 'v1')
  await screen.findByText('Revenue 100.00 CNY')
}
it('stores a page association without asserting that the value was verified', async () => {
  render(<FinancialOriginalEvidence {...props} />)
  await choose()
  await userEvent.click(screen.getByRole('button', { name: '保存文档关联' }))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]).toMatchObject({ manually_confirmed: false, reported_value: null, metadata_revision: 2, page_number: 1, as_of: '2026-04-03' })
})
it('preserves decimal precision and unit choice and exposes a conflicting verification without overwriting the input', async () => {
  render(<FinancialOriginalEvidence {...props} />)
  await choose()
  await userEvent.type(screen.getByLabelText('数值核对原文'), 'Revenue 100.00 CNY')
  await userEvent.click(screen.getByLabelText('已核对期间列单位币种与合并范围'))
  await userEvent.type(screen.getByLabelText('原文单元格数值'), '100.00')
  await userEvent.selectOptions(screen.getByLabelText('原文单位'), '万元')
  await userEvent.type(screen.getByLabelText('期间列与口径说明'), '2025 本期合并')
  await userEvent.click(screen.getByRole('button', { name: '保存数值核对' }))
  expect(await screen.findByRole('status')).toHaveTextContent('数值冲突')
  expect(saved[0]).toMatchObject({ reported_value: '100.00', reported_unit: '万元', scope: 'consolidated', manually_confirmed: true })
  fireEvent.change(screen.getByLabelText('核对物理页'), { target: { value: '2' } })
  expect(screen.getByLabelText('已核对期间列单位币种与合并范围')).not.toBeChecked()
})
it('freezes the exact displayed calculation and exposes a standalone citation identifier', async () => {
  render(<FinancialOriginalEvidence {...props} />)
  await userEvent.click(screen.getByRole('button', { name: '保存独立数字依据' }))
  expect(await screen.findByLabelText('数字依据标识')).toHaveValue('e'.repeat(64))
  const call = vi.mocked(api).mock.calls.find(([path]) => path === '/research-evidence/financial')!
  expect(JSON.parse(String(call[1]?.body))).toEqual({ query: props.calculation.request, expected_id: 'a'.repeat(64), metric: 'revenue', period: '2025-12-31' })
})
it('read-only views hide every mutation and an unknown provider scope cannot be manually verified', async () => {
  const view = render(<FinancialOriginalEvidence {...props} writable={false} />)
  await screen.findByText('此输入事实尚无已保存的原文关联。')
  expect(screen.queryByRole('button', { name: '保存独立数字依据' })).not.toBeInTheDocument()
  view.rerender(<FinancialOriginalEvidence {...props} record={{ ...props.record, scope: 'provider_defined' }} />)
  await choose()
  expect(screen.getByLabelText('已核对期间列单位币种与合并范围')).toBeDisabled()
})
