import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import QmtReferenceLibrary from './QmtReferenceLibrary'

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: vi.fn() }))
const entry = { id: 'official-market-data', title: '行情接口参考', kind: 'official_reference', sha256: 'a'.repeat(64), sources: ['https://dict.thinktrader.net/innerApi/data_function.html'], runtime_verified: false }
const catalog = { items: [entry], total: 1, next_offset: null, version: '2026-10-15.1', verified_at: '2026-10-15', compatibility: '券商客户端版本尚未验证' }
const toggle = '参考资料 · 官方接口、编写手册与示例'

it('loads references on demand and reads the selected exact version with provenance', async () => {
  vi.mocked(api).mockImplementation(async path => path.startsWith('/qmt-docs?') ? catalog : {
    document: entry, text: '# 行情接口\n\n使用 get_market_data_ex。', char_start: 0, next_offset: null, version: catalog.version,
  })
  const user = userEvent.setup()
  render(<QmtReferenceLibrary />)
  expect(api).not.toHaveBeenCalled()
  await user.click(screen.getByText(toggle))
  await user.click(await screen.findByRole('button', { name: entry.title }))
  expect(await screen.findByText('使用 get_market_data_ex。')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '官方原文 1' })).toHaveAttribute('href', entry.sources[0])
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes(`expected_sha256=${entry.sha256}`))).toBe(true)
  expect(screen.getByText(/未在券商客户端验证/)).toBeInTheDocument()
  expect(screen.getByRole('article', { name: 'QMT 资料正文' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('article', { name: 'QMT 资料正文' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: entry.title })).toHaveFocus()
})

it('searches by the submitted topic and reports empty results truthfully', async () => {
  vi.mocked(api).mockImplementation(async path => path.includes('query=missing') ? { ...catalog, total: 0, items: [] } : catalog)
  const user = userEvent.setup()
  render(<QmtReferenceLibrary />)
  await user.click(screen.getByText(toggle))
  await screen.findByRole('button', { name: entry.title })
  await user.type(screen.getByLabelText('搜索 QMT 参考资料'), 'missing')
  await user.click(screen.getByRole('button', { name: '查找' }))
  expect(await screen.findByText('未找到匹配资料')).toBeInTheDocument()
  expect(screen.getByText('可换用接口名或其他关键词。')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: entry.title })).not.toBeInTheDocument()
})

it('continues a paged source without duplicating the tail after reopening the library', async () => {
  const first = '# 行情接口\n\n第一部分。'
  vi.mocked(api).mockImplementation(async path => path.startsWith('/qmt-docs?') ? catalog : {
    document: entry, text: path.includes(`offset=${first.length}`) ? '第二部分。' : first,
    char_start: path.includes(`offset=${first.length}`) ? first.length : 0,
    next_offset: path.includes(`offset=${first.length}`) ? null : first.length, version: catalog.version,
  })
  const user = userEvent.setup()
  render(<QmtReferenceLibrary />)
  await user.click(screen.getByText(toggle))
  await user.click(await screen.findByRole('button', { name: entry.title }))
  await user.click(await screen.findByRole('button', { name: '继续读取正文' }))
  await screen.findByText('第一部分。第二部分。')
  await user.click(screen.getByText(toggle))
  await user.click(screen.getByText(toggle))
  await waitFor(() => expect(screen.queryByText('正在读取正文…')).not.toBeInTheDocument())
  expect(screen.getByText('第一部分。第二部分。')).toBeInTheDocument()
})

it('recovers after a catalog error without changing the strategy request', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('资料目录读取失败')).mockResolvedValue(catalog)
  const user = userEvent.setup()
  render(<QmtReferenceLibrary />)
  await user.click(screen.getByText(toggle))
  expect(await screen.findByRole('alert')).toHaveTextContent('资料目录读取失败')
  await user.click(screen.getByRole('button', { name: '重试目录' }))
  expect(await screen.findByRole('button', { name: entry.title })).toBeInTheDocument()
})
