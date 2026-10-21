import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import DisclosuresPanel from './DisclosuresPanel'
import type { ReactNode } from 'react'

vi.mock('../api', () => ({ api: vi.fn() }))
vi.mock('./StockSearch', () => ({
  default: ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) =>
    <label>{label}<input value={value} onChange={e => onChange(e.target.value)} /></label>,
  StockName: ({ code }: { code: string }) => <span>{code}</span>,
}))
vi.mock('./PdfReader', () => ({ default: ({ url, page, pageControls }: { url: string; page: number; pageControls?: ReactNode }) => <div data-testid="pdf" data-url={url}>物理页 {page}{pageControls}</div> }))

function version(id = 'v1', number = 1) {
  return { id, disclosure_id: 'root', version: number, pages: 3, parse_status: 'indexed', sha256: 'a'.repeat(64),
    pdf_url: `/api/v1/disclosures/versions/${id}/pdf`, source_kind: 'upload', source_url: null, created_at: '2026-10-20',
    metadata: { revision: 1, title: '合成原始年报', stock_code: '600519.SH', report_period: '2025-12-31', document_type: 'annual',
      document_form: 'full', publication_date: '2026-04-01', confirmed: true, suggestions: { document_type: 'annual' } } }
}
let current = version()
let versions = [current]
let imports: Record<string, unknown>[] = []
let pendingSearch: Promise<unknown> | null = null
beforeEach(() => {
  vi.clearAllMocks(); current = version(); versions = [current]; imports = []; pendingSearch = null
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/disclosures/import-options') return { can_write: true } as never
    if (path === '/disclosure-imports') return { items: imports } as never
    if (path.startsWith('/disclosures?')) return { items: [current], total: 1 } as never
    if (path.endsWith('/metadata')) {
      const request = JSON.parse(String(options?.body))
      current = { ...current, metadata: { ...request.metadata, revision: 2, suggestions: {} } }; versions = [current]
      return current as never
    }
    if (path.includes('/search?')) return (pendingSearch || { items: [{ page_number: 3, snippet: '原文表格' }] }) as never
    if (path.includes('/pages/')) return { text: '当前物理页原文', next_offset: null, page_number: Number(path.match(/pages\/(\d+)/)![1]) } as never
    if (path.startsWith('/disclosures/versions/')) {
      const selected = versions.find(v => path.includes('/' + v.id)) || current
      return { ...selected, versions, related: [], metadata_history: [{ revision: selected.metadata.revision, metadata: selected.metadata, created_at: '2026-10-20' }] } as never
    }
    if (path === '/disclosures/import-url' || path === '/disclosures/upload') {
      const payload = options?.body instanceof FormData ? JSON.parse(String(options.body.get('payload'))) : JSON.parse(String(options?.body))
      const item = { id: 'import', job_id: 'job', filename: 'sample.pdf', state: 'queued', message: '等待归档',
        stage: 'queued', version_id: null, progress: 0, request: payload }
      imports = [item]
      return item as never
    }
    if (path === '/jobs/job/cancel') { imports = [{ ...imports[0], state: 'cancelled', message: '已停止' }]; return {} as never }
    throw new Error('Unexpected API ' + path)
  })
})
async function read() {
  render(<DisclosuresPanel />)
  await userEvent.click(await screen.findByRole('button', { name: /合成原始年报/ }))
  return screen.findByRole('region', { name: '披露版本阅读' })
}

it('opens the immutable PDF, searches physical pages and saves a guarded metadata revision', async () => {
  const reader = await read()
  expect(within(reader).getByTestId('pdf')).toHaveAttribute('data-url', '/api/v1/disclosures/versions/v1/pdf')
  fireEvent.change(screen.getByLabelText('检索本份原文'), { target: { value: '表格' } })
  await userEvent.click(screen.getByRole('button', { name: '定位原文页' }))
  await userEvent.click(await screen.findByRole('button', { name: /第 3 页 原文表格/ }))
  expect(within(reader).getByTestId('pdf')).toHaveTextContent('物理页 3')
  fireEvent.change(screen.getByLabelText('跳转原始披露物理页'), { target: { value: '2' } })
  expect(within(reader).getByTestId('pdf')).toHaveTextContent('物理页 2')
  await userEvent.click(screen.getByRole('button', { name: '核对分类' }))
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '已核对的年度报告' } })
  await userEvent.click(screen.getByRole('button', { name: '保存分类核对' }))
  await waitFor(() => expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/metadata'))).toBe(true))
  const request = vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/metadata'))!
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({ base_revision: 1, metadata: { title: '已核对的年度报告' } })
})

