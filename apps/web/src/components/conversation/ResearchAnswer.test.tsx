import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ResearchAnswer from './ResearchAnswer'

describe('research answer reading', () => {
  it('renders structured findings and maps output paths to conversation downloads', () => {
    render(<ResearchAnswer conversationId="one" content={'## 研究结论\n\n- 订单已经落地\n- 仍需关注毛利率\n\n| 公司 | 增长 |\n| --- | --- |\n| 示例公司 | 20% |\n\n[下载表格](outputs/results.csv)\n\n[研究笔记](D:/research/one/work/outputs/notes.md)\n\n[原始资料](https://example.com/report)\n\n```python\nprint(20)\n```'} />)
    expect(screen.getByRole('heading', { name: '研究结论' })).toBeInTheDocument()
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '20%' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '下载表格' })).toHaveAttribute('href', '/api/v1/conversations/one/generated-files/results.csv')
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

  it('embeds local charts through the verified image route and downloads their original format', () => {
    render(<ResearchAnswer conversationId="one" content={'![实验曲线](outputs/chart.png)\n\n[下载图表](outputs/chart.png)'} />)
    expect(screen.getByRole('img', { name: '实验曲线' })).toHaveAttribute('src', '/api/v1/conversations/one/research-assets/chart.png')
    expect(screen.getByRole('link', { name: '下载图表' })).toHaveAttribute('href', '/api/v1/conversations/one/generated-files/chart.png')
    expect(screen.getByRole('link', { name: '下载图表' })).toHaveAttribute('download')
  })

  it('preserves Unicode filenames, spaces and percent signs without double-encoding and upgrades legacy output links', () => {
    render(<ResearchAnswer conversationId="one" content={'[Excel](outputs/%E5%85%AC%E5%8F%B8%20%E6%AF%94%E8%BE%83.xlsx)\n\n[Word](./outputs/结论.docx)\n\n[演示](C:/runtime/research/one/work/outputs/brief.pptx)\n\n[旧表格](/api/v1/conversations/one/research-files/20%25.csv)\n\n[百分号](outputs/growth20%.csv)'} />)
    expect(screen.getByRole('link', { name: 'Excel' })).toHaveAttribute('href', '/api/v1/conversations/one/generated-files/%E5%85%AC%E5%8F%B8%20%E6%AF%94%E8%BE%83.xlsx')
    expect(screen.getByRole('link', { name: 'Word' })).toHaveAttribute('href', '/api/v1/conversations/one/generated-files/%E7%BB%93%E8%AE%BA.docx')
    expect(screen.getByRole('link', { name: '演示' })).toHaveAttribute('href', '/api/v1/conversations/one/generated-files/brief.pptx')
    expect(screen.getByRole('link', { name: '旧表格' })).toHaveAttribute('href', '/api/v1/conversations/one/generated-files/20%25.csv')
    expect(screen.getByRole('link', { name: '百分号' })).toHaveAttribute('href', '/api/v1/conversations/one/generated-files/growth20%25.csv')
  })

  it('rejects encoded traversal and cross-conversation output references without rewriting genuine external sources', () => {
    const { container } = render(<ResearchAnswer conversationId="one" content={'[越界](outputs/%2e%2e/config.json)\n\n[编码分隔](outputs/folder%2f..%2fsecret.txt)\n\n[另一对话](/api/v1/conversations/two/generated-files/data.csv)\n\n[外部来源](https://example.com/research/one/work/outputs/data.csv)'} />)
    expect(container.querySelectorAll('a[href]')).toHaveLength(1)
    expect(screen.getByRole('link', { name: '外部来源' })).toHaveAttribute('href', 'https://example.com/research/one/work/outputs/data.csv')
    expect(screen.getByRole('link', { name: '外部来源' })).not.toHaveAttribute('download')
  })

  it('renders the real daily-hotspots CJK punctuation pattern as strong text without inserting visible spaces', () => {
    const content = '**研究范围：**北京时间2026年10月8日，公开可核验信息。\n\n'
      + Array.from({ length: 10 }, (_, index) => `${index + 1}. **A股市场与产业资讯${index + 1}。**事件：整理重要变化，核验原始来源。`).join('\n')
    const { container } = render(<ResearchAnswer conversationId="one" content={content} />)
    expect(container.querySelectorAll('strong')).toHaveLength(11)
    expect(screen.getByText('研究范围：').tagName).toBe('STRONG')
    expect(screen.getByText('A股市场与产业资讯10。').tagName).toBe('STRONG')
    expect(container.querySelector('p')?.textContent).toBe('研究范围：北京时间2026年10月8日，公开可核验信息。')
    expect(container.querySelectorAll('li')).toHaveLength(10)
    expect(container.textContent).not.toContain('**')
  })

  it('keeps escaped star pairs literal while repairing adjacent real strong text and decoding entities normally', () => {
    const { container } = render(<ResearchAnswer conversationId="one" content={'\\*\\*研究范围：\\*\\*保持字面；**研究范围：**北京时间 &amp; 海外市场。\n\n**来源：**A股公告；**风险：**仍待核验。'} />)
    expect(container.querySelectorAll('strong')).toHaveLength(3)
    expect(container.querySelector('p')?.textContent).toBe('**研究范围：**保持字面；研究范围：北京时间 & 海外市场。')
    expect(container.textContent).toContain('来源：A股公告；风险：仍待核验。')
  })

  it('preserves inline and fenced code, escaped delimiters, and link destinations containing star pairs', () => {
    const content = '`**研究范围：**代码内容`\n\n```text\n**研究范围：**代码内容\n```\n\n'
      + '[来源](https://example.com/**研究范围：**正文?q=**data**)\n\n'
      + '**研究范围：\\**不能结束粗体\n\n**正文：**可正常显示。'
    const { container } = render(<ResearchAnswer conversationId="one" content={content} />)
    expect([...container.querySelectorAll('code')].map(node => node.textContent?.trim())).toEqual(['**研究范围：**代码内容', '**研究范围：**代码内容'])
    expect(decodeURI(screen.getByRole('link', { name: '来源' }).getAttribute('href')!)).toBe('https://example.com/**研究范围：**正文?q=**data**')
    expect(container.querySelectorAll('strong')).toHaveLength(1)
    expect(screen.getByText('正文：').tagName).toBe('STRONG')
    expect(container.textContent).toContain('**研究范围：**不能结束粗体')
  })

  it('does not activate raw HTML or unsafe links while repairing Chinese emphasis', () => {
    const { container } = render(<ResearchAnswer conversationId="one" content={'**提示：**&lt;script&gt;alert(1)&lt;/script&gt;\n\n**范围：**公开资料。<img src="x" onerror="alert(1)">\n\n[危险](javascript:alert%281%29)\n\n<iframe src="javascript:alert(1)"></iframe>\n\n<script>**研究范围：**alert(1)</script>'} />)
    expect(container.querySelector('script,iframe,img')).toBeNull()
    expect(container.querySelector('[onerror],a[href^="javascript:"]')).toBeNull()
    expect(screen.getByText('范围：').tagName).toBe('STRONG')
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })
})
