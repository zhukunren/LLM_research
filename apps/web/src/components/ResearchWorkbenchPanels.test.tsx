import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import type { ResearchProject } from '../research'
import type { MatrixDefinition, MatrixRun, ProjectQuality, TrackingCheck } from '../researchWorkbench'
import ResearchMatrixPanel from './ResearchMatrixPanel'
import ResearchChangesPanel from './ResearchChangesPanel'
import ResearchQualityPanel from './ResearchQualityPanel'

vi.mock('../api', async original => ({ ...await original<typeof import('../api')>(), api: vi.fn() }))

const project = { id: 'p1', name: '同业研究', status: 'active', companies: [{ stock_code: '600519.SH', name: '甲公司' }, { stock_code: '000858.SZ', name: '乙公司' }] } as ResearchProject
const matrix: MatrixDefinition = { id: 'matrix', project_id: 'p1', name: '订单对比', stock_codes: ['600519.SH', '000858.SZ'], questions: [{ id: 'orders', label: '订单证据', prompt: '订单是什么？' }] }
const ref = { source_type: 'news' as const, source_id: 'news', title: '合成资料', available_at: '2026-09-10', publication_at: null, page_count: 1, page_number: 1, char_start: 0, char_end: 9, quote: '原文订单证据。', quote_start: 0, quote_end: 7, source_sha256: 'hash', source_version: 1, original_characters: 9, next_offset: null, as_of: '2026-09-10', stance: 'supports' as const }
const initialRun: MatrixRun = { id: 'run', matrix_id: 'matrix', job_id: null, as_of: '2026-09-10', mode: 'manual', status: 'succeeded', created_at: '2026-09-11T10:00:00Z', cells: [
  { stock_code: '600519.SH', question_id: 'orders', answer: '已保存订单判断', status: 'evidence_found', review_revision: 0, evidence: [ref] },
  { stock_code: '000858.SZ', question_id: 'orders', answer: '', status: 'pending', review_revision: 0, evidence: [] },
], note: '原文定位不等于语义已验证。', previous_run_id: null, changes: [], summary: { total: 2, located: 1, reviewed: 0 }, coverage: {} }

it('reads frozen comparison evidence, saves a versioned correction and offers Excel export', async () => {
  const user = userEvent.setup()
  let run = structuredClone(initialRun)
  const writes: { path: string; body: Record<string, unknown> }[] = []
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.endsWith('/review')) {
      const body = JSON.parse(String(options?.body)); writes.push({ path, body })
      run = { ...run, cells: [{ ...run.cells[0], answer: body.answer, review_revision: 1 }, run.cells[1]], summary: { ...run.summary, reviewed: 1 } }
      return run as never
    }
    if (path.includes('/evidence?')) return { ...ref, text: '原文订单证据。后文。', snapshot: true } as never
    if (path.includes('/sources?')) return { items: [], total: 0, next_offset: null } as never
    if (path.endsWith('/runs')) return { matrix, items: [run] } as never
    return { items: [matrix] } as never
  })
  render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} />)
  await screen.findByText('已保存订单判断')
  expect(screen.getByRole('link', { name: '导出 Excel' })).toHaveAttribute('href', '/api/v1/research-projects/p1/matrices/matrix/runs/run/export')
  await user.click(screen.getByRole('button', { name: '依据 1' }))
  await screen.findByText('原文订单证据。')
  await user.click(screen.getByRole('button', { name: '核对 600519.SH · 订单证据' }))
  await user.clear(screen.getByLabelText('单元格结论'))
  await user.type(screen.getByLabelText('单元格结论'), '人工复核后的判断')
  await user.click(screen.getByRole('button', { name: '保存单元格修订' }))
  await screen.findByText('人工复核后的判断')
  expect(writes).toHaveLength(1)
  expect(writes[0].body).toMatchObject({ stock_code: '600519.SH', question_id: 'orders', base_revision: 0, answer: '人工复核后的判断', status: 'evidence_found' })
})

