import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ResearchPanel from './ResearchPanel'

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
