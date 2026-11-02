import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import type { ResearchFile, ResearchNote, ResearchProject } from '../research'
import ResearchProjectsPage from './ResearchProjectsPage'

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: vi.fn() }))
vi.mock('../components/PdfReader', () => ({ default: () => null }))
vi.mock('../components/StockSearch', async importOriginal => ({ ...await importOriginal<typeof import('../components/StockSearch')>(), default: () => null, StockName: ({ code }: { code: string }) => <span>{code}</span> }))
vi.mock('../components/CompanyResearchPanel', () => ({ default: ({ onOpenNote }: { onOpenNote: (id: string) => void }) => <button onClick={() => onOpenNote('n-a')}>打开公司笔记</button> }))
vi.mock('../components/FinancialComparisonPanel', () => ({ default: () => <p>财务比较</p> }))
vi.mock('../components/ResearchMatrixPanel', () => ({ default: ({ initialMatrixId, initialRunId }: { initialMatrixId?: string; initialRunId?: string }) => <p>研究矩阵 {initialMatrixId} {initialRunId}</p> }))

function fixture() {
  const note: ResearchNote = { id: 'n-a', project_id: 'p1', title: '茅台判断', body: '待核实', stock_code: '600519.SH', validation_plan: '', invalidation_condition: '', status: 'watching', revision: 1, source_conversation_id: 'c-a', source_message_id: null, updated_at: '2026-10-26T08:00:00Z' }
  const conversation = { entry_scope: 'screening' as const, state: 'active' as const, research_mode: 'research', last_turn_state: null, updated_at: note.updated_at }
  const project: ResearchProject = { id: 'p1', name: '消费研究', objective: '核对现金流', status: 'active', revision: 1, updated_at: note.updated_at,
    companies: [{ stock_code: '600519.SH', name: '贵州茅台' }, { stock_code: '000858.SZ', name: '五粮液' }],
    notes: [note, { ...note, id: 'n-claim', title: '多公司判断', stock_code: null, claim_stock_codes: ['600519.SH'], source_conversation_id: 'c-claim' }, { ...note, id: 'n-b', title: '五粮液判断', stock_code: '000858.SZ', source_conversation_id: 'c-b' }, { ...note, id: 'n-none', title: '项目笔记', stock_code: null, source_conversation_id: null }],
    conversations: [{ ...conversation, id: 'c-a', title: '茅台研究', stock_codes: ['600519.SH'] }, { ...conversation, id: 'c-claim', title: '判断来源' }, { ...conversation, id: 'c-b', title: '五粮液研究', stock_codes: ['000858.SZ'] }, { ...conversation, id: 'c-none', title: '茅台未关联历史对话', stock_codes: [] }],
  }
  const file = { bytes: 100, modified_at: 1791014400 }
  const files: ResearchFile[] = [
    { ...file, name: '茅台报告.pdf', conversation_id: 'c-a', stock_codes: ['600519.SH'], url: '/a.pdf' },
    { ...file, name: '旧来源.csv', conversation_id: 'c-claim', url: '/claim.csv' },
    { ...file, name: '五粮液报告.pdf', conversation_id: 'c-b', stock_codes: ['000858.SZ'], url: '/b.pdf' },
    { ...file, name: '茅台项目文件.pdf', conversation_id: '', stock_codes: [], url: '/none.pdf' },
    { ...file, name: '项目笔记.pdf', conversation_id: 'c-a', source_kind: 'note', source_id: 'n-none', url: '/note.pdf' },
  ]
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/research-projects') return { items: [{ ...project, company_count: 2, note_count: 4, conversation_count: 4 }] } as never
    if (path.endsWith('/files')) return { items: files } as never
    if (path === '/research-projects/p1') return project as never
    if (path.endsWith('/quality')) return { checked_at: note.updated_at, limits: { claims: 2000, matrix_runs: 200 }, metrics: { claims: 1, references: 0, valid_references: 0, stale_claims: 1, matrix_cells: 1, reviewed_cells: 0 }, note: '核验结果', issue_count: 2, issues: [{ id: 'claim-a', code: 'note_revision_changed', title: '茅台待复核', note_id: 'n-a' }, { id: 'matrix-old', run_id: 'run-old', code: 'cell_needs_review', title: '对比待复核' }] } as never
    if (path === '/conversations') return { id: 'new-c', entry_scope: 'screening' } as never
    if (path.endsWith('/research-scope') && init?.method === 'PATCH') return {} as never
    return { items: [] } as never
  })
  return { project, files }
}

it('shares an explicit company range and counts across notes, conversations and files while preserving the active tab', async () => {
  fixture()
  const user = userEvent.setup(), open = vi.fn()
  render(<ResearchProjectsPage initialProjectId="p1" onOpenConversation={open} />)
  await screen.findByRole('heading', { name: '消费研究' })
  expect(screen.getAllByRole('tab')).toHaveLength(3)
  await user.click(screen.getByRole('tab', { name: /研究对话/ }))
  await user.selectOptions(screen.getByLabelText('研究范围'), '600519.SH')
  expect(screen.getByRole('tab', { name: /研究对话 2/ })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: /研究笔记 2/ })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: /研究成果 2/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /五粮液研究|茅台未关联历史对话/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /判断来源/ }))
  expect(open).toHaveBeenCalledWith('c-claim', 'screening')
  await user.click(screen.getByRole('tab', { name: /研究成果/ }))
  expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/a.pdf', '/claim.csv'])
  await user.selectOptions(screen.getByLabelText('研究范围'), '')
  expect(screen.getByRole('tab', { name: /研究成果 5/ })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getAllByRole('link')).toHaveLength(5)
  await user.selectOptions(screen.getByLabelText('研究范围'), '600519.SH')
  await user.click(screen.getByRole('tab', { name: /研究笔记/ }))
  await user.type(screen.getByLabelText('搜索研究笔记'), '找不到')
  await user.click(screen.getByRole('button', { name: '查看全部笔记' }))
  expect(screen.getByLabelText('研究范围')).toHaveValue('600519.SH')
  expect(screen.getByRole('button', { name: '多公司判断' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '项目笔记' })).not.toBeInTheDocument()
})