it('submits an official link without inventing a publication date and exposes cancellation', async () => {
  render(<DisclosuresPanel />)
  await userEvent.click(await screen.findByRole('button', { name: '归档原始披露' }))
  await userEvent.click(screen.getByRole('button', { name: '官方链接' }))
  fireEvent.change(screen.getByLabelText(/官方 PDF 原文链接/), { target: { value: 'https://static.cninfo.com.cn/a.pdf' } })
  await userEvent.click(screen.getByRole('button', { name: '提交归档' }))
  const call = vi.mocked(api).mock.calls.find(([path]) => path === '/disclosures/import-url')!
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ url: 'https://static.cninfo.com.cn/a.pdf', relation: 'new',
    metadata: { confirmed: false, publication_date: null, report_period: null } })
  await userEvent.click(await screen.findByRole('button', { name: '停止导入' }))
  await screen.findByText('已停止')
})

it('uploads a revision tied to the explicitly selected source version', async () => {
  await read()
  await userEvent.click(screen.getByRole('button', { name: '添加修订全文' }))
  await userEvent.upload(screen.getByLabelText('原始披露 PDF 文件'), new File(['%PDF-test'], 'revision.pdf', { type: 'application/pdf' }))
  await userEvent.click(screen.getByLabelText(/我已核对公司/))
  await userEvent.click(screen.getByRole('button', { name: '提交归档' }))
  const call = vi.mocked(api).mock.calls.find(([path]) => path === '/disclosures/upload')!
  const form = call[1]?.body as FormData
  expect((form.get('file') as File).name).toBe('revision.pdf')
  expect(JSON.parse(String(form.get('payload')))).toMatchObject({ relation: 'revision', target_version_id: 'v1',
    metadata: { stock_code: '600519.SH', report_period: '2025-12-31', document_form: 'full', confirmed: true } })
})

it('ignores stale search results after a version change', async () => {
  const newer = version('v2', 2); versions = [newer, current]
  let complete!: (value: unknown) => void
  pendingSearch = new Promise(resolve => { complete = resolve })
  await read()
  fireEvent.change(screen.getByLabelText('检索本份原文'), { target: { value: '旧页' } })
  await userEvent.click(screen.getByRole('button', { name: '定位原文页' }))
  fireEvent.change(screen.getByLabelText('原文版本'), { target: { value: 'v2' } })
  await waitFor(() => expect(screen.getByTestId('pdf')).toHaveAttribute('data-url', '/api/v1/disclosures/versions/v2/pdf'))
  await act(async () => complete({ items: [{ page_number: 2, snippet: '不应出现的旧版本结果' }] }))
  expect(screen.queryByText('不应出现的旧版本结果')).not.toBeInTheDocument()
})

it('read-only company views send their company and cutoff and hide mutation controls', async () => {
  render(<DisclosuresPanel stockCode="600519.SH" asOf="2026-04-15" writable={false} compact />)
  await screen.findByRole('button', { name: /合成原始年报/ })
  expect(screen.queryByRole('button', { name: '归档原始披露' })).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('stock_code=600519.SH') && path.includes('as_of=2026-04-15'))).toBe(true)
})

it('a completed background import does not redirect an open classification editor', async () => {
  await read()
  await userEvent.click(screen.getByRole('button', { name: '归档原始披露' }))
  await userEvent.click(screen.getByRole('button', { name: '官方链接' }))
  fireEvent.change(screen.getByLabelText(/官方 PDF 原文链接/), { target: { value: 'https://static.cninfo.com.cn/new.pdf' } })
  await userEvent.click(screen.getByRole('button', { name: '提交归档' }))
  await userEvent.click(screen.getByRole('button', { name: '核对分类' }))
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '正在核对原版本' } })
  versions = [version('v2', 2), current]
  imports = [{ ...imports[0], state: 'succeeded', version_id: 'v2', message: '已完成' }]
  await screen.findByRole('button', { name: '打开归档版本' }, { timeout: 4000 })
  expect(screen.getByLabelText('标题')).toHaveValue('正在核对原版本')
  expect(screen.getByTestId('pdf')).toHaveAttribute('data-url', '/api/v1/disclosures/versions/v1/pdf')
})
