import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../api'
import ProjectMembership from './ProjectMembership'

vi.mock('../../api', () => ({ api: vi.fn() }))

describe('ProjectMembership', () => {
  it('only confirms a new association after the server accepts it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn(), onError = vi.fn()
    let reject = true
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === '/research-projects') return { items: [{ id: 'p1', name: '白酒研究', status: 'active' }] } as never
      expect(path).toBe('/conversations/c1/project')
      expect(JSON.parse(String(init?.body))).toEqual({ project_id: 'p1' })
      if (reject) throw new Error('当前研究尚未结束')
      return {} as never
    })
    render(<ProjectMembership conversationId="c1" disabled={false} onChange={onChange} onError={onError} />)
    await screen.findByRole('option', { name: '白酒研究' })
    await user.selectOptions(screen.getByRole('combobox', { name: '所属研究项目' }), 'p1')
    await waitFor(() => expect(onError).toHaveBeenCalledWith('当前研究尚未结束'))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: '所属研究项目' })).toHaveValue('')
    reject = false
    await user.selectOptions(screen.getByRole('combobox', { name: '所属研究项目' }), 'p1')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('p1'))
  })
})
