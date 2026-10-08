import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ResearchPanel from './ResearchPanel'
import ResearchFileList from '../ResearchFileList'

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const coverage = { target_total: 21, true_count: 20, false_count: 0, unknown_count: 1, failed_count: 1, not_evaluated_count: 0 }
const output = { name: '研究报告.pdf', bytes: 4096, url: '/api/v1/conversations/one/research-pdfs/report.pdf' }
const decision = (index: number) => ({ stock_code: `${600000 + index}.SH`, state: 'true', evaluation_status: 'completed', metrics: { change: 20 }, units: { change: '%' }, explanation: '实际计算结果' })

describe('persistent research results', () => {
  it('keeps the failed new report visible beside the previous PDF and retries only its job', async () => {
    const writes: string[] = []
    let status = 'failed'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (init?.method === 'POST') { writes.push(url.pathname); status = 'queued'; return json({ status }) }
      if (url.pathname.endsWith('/research-files')) return json({ items: [output, { id: 'report-job', name: '新版报告.pdf', bytes: 0, url: null, modified_at: 0, conversation_id: 'one', status, retry_url: '/api/v1/conversations/one/research-pdf-jobs/report-job/retry' }] })
      return json({ items: [] })
    }))
    const user = userEvent.setup()
    const view = render(<ResearchPanel conversationId="one" turnActive={false} refreshKey={1} showGenerate />)
    expect(await screen.findByText(/PDF 生成未完成/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /研究报告.pdf/ })).toHaveAttribute('href', output.url)
    expect(screen.queryByRole('link', { name: /新版报告.pdf/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试报告' }))
    expect(await screen.findByText(/等待生成 PDF/)).toBeInTheDocument()
    expect(writes).toEqual(['/api/v1/conversations/one/research-pdf-jobs/report-job/retry'])
    view.unmount()
  })
  it('restores scan progress and output downloads and cancels only the selected scan', async () => {
    let status = 'running'
    const writes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (init?.method === 'POST') { writes.push(url.pathname); status = 'cancelled'; return json({ status }) }
      if (url.pathname.endsWith('/research-files')) return json({ items: [output] })
      if (url.pathname.endsWith('/generated-files')) return json({ items: [] })
      if (url.pathname.endsWith('/research-scans')) return json({ items: [{ id: 'scan', name: '全市场计算', as_of: '2026-09-14', status, coverage, progress: 0.5 }] })
      if (url.pathname.endsWith('/decisions')) return json({ items: [decision(0)], total: 1 })
      return json({ id: 'scan', as_of: '2026-09-14', status, execution_mode: 'per_stock', export_url: '/scan.csv',
                    result: { coverage, result_valid: false }, job: { progress: 0.5, message: '已处理 10/21' } })
    }))
    const user = userEvent.setup()
    const view = render(<ResearchPanel conversationId="one" turnActive={false} refreshKey={0} />)
    expect(await screen.findByText('已处理 10/21')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '研究扫描进度' })).toHaveAttribute('value', '0.5')
    expect(screen.getByRole('link', { name: /研究报告.pdf/ })).toHaveAttribute('href', output.url)
    await user.click(screen.getByRole('button', { name: '停止研究扫描' }))
    expect(await screen.findByRole('link', { name: '下载研究扫描 PDF' })).toHaveAttribute('href', '/scan.csv')
    expect(await screen.findByText('以下为中断前记录，未完成本次范围验证。')).toBeInTheDocument()
    expect(writes).toEqual(['/api/v1/conversations/one/research-scans/scan/cancel'])
    view.unmount()
  })

  it('shows computation errors and metrics and requests filtered pages without rerunning', async () => {
    const reads: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method || 'GET').toBe('GET')
      const url = new URL(String(input), 'http://localhost')
      reads.push(url)
      if (url.pathname.endsWith('/research-files')) return json({ items: [] })
      if (url.pathname.endsWith('/generated-files')) return json({ items: [] })
      if (url.pathname.endsWith('/research-scans')) return json({ items: [{ id: 'failed', name: '排名实验', as_of: '2026-09-14', status: 'failed', coverage }] })
      if (url.pathname.endsWith('/decisions')) {
        const offset = Number(url.searchParams.get('offset'))
        return json({ items: Array.from({ length: offset ? 1 : 20 }, (_, index) => decision(offset + index)), total: 21 })
      }
      return json({ id: 'failed', as_of: '2026-09-14', status: 'failed', execution_mode: 'cross_sectional', export_url: '/failed.csv',
                    result: { coverage, result_valid: false, error: 'missing_field' }, job: { progress: 1, message: '计算失败' } })
    }))
    const user = userEvent.setup()
    const view = render(<ResearchPanel conversationId="one" turnActive={false} refreshKey={0} />)
    expect(await screen.findByText('missing_field')).toBeInTheDocument()
    expect(screen.getAllByText('change: 20%')).toHaveLength(20)
    await user.click(screen.getByRole('button', { name: '下一页研究结果' }))
    expect(await screen.findByText('600020.SH')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('研究结果状态'), 'unknown')
    await user.type(screen.getByLabelText('搜索研究证券'), '600000')
    await waitFor(() => expect(reads.some(url => url.pathname.endsWith('/decisions') && url.searchParams.get('state') === 'unknown' && url.searchParams.get('query') === '600000' && url.searchParams.get('offset') === '0')).toBe(true))
    expect(screen.getByRole('link', { name: '下载研究扫描 PDF' })).toHaveAttribute('href', '/failed.csv')
    view.unmount()
  })
})