it('creates a reusable template and reuses its request identity after an unknown creation result', async () => {
  const user = userEvent.setup()
  let definitions: MatrixDefinition[] = []
  const creations: Record<string, unknown>[] = []
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)); creations.push(body)
      if (creations.length === 1) throw new Error('网络中断，结果未确认')
      const saved = { ...matrix, name: body.name, questions: body.questions, stock_codes: body.stock_codes }
      definitions = [saved]
      return saved as never
    }
    if (path.endsWith('/runs')) return { matrix: definitions[0], items: [] } as never
    return { items: definitions } as never
  })
  render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: '新建对比矩阵' }))
  await user.clear(screen.getByLabelText('对比研究问题'))
  await user.type(screen.getByLabelText('对比研究问题'), '订单兑现\n反方证据')
  await user.click(screen.getByRole('button', { name: '保存对比模板' }))
  await screen.findByText('网络中断，结果未确认')
  await user.click(screen.getByRole('button', { name: '保存对比模板' }))
  await screen.findByRole('button', { name: '创建空白对比' })
  expect(creations[0].request_id).toBe(creations[1].request_id)
  expect(creations[1].questions).toEqual([{ id: 'q1', label: '订单兑现', prompt: '订单兑现' }, { id: 'q2', label: '反方证据', prompt: '反方证据' }])
})

it('preserves an unsaved cell correction across closing and reopening the editor', async () => {
  const user = userEvent.setup()
  vi.mocked(api).mockImplementation(async path => (path.includes('/sources?') ? { items: [], total: 0, next_offset: null } : path.endsWith('/runs') ? { matrix, items: [initialRun] } : { items: [matrix] }) as never)
  const view = render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '核对 600519.SH · 订单证据' }))
  await user.clear(screen.getByLabelText('单元格结论'))
  await user.type(screen.getByLabelText('单元格结论'), '保留未保存的修订')
  await user.click(screen.getByRole('button', { name: '关闭核对' }))
  await user.click(screen.getByRole('button', { name: '核对 600519.SH · 订单证据' }))
  expect(screen.getByLabelText('单元格结论')).toHaveValue('保留未保存的修订')
  view.unmount()
  render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '核对 600519.SH · 订单证据' }))
  expect(screen.getByLabelText('单元格结论')).toHaveValue('保留未保存的修订')
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('cancels a pending comparison through its own scoped endpoint', async () => {
  const user = userEvent.setup()
  let run = { ...initialRun, status: 'running', job_id: 'job' }
  const writes: string[] = []
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') { writes.push(path); run = { ...run, status: 'cancelled' } }
    return (path.endsWith('/matrices') ? { items: [matrix] } : { matrix, items: [run] }) as never
  })
  render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '停止本次生成' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '停止本次生成' })).not.toBeInTheDocument())
  expect(writes).toEqual(['/research-projects/p1/matrices/matrix/runs/run/cancel'])
})

it('discards a late frozen evidence response after switching comparisons', async () => {
  const user = userEvent.setup()
  let finish!: (value: unknown) => void
  const second = { ...matrix, id: 'second', name: '第二对比' }
  vi.mocked(api).mockImplementation(async path => {
    if (path.includes('/evidence?')) return new Promise(resolve => { finish = resolve }) as never
    if (path.includes('/second/runs')) return { matrix: second, items: [{ ...initialRun, id: 'second-run', matrix_id: 'second', cells: [] }] } as never
    if (path.endsWith('/runs')) return { matrix, items: [initialRun] } as never
    return { items: [matrix, second] } as never
  })
  render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '依据 1' }))
  await user.selectOptions(screen.getByLabelText('已保存对比模板'), 'second')
  await act(async () => { finish({ ...ref, text: '旧对比的迟到原文', snapshot: true }) })
  expect(screen.queryByText('旧对比的迟到原文')).not.toBeInTheDocument()
})

