import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import type { ResearchProject } from '../research'
import ResearchMatrixPanel from './ResearchMatrixPanel'

vi.mock('../api', async original => ({ ...await original<typeof import('../api')>(), api: vi.fn() }))
const project = { id: 'p1', status: 'active', companies: [{ stock_code: '600519.SH', name: '甲公司' }, { stock_code: '000858.SZ', name: '乙公司' }] } as ResearchProject
const questions = [{ id: 'orders', label: '订单证据', prompt: '订单？' }, { id: 'risks', label: '风险证据', prompt: '风险？' }]
const matrix = { id: 'matrix', name: '同业对比', stock_codes: project.companies.map(item => item.stock_code), questions }
const run = { id: 'run', as_of: '2026-09-10', status: 'succeeded', mode: 'manual', created_at: '2026-09-10', cells: project.companies.flatMap(company => questions.map(question => ({ stock_code: company.stock_code, question_id: question.id, answer: company.name + question.label, status: 'pending', review_revision: 0, evidence: [] }))), summary: { total: 4, located: 0, reviewed: 0 }, coverage: {}, changes: [] }

it('selects a single question for narrow reading without duplicating cells or losing review actions', async () => {
  vi.mocked(api).mockImplementation(async path => (path.includes('/runs') ? { items: [run] } : { items: [matrix] }) as never)
  const user = userEvent.setup()
  const view = render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} />)
  const picker = await screen.findByRole('combobox', { name: '按问题阅读' })
  expect(view.container.querySelectorAll('td[data-active-question="true"]')).toHaveLength(2)
  await user.selectOptions(picker, 'risks')
  const cells = [...view.container.querySelectorAll<HTMLTableCellElement>('td[data-active-question="true"]')]
  expect(cells).toHaveLength(2)
  expect(cells.map(cell => cell.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('甲公司风险证据'), expect.stringContaining('乙公司风险证据')]))
  expect(screen.getAllByText('甲公司风险证据')).toHaveLength(1)
  await user.click(within(cells[0]).getByRole('button', { name: '核对 600519.SH · 风险证据' }))
  expect(screen.getByLabelText('单元格结论')).toHaveValue('甲公司风险证据')
})


it('does not show a late evidence response from the previous reading question', async () => {
  let resolveEvidence!: (value: unknown) => void
  const pending = new Promise(resolve => { resolveEvidence = resolve })
  const withEvidence = { ...run, cells: [{ ...run.cells[0], evidence: [{ source_type: 'news', source_id: 'old' }] }, ...run.cells.slice(1)] }
  vi.mocked(api).mockImplementation(async path => (path.includes('/evidence?') ? pending : path.includes('/runs') ? { items: [withEvidence] } : { items: [matrix] }) as never)
  const user = userEvent.setup()
  render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '依据 1' }))
  await user.selectOptions(screen.getByRole('combobox', { name: '按问题阅读' }), 'risks')
  await act(async () => resolveEvidence({ source_type: 'news', source_id: 'old', text: '不应出现的旧问题依据', snapshot: true }))
  expect(screen.queryByText('不应出现的旧问题依据')).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: '按问题阅读' })).toHaveValue('risks')
})
