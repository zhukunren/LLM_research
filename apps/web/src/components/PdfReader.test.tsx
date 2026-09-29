import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { getDocument } from 'pdfjs-dist'
import PdfReader from './PdfReader'

vi.mock('pdfjs-dist', () => ({ getDocument: vi.fn(), GlobalWorkerOptions: {} }))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/worker.mjs' }))
const draw = vi.fn()
const cancel = vi.fn()
const renderPage = vi.fn()
const document = { numPages: 3, getPage: vi.fn() }
beforeEach(() => {
  draw.mockReset(); cancel.mockReset(); renderPage.mockReset()
  renderPage.mockImplementation(() => ({ promise: Promise.resolve(), cancel }))
  document.getPage.mockImplementation(async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render: renderPage }))
  vi.mocked(getDocument).mockReturnValue({ promise: Promise.resolve(document), destroy: vi.fn().mockResolvedValue(undefined) } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as never)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})

it('does not let a cancelled render overwrite the new page and resets its scroll position', async () => {
  let finishOld: () => void = () => {}
  renderPage.mockImplementationOnce(() => ({ promise: new Promise<void>(resolve => { finishOld = resolve }), cancel }))
  const props = { url: '/report.pdf', page: 1, onPageChange: vi.fn() }
  const view = render(<PdfReader {...props} />)
  await waitFor(() => expect(renderPage).toHaveBeenCalledOnce())
  const container = view.container.querySelector('.pdf-canvas-container')!
  container.scrollTop = 300
  view.rerender(<PdfReader {...props} page={2} />)
  await waitFor(() => expect(draw).toHaveBeenCalledOnce())
  expect(container.scrollTop).toBe(0)
  expect(cancel).toHaveBeenCalledOnce()
  await act(async () => finishOld())
  expect(draw).toHaveBeenCalledOnce()
  expect(screen.getByRole('img', { name: '研报 PDF 第 2 页' })).toBeVisible()
})

it('fits a full page, provides keyboard paging and closes focused reading with Escape', async () => {
  const onPageChange = vi.fn(), user = userEvent.setup()
  render(<PdfReader url="/report.pdf" page={1} onPageChange={onPageChange} />)
  await waitFor(() => expect(draw).toHaveBeenCalledOnce())
  await user.selectOptions(screen.getByLabelText('PDF 显示比例'), 'page')
  await waitFor(() => expect(renderPage.mock.calls.at(-1)![0].viewport.height).toBe(650))
  const reader = screen.getByLabelText('PDF 阅读器')
  fireEvent.keyDown(reader, { key: 'ArrowRight' })
  expect(onPageChange).toHaveBeenCalledWith(2)
  await user.click(screen.getByRole('button', { name: '专注阅读' }))
  expect(reader).toHaveClass('expanded')
  fireEvent.keyDown(reader, { key: 'Escape' })
  expect(reader).not.toHaveClass('expanded')
})