const baseline: TrackingCheck = { id: 'baseline', as_of: '2026-09-10', baseline: true, created_at: '2026-09-10T10:00:00Z', changes: [], unreviewed_count: 0, coverage: { reports: 1, news: 2, inventory_complete: true }, review_questions: [], note: '仅覆盖本地已接入资料。' }

it('establishes a material baseline only on request and preserves change review', async () => {
  const user = userEvent.setup()
  let history: TrackingCheck[] = []
  const writes: { path: string; body: unknown }[] = []
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') {
      writes.push({ path, body: JSON.parse(String(options.body)) })
      if (path.endsWith('/review')) history = [{ ...history[0], unreviewed_count: 0, changes: [{ ...history[0].changes[0], review: { comment: '需要继续核验交付', created_at: '2026-09-11' } }] }]
      else history = history.length ? [{ ...baseline, id: 'next', baseline: false, unreviewed_count: 1, changes: [{ key: 'news:new', title: '订单更新资料', category: 'material', type: 'added', available_at: '2026-09-10', review: null }] }] : [baseline]
      return history[0] as never
    }
    return { items: history } as never
  })
  render(<ResearchChangesPanel projectId="p1" code="600519.SH" asOf="2026-09-10" writable />)
  await screen.findByText(/首次检查会保存/)
  expect(writes).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: '建立跟踪基线' }))
  await screen.findByText(/已建立基线/)
  await user.click(screen.getByRole('button', { name: '检查资料变化' }))
  await screen.findByText('订单更新资料')
  await user.click(screen.getByRole('button', { name: '记录复核' }))
  await user.type(screen.getByLabelText('变化复核记录'), '需要继续核验交付')
  await user.click(screen.getByRole('button', { name: '保存复核记录' }))
  await screen.findByText('需要继续核验交付')
  expect(writes[2]).toMatchObject({ path: '/research-projects/p1/change-checks/next/review', body: { change_key: 'news:new', comment: '需要继续核验交付' } })
})

it('shows evidence quality dimensions and links to original work without declaring semantic correctness', async () => {
  const quality: ProjectQuality = { checked_at: '2026-09-11', metrics: { claims: 1, references: 2, valid_references: 1, stale_claims: 1, matrix_cells: 3, reviewed_cells: 1, needs_review_cells: 1 }, issue_count: 2, limits: { claims: 2000, matrix_runs: 200 },
    issues: [{ kind: 'claim', id: 'claim', note_id: 'note', title: '旧依据判断', code: 'note_revision_changed' }, { kind: 'matrix', id: 'matrix', title: '公司对比', code: 'cell_needs_review' }], note: '仅检查原文定位，结论语义仍需人工复核。' }
  vi.mocked(api).mockResolvedValue(quality as never)
  const openNote = vi.fn(), openMatrix = vi.fn()
  render(<ResearchQualityPanel projectId="p1" onOpenNote={openNote} onOpenMatrices={openMatrix} />)
  await screen.findByText('旧依据判断')
  expect(screen.getByText('仅检查原文定位，结论语义仍需人工复核。')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '查看研究笔记' }))
  fireEvent.click(screen.getByRole('button', { name: '查看同业对比' }))
  expect(openNote).toHaveBeenCalledWith('note')
  expect(openMatrix).toHaveBeenCalledOnce()
})

it('opens the exact matrix linked by a quality issue even outside the recent catalog', async () => {
  const older = { ...matrix, id: 'older', name: '更早的矩阵' }
  vi.mocked(api).mockImplementation(async path => {
    if (path.includes('/older/runs')) return { matrix: older, items: [{ ...initialRun, id: 'older-run', matrix_id: 'older', cells: [{ ...initialRun.cells[0], answer: '更早矩阵的结论' }] }] } as never
    if (path.endsWith('/matrices?include_matrix=older')) return { items: [matrix, older] } as never
    if (path.includes('/runs')) return { matrix, items: [initialRun] } as never
    return { items: [matrix] } as never
  })
  render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} initialMatrixId="older" initialRunId="older-run" />)
  await screen.findByText('更早矩阵的结论')
  expect(screen.getByLabelText('已保存对比模板')).toHaveValue('older')
})