it('starts research and separate note drafts with the selected company, retaining previous drafts on range changes', async () => {
  fixture()
  const user = userEvent.setup(), open = vi.fn()
  render(<ResearchProjectsPage initialProjectId="p1" onOpenConversation={open} />)
  await screen.findByRole('heading', { name: '消费研究' })
  await user.selectOptions(screen.getByLabelText('研究范围'), '600519.SH')
  await user.click(screen.getByRole('button', { name: '写研究笔记' }))
  expect(screen.getByLabelText('笔记关联公司')).toHaveValue('600519.SH')
  await user.type(screen.getByLabelText('笔记标题'), '茅台草稿')
  await user.selectOptions(screen.getByLabelText('研究范围'), '000858.SZ')
  await user.click(screen.getByRole('button', { name: '写研究笔记' }))
  expect(screen.getByLabelText('笔记关联公司')).toHaveValue('000858.SZ')
  expect(screen.getByLabelText('笔记标题')).toHaveValue('')
  await user.selectOptions(screen.getByLabelText('研究范围'), '600519.SH')
  await user.click(screen.getByRole('button', { name: '写研究笔记' }))
  expect(screen.getByLabelText('笔记标题')).toHaveValue('茅台草稿')
  await user.click(screen.getByRole('button', { name: '关闭编辑' }))
  await user.click(screen.getByRole('button', { name: '开始研究' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith('new-c', 'screening'))
  expect(vi.mocked(api).mock.calls.find(([path]) => path === '/conversations/new-c/research-scope')?.[1]).toMatchObject({ method: 'PATCH', body: expect.stringContaining('600519.SH') })
})

it('opens project analysis on demand, preserves the content range, and follows quality links to exact notes and matrix runs', async () => {
  fixture()
  const user = userEvent.setup()
  render(<ResearchProjectsPage initialProjectId="p1" onOpenConversation={vi.fn()} />)
  await screen.findByRole('heading', { name: '消费研究' })
  await user.selectOptions(screen.getByLabelText('研究范围'), '000858.SZ')
  await user.click(screen.getByRole('tab', { name: /研究成果/ }))
  const tools = screen.getByRole('button', { name: '分析工具' })
  await user.click(tools)
  await user.keyboard('{Escape}')
  expect(tools).toHaveFocus()
  await user.click(tools)
  await user.click(screen.getByRole('menuitem', { name: /质量评测/ }))
  const dialog = screen.getByRole('dialog', { name: '质量评测' })
  expect(within(dialog).getByText('消费研究 · 整个项目')).toBeInTheDocument()
  await user.click(await within(dialog).findByRole('button', { name: '查看同业对比' }))
  expect(screen.getByRole('dialog', { name: '同业对比' })).toHaveTextContent('研究矩阵 matrix-old run-old')
  await user.keyboard('{Escape}')
  expect(screen.getByLabelText('研究范围')).toHaveValue('000858.SZ')
  expect(screen.getByRole('tab', { name: /研究成果/ })).toHaveAttribute('aria-selected', 'true')
  await user.click(tools)
  await user.click(screen.getByRole('menuitem', { name: /质量评测/ }))
  await user.click(await screen.findByRole('button', { name: '查看研究笔记' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByLabelText('研究范围')).toHaveValue('600519.SH')
  expect(screen.getByRole('button', { name: '茅台判断' })).toHaveAttribute('aria-expanded', 'true')
  await user.click(screen.getByRole('button', { name: '公司资料与跟踪' }))
  await user.click(screen.getByRole('button', { name: '打开公司笔记' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByLabelText('研究范围')).toHaveValue('600519.SH')
})

it('retains historical company ranges after removal and offers an honest empty state for unassociated records', async () => {
  const { project } = fixture()
  project.companies = project.companies.filter(company => company.stock_code !== '600519.SH')
  const user = userEvent.setup()
  render(<ResearchProjectsPage initialProjectId="p1" onOpenConversation={vi.fn()} />)
  await screen.findByRole('heading', { name: '消费研究' })
  expect(screen.getByRole('option', { name: '600519.SH（历史关联）' })).toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('研究范围'), '600519.SH')
  expect(screen.getByRole('button', { name: '茅台判断' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '公司资料与跟踪' })).not.toBeInTheDocument()
  project.conversations = []
  await user.click(screen.getByRole('button', { name: '刷新研究项目' }))
  await user.click(screen.getByRole('tab', { name: /研究对话/ }))
  expect(await screen.findByText('该公司暂无关联研究对话。')).toBeInTheDocument()
})
