import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ResearchAnswer from './ResearchAnswer'

describe('research answer reading', () => {
  it('renders structured findings and maps output paths to conversation downloads', () => {
    render(<ResearchAnswer conversationId="one" content={'## 研究结论\n\n- 订单已经落地\n- 仍需关注毛利率\n\n| 公司 | 增长 |\n| --- | --- |\n| 示例公司 | 20% |\n\n[下载表格](outputs/results.csv)\n\n[研究笔记](D:/research/one/work/outputs/notes.md)\n\n[原始资料](https://example.com/report)\n\n```python\nprint(20)\n```'} />)
    expect(screen.getByRole('heading', { name: '研究结论' })).toBeInTheDocument()
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '20%' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '下载表格' })).toHaveAttribute('href', '/api/v1/conversations/one/research-files/results.csv')
    expect(screen.getByRole('link', { name: '研究笔记' })).toHaveAttribute('download')
    expect(screen.getByRole('link', { name: '原始资料' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText('代码与数据').parentElement).not.toHaveAttribute('open')
  })

  it('rejects executable links, raw HTML and output traversal', () => {
    const { container } = render(<ResearchAnswer conversationId="one" content={'[恶意链接](javascript:alert%281%29)\n\n[越界文件](outputs/../secret.txt)\n\n<script>alert(1)</script>\n\n![不可信图像](outputs/chart.svg)'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(container.querySelector('a[href*="secret"]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('embeds local charts through the image route while their downloads remain PDFs', () => {
    render(<ResearchAnswer conversationId="one" content={'![实验曲线](outputs/chart.png)\n\n[下载图表 PDF](outputs/chart.png)'} />)
    expect(screen.getByRole('img', { name: '实验曲线' })).toHaveAttribute('src', '/api/v1/conversations/one/research-assets/chart.png')
    expect(screen.getByRole('link', { name: '下载图表 PDF' })).toHaveAttribute('href', '/api/v1/conversations/one/research-files/chart.png')
  })
})