it('keeps an in-flight run associated with its matrix when a user tries switching templates', async () => {
  const user = userEvent.setup()
  const second = { ...matrix, id: 'second', name: '另一矩阵' }
  let finish!: (value: unknown) => void
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') return new Promise(resolve => { finish = resolve }) as never
    if (path.endsWith('/matrices')) return { items: [matrix, second] } as never
    if (path.includes('/second/runs')) return { matrix: second, items: [] } as never
    return { matrix, items: [initialRun] } as never
  })
  render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} />)
  await screen.findByText('已保存订单判断')
  await user.click(screen.getByRole('button', { name: '根据本地资料生成' }))
  await user.selectOptions(screen.getByLabelText('已保存对比模板'), 'second')
  await act(async () => { finish(initialRun) })
  expect(screen.getByLabelText('已保存对比模板')).toHaveValue('matrix')
  expect(screen.getByLabelText('对比运行版本')).toHaveValue('run')
})

it('does not submit an invisible removed company from the new-matrix form', async () => {
  const user = userEvent.setup()
  const writes: Record<string, unknown>[] = []
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') { const body = JSON.parse(String(options.body)); writes.push(body); return { ...matrix, ...body } as never }
    return (path.includes('/runs') ? { matrix, items: [] } : { items: [] }) as never
  })
  const view = render(<ResearchMatrixPanel project={project} asOf="2026-09-10" onDateChange={vi.fn()} />)
  view.rerender(<ResearchMatrixPanel project={{ ...project, companies: project.companies.slice(0, 1) }} asOf="2026-09-10" onDateChange={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: '新建对比矩阵' }))
  await user.click(screen.getByRole('button', { name: '保存对比模板' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0].stock_codes).toEqual(['600519.SH'])
})

it('closes a review of an older material change before creating another check', async () => {
  const user = userEvent.setup()
  const previous: TrackingCheck = { ...baseline, id: 'previous', baseline: false, unreviewed_count: 1, changes: [{ key: 'news:root', title: '原版本变化', category: 'material', type: 'updated', available_at: '2026-09-10', review: null }] }
  const next: TrackingCheck = { ...previous, id: 'next-check', changes: [{ ...previous.changes[0], title: '新版本变化' }] }
  let history = [previous]
  vi.mocked(api).mockImplementation(async (_path, options) => {
    if (options?.method === 'POST') { history = [next, previous]; return next as never }
    return { items: history } as never
  })
  render(<ResearchChangesPanel projectId="p1" code="600519.SH" asOf="2026-09-10" writable />)
  await user.click(await screen.findByRole('button', { name: '记录复核' }))
  await user.type(screen.getByLabelText('变化复核记录'), '只针对原版本的复核')
  await user.click(screen.getByRole('button', { name: '检查资料变化' }))
  await screen.findByText('新版本变化')
  expect(screen.queryByLabelText('变化复核记录')).not.toBeInTheDocument()
})

it('reads the news version recorded by a historical check instead of the current company catalog', async () => {
  const user = userEvent.setup()
  const history: TrackingCheck = { ...baseline, id: 'historical', baseline: false, changes: [{ key: 'news:root', title: '旧资讯版本', source_type: 'news', source_id: 'old-news', category: 'material', type: 'added', available_at: '2026-09-10', review: null }] }
  vi.mocked(api).mockImplementation(async path => {
    if (path.includes('/change-checks/historical/sources/news%3Aroot?')) return { ...ref, source_id: 'old-news', text: '旧资讯原始正文', source_version: 1 } as never
    if (path.includes('/source?')) throw new Error('旧资讯已不是当前版本')
    return { items: [history] } as never
  })
  render(<ResearchChangesPanel projectId="p1" code="600519.SH" asOf="2026-09-10" writable />)
  await user.click(await screen.findByRole('button', { name: '阅读变化原文' }))
  await screen.findByText('旧资讯原始正文')
})
