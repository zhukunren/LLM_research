import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import ClientRobotPanel, { ClientCardSendDialog } from './ClientRobotPanel'
import type { ServiceCard } from '../clientService'

vi.mock('../api', () => ({ api: vi.fn() }))
it('reads delivery history directly without exposing robot mutation controls', async () => {
  vi.mocked(api).mockResolvedValue({ items: [{ id: 'delivery', robot_name: '客户群', state: 'sent', kind: 'text', message: '已接收', created_at: '2026-11-17T01:00:00Z' }] } as never)
  render(<ClientRobotPanel historyOnly />)
  await screen.findByText('客户群')
  expect(screen.queryByRole('button', { name: '新增机器人' })).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([path, init]) => path.endsWith('/deliveries') && !init?.method)).toBe(true)
})
const robot = { id: 'robot-one', name: '测试客户群', enabled: true, revision: 0, webhook_hint: '已配置 · 密钥不回显' }
const card = { id: 'card-one', revision: 3, service_date: '2026-11-16', template: { title: '即时简报', time: '09:30' }, content: { headline: '市场观察' } } as ServiceCard
function setup({ empty = false, sendingCard = false } = {}) {
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/client-service/robots/deliveries') return { items: [] }
    if (path === '/client-service/robots' && !init?.method) return { items: empty ? [] : [robot] }
    if (path.endsWith('/send')) return { state: 'sent', message: '企业微信已接收' }
    return robot
  })
  return render(sendingCard ? <ClientCardSendDialog card={card} kind="image" preview="/card.png" canSend onClose={() => {}} onManage={() => {}} /> : <ClientRobotPanel />)
}

it('does not send automatically and requires explicit target confirmation', async () => {
  const user = userEvent.setup(); setup()
  await screen.findByText('测试客户群')
  expect(screen.queryByRole('button', { name: '发送图片' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '发送文案' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '发送测试消息' }))
  expect(screen.getByRole('region', { name: '确认机器人操作' })).toHaveTextContent('将向此机器人所在群发送一条连接测试消息')
  expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/send'))).toBe(false)
  await user.click(screen.getByRole('button', { name: '确认发送到 测试客户群' }))
  expect(await screen.findByRole('status')).toHaveTextContent('已发送到「测试客户群」')
  const call = vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/send'))!
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ kind: 'test' })
  expect(JSON.parse(String(call[1]?.body)).card_id).toBeUndefined()
})

it('adds a webhook only after form submission and clears it on cancellation', async () => {
  const user = userEvent.setup(); setup({ empty: true })
  await screen.findByText('尚未配置群机器人')
  await user.click(screen.getByRole('button', { name: '新增机器人' }))
  await user.type(screen.getByRole('textbox', { name: '机器人名称' }), '我的服务群')
  fireEvent.change(screen.getByLabelText('Webhook 地址'), { target: { value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only-webhook' } })
  expect(screen.getByLabelText('Webhook 地址')).toHaveAttribute('type', 'password')
  await user.click(screen.getByRole('button', { name: '保存机器人' }))
  expect(await screen.findByRole('status')).toHaveTextContent('机器人配置已保存')
  expect(screen.queryByLabelText('Webhook 地址')).not.toBeInTheDocument()
  const call = vi.mocked(api).mock.calls.find(([path, init]) => path === '/client-service/robots' && init?.method === 'POST')!
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ name: '我的服务群', enabled: true })
})

it('uses the reviewed card revision and retains request id when a send response is lost', async () => {
  const user = userEvent.setup(); setup({ sendingCard: true })
  await user.selectOptions(await screen.findByRole('combobox', { name: '选择目标群' }), robot.id)
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path.endsWith('/send')) throw new Error('连接中断')
    return original(path, init)
  })
  await user.click(screen.getByRole('button', { name: '确认发送到 测试客户群' }))
  await screen.findByRole('alert')
  await waitFor(() => expect(screen.getByRole('button', { name: '确认发送到 测试客户群' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '确认发送到 测试客户群' }))
  const calls = vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/send'))
  expect(calls).toHaveLength(2)
  expect(calls[0][1]?.body).toBe(calls[1][1]?.body)
  expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({ kind: 'image', card_id: 'card-one', revision: 3 })
})

it('keeps the stored webhook when editing a name or enabled state', async () => {
  const user = userEvent.setup(); setup()
  await user.click(await screen.findByRole('button', { name: '编辑测试客户群' }))
  expect(screen.getByLabelText('Webhook 地址')).toHaveValue('')
  await user.click(screen.getByRole('checkbox', { name: '启用机器人' }))
  await user.click(screen.getByRole('button', { name: '保存机器人' }))
  await screen.findByRole('status')
  const call = vi.mocked(api).mock.calls.find(([path, init]) => path.endsWith('/robot-one') && init?.method === 'PUT')!
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ webhook: null, enabled: false, revision: 0 })
})
