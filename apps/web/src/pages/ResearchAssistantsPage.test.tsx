import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api, type ResearchAssistant } from '../api'
import ResearchAssistantsPage from './ResearchAssistantsPage'

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: vi.fn() }))
const assistants: ResearchAssistant[] = [
  ['general', '通用投研'], ['financial', '财报分析'], ['reports', '研报解读'],
  ['supply-chain', '产业链研究'], ['risk', '风险复核'],
].map(([id, name]) => ({ id, name, description: `${name}预设方法`, instructions: `# ${name}\n\n核对原文，保留证据。`, enabled: true, builtin: true, revision: 1, skill_hash: id }))

it('offers the five ready-to-use presets without requiring assistant creation', async () => {
  vi.mocked(api).mockResolvedValue({ items: [...assistants,
    { ...assistants[0], id: 'custom', name: '我的自定义助手', builtin: false },
    { ...assistants[0], id: 'retired', name: '停用助手', enabled: false },
  ] } as never)
  const onUse = vi.fn(), user = userEvent.setup()
  render(<ResearchAssistantsPage onUse={onUse} />)
  await screen.findByRole('button', { name: '使用财报分析' })
  expect(screen.getAllByRole('article')).toHaveLength(5)
  for (const assistant of assistants) expect(screen.getByRole('button', { name: `使用${assistant.name}` })).toBeInTheDocument()
  expect(screen.queryByText('我的自定义助手')).not.toBeInTheDocument()
  expect(screen.queryByText('停用助手')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /新建助手|保存助手|复制为自定义助手/ })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('助手名称')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('研究方法与输出要求')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '使用财报分析' }))
  expect(onUse).toHaveBeenCalledExactlyOnceWith('financial')
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('reveals the preset research method only when requested', async () => {
  vi.mocked(api).mockResolvedValue({ items: assistants } as never)
  const user = userEvent.setup()
  render(<ResearchAssistantsPage onUse={vi.fn()} />)
  const card = within(await screen.findByRole('article', { name: '财报分析' }))
  const method = card.getByText('核对原文，保留证据。')
  expect(method).not.toBeVisible()
  await user.click(card.getByText('研究方法'))
  expect(method).toBeVisible()
})

it('can retry reading the presets after a catalog failure', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('助手读取失败')).mockResolvedValue({ items: assistants } as never)
  const user = userEvent.setup()
  render(<ResearchAssistantsPage onUse={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('助手读取失败')
  await user.click(screen.getByRole('button', { name: '重新读取' }))
  await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(5))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