const generated = (id = 'one', name = '公司比较.xlsx') => ({
  name, bytes: 4096, modified_at: 1791456000, file_type: 'xlsx',
  media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  conversation_id: id, url: `/api/v1/conversations/${id}/generated-files/${encodeURIComponent(name)}`,
})

it('shows original editable files beside branded PDFs without creating conversion jobs', async () => {
  const file = generated(), onContentChange = vi.fn()
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method || 'GET').toBe('GET')
    const path = new URL(String(input), 'http://localhost').pathname
    return json({ items: path.endsWith('/generated-files') ? [file] : path.endsWith('/research-files') ? [output] : [] })
  })
  vi.stubGlobal('fetch', fetcher)
  render(<ResearchPanel conversationId="one" turnActive={false} refreshKey={0} onContentChange={onContentChange} />)
  const originals = await screen.findByRole('region', { name: '生成文件' })
  const link = within(originals).getByRole('link', { name: /公司比较.xlsx/ })
  expect(link).toHaveAttribute('href', file.url)
  expect(link).toHaveAttribute('download')
  expect(within(originals).getByText('XLSX · 4.0 KB')).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: 'PDF 报告' })).getByRole('link', { name: /研究报告.pdf/ })).toHaveAttribute('href', output.url)
  await waitFor(() => expect(onContentChange).toHaveBeenLastCalledWith(true))
})

it('keeps original-only output discoverable in the results drawer', async () => {
  const onContentChange = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => json({ items: String(input).endsWith('/generated-files') ? [generated()] : [] })))
  render(<ResearchPanel conversationId="one" turnActive={false} refreshKey={0} onContentChange={onContentChange} />)
  expect(await screen.findByRole('link', { name: /公司比较.xlsx/ })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'PDF 报告' })).not.toBeInTheDocument()
  await waitFor(() => expect(onContentChange).toHaveBeenLastCalledWith(true))
})

it('keeps the PDF available when original-file listing fails and retries through refresh', async () => {
  let failed = true
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method || 'GET').toBe('GET')
    const path = new URL(String(input), 'http://localhost').pathname
    if (path.endsWith('/generated-files')) return failed ? new Response('{"message":"暂不可用"}', { status: 503 }) : json({ items: [generated()] })
    return json({ items: path.endsWith('/research-files') ? [output] : [] })
  }))
  const user = userEvent.setup()
  render(<ResearchPanel conversationId="one" turnActive={false} refreshKey={0} />)
  expect(await screen.findByText('生成文件暂时无法读取，请刷新重试。')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /研究报告.pdf/ })).toHaveAttribute('href', output.url)
  failed = false
  await user.click(screen.getByRole('button', { name: '刷新研究成果' }))
  expect(await screen.findByRole('link', { name: /公司比较.xlsx/ })).toBeInTheDocument()
  expect(screen.queryByText('生成文件暂时无法读取，请刷新重试。')).not.toBeInTheDocument()
})

it('ignores a previous conversation file listing that finishes after navigation', async () => {
  let finish!: (value: Response) => void
  const late = new Promise<Response>(resolve => { finish = resolve })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/v1/conversations/one/generated-files') return late
    return json({ items: path === '/api/v1/conversations/two/generated-files' ? [generated('two', '新会话表格.xlsx')] : [] })
  }))
  const view = render(<ResearchPanel conversationId="one" turnActive={false} refreshKey={0} />)
  view.rerender(<ResearchPanel conversationId="two" turnActive={false} refreshKey={0} />)
  expect(await screen.findByRole('link', { name: /新会话表格.xlsx/ })).toHaveAttribute('href', generated('two', '新会话表格.xlsx').url)
  await act(async () => { finish(json({ items: [generated('one', '旧会话表格.xlsx')] })); await late })
  expect(screen.queryByRole('link', { name: /旧会话表格/ })).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: /新会话表格.xlsx/ })).toBeInTheDocument()
})

const legacyOfficeDiscovery = {
  id: 'office-discovery', name: '旧 Office 整理记录', bytes: 0, modified_at: 0, url: null, conversation_id: 'one',
  source_kind: 'discovery', status: 'partial', retry_url: '/api/v1/conversations/one/research-pdf-jobs/office-discovery/retry',
  message: '3 个文件格式暂不支持，原件保留。',
  discovery: { unsupported: ['data/results.xlsx', 'report.docx', 'slides.PPTX'], errors: [] },
}

it('omits obsolete Office-only discovery warnings from an older backend while keeping real downloads', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method || 'GET').toBe('GET')
    const path = new URL(String(input), 'http://localhost').pathname
    return json({ items: path.endsWith('/research-files') ? [legacyOfficeDiscovery, output] : path.endsWith('/generated-files') ? [generated()] : [] })
  }))
  render(<ResearchPanel conversationId="one" turnActive={false} refreshKey={0} />)
  expect(await screen.findByRole('link', { name: /公司比较.xlsx/ })).toHaveAttribute('download')
  expect(screen.getByRole('link', { name: /研究报告.pdf/ })).toHaveAttribute('href', output.url)
  expect(screen.queryByText('旧 Office 整理记录')).not.toBeInTheDocument()
  expect(screen.queryByText(/个文件格式暂不支持/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '重试报告' })).not.toBeInTheDocument()
})

it('retains real, mixed and unexplained errors with working retry actions in the shared file list', async () => {
  const files = [legacyOfficeDiscovery,
    { ...legacyOfficeDiscovery, id: 'mixed', name: '仍有不支持文件', discovery: { unsupported: ['report.docx', 'archive.zip'], errors: [] } },
    { ...legacyOfficeDiscovery, id: 'read-error', name: '真实读取错误', discovery: { unsupported: ['report.xlsx'], errors: [{ message: '原件读取失败' }] } },
    { ...legacyOfficeDiscovery, id: 'failed', name: '实际失败任务', status: 'failed' },
    { ...legacyOfficeDiscovery, id: 'unknown', name: '错误记录不完整', discovery: { unsupported: ['report.docx'], errors: null } },
    { ...legacyOfficeDiscovery, id: 'empty', name: '未说明原因的部分失败', discovery: { unsupported: [], errors: [] } },
    { ...legacyOfficeDiscovery, id: 'real-report', name: '实际报告失败', source_kind: 'turn' },
  ]
  const onRetry = vi.fn(), user = userEvent.setup()
  render(<ResearchFileList files={files} onRetry={onRetry} />)
  expect(screen.queryByText('旧 Office 整理记录')).not.toBeInTheDocument()
  for (const file of files.slice(1)) expect(screen.getByText(file.name)).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: '重试报告' })).toHaveLength(6)
  await user.click(within(screen.getByText('真实读取错误').closest('.research-file-row') as HTMLElement).getByRole('button', { name: '重试报告' }))
  expect(onRetry).toHaveBeenCalledWith(files[2])
})
