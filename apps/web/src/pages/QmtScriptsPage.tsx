import { Code2, ArrowRight } from 'lucide-react'
import { isText, useSessionState } from '../useSessionState'
import QmtReferenceLibrary from '../components/QmtReferenceLibrary'
import './qmt-scripts.css'

const examples = [
  { name: '均线交叉', text: '使用日线，5 日均线上穿 20 日均线时产生买入信号，下穿时产生卖出信号。股票范围为 000001.SZ 和 600000.SH；用已完成的 K 线判断，避免同一信号重复触发。' },
  { name: '放量突破', text: '使用日线，收盘价突破此前 20 个交易日最高价，且成交量大于此前 5 日均量的 1.5 倍时提示。输出股票代码、信号日期与触发依据，不下单。' },
  { name: '修改已有脚本', text: '我会在对话中粘贴已有的 QMT 内置 Python 脚本和报错，请保留原策略含义，检查接口、历史行情截止时间与重复委托问题，修复后提供完整脚本和改动说明。' },
]

export default function QmtScriptsPage({ onOpenDraft }: { onOpenDraft: (prompt: string) => void }) {
  const [requirement, setRequirement] = useSessionState('qmt.requirement', '', isText)
  const [mode, setMode] = useSessionState('qmt.mode', 'signal', (value): value is string => ['signal', 'backtest', 'trading'].includes(String(value)))
  const [encoding, setEncoding] = useSessionState('qmt.encoding', 'gbk', (value): value is string => value === 'gbk' || value === 'utf-8')
  const modeLabel = mode === 'backtest' ? '生成回测策略，实盘默认关闭' : mode === 'trading' ? '生成含交易逻辑的策略草稿，实盘开关默认关闭，账号留空' : '仅计算和输出信号，不提交委托'

  function openDraft() {
    if (!requirement.trim()) return
    onOpenDraft(`请为券商 QMT 客户端内置 Python 策略编辑器编写脚本。\n用途：${modeLabel}。\n文件编码：${encoding === 'gbk' ? 'GBK' : 'UTF-8'}，编码声明与下载文件字节保持一致。\n\n我的需求：\n${requirement.trim()}\n\n请先查阅项目已接入的 QMT 策略编写手册、相关官方接口参考和相近源码示例，再说明必要的默认假设，生成完整代码供预览，使用 export_qmt_script 静态检查并导出可下载的 .py 文件，附使用依据、客户端导入、回测设置和待验证事项。`)
  }

  return <div className="page-content workspace-tool-page qmt-scripts-page">
    <header className="page-heading"><h1><Code2 size={24} aria-hidden="true" />QMT 脚本生成</h1><p className="page-description">描述策略，生成可在 QMT 客户端内置 Python 编辑器中使用的脚本。</p></header>
    <form className="qmt-script-form workspace-form" onSubmit={event => { event.preventDefault(); openDraft() }}>
      <div className="qmt-script-options">
        <label className="workspace-field-label">脚本用途<select value={mode} onChange={event => setMode(event.target.value)} className="workspace-field workspace-select">
          <option value="signal">信号观察</option><option value="backtest">策略回测</option><option value="trading">交易策略草稿</option>
        </select></label>
        <label className="workspace-field-label">文件编码<select value={encoding} onChange={event => setEncoding(event.target.value)} className="workspace-field workspace-select"><option value="gbk">GBK（QMT 常用）</option><option value="utf-8">UTF-8</option></select></label>
      </div>
      <label className="qmt-requirement" htmlFor="qmt-requirement">策略需求</label>
      <textarea id="qmt-requirement" value={requirement} maxLength={12000} rows={9} onChange={event => setRequirement(event.target.value)} placeholder="例如：日线 5 日均线上穿 20 日均线时提示，跌破 20 日均线时退出。请说明股票范围、触发条件、仓位与止损要求。" aria-describedby="qmt-draft-help" className="workspace-field" />
      <div className="qmt-script-examples" role="group" aria-label="QMT 需求示例">{examples.map(item => <button type="button" key={item.name} onClick={() => setRequirement(item.text)} className="workspace-button">{item.name}</button>)}</div>
      <div className="qmt-script-submit"><p id="qmt-draft-help">下一步选择模型并发送。生成后可预览、下载，也可继续对话修改。</p><button type="submit" className="primary-button workspace-button" disabled={!requirement.trim()}>带入生成对话<ArrowRight size={16} /></button></div>
    </form>
    <QmtReferenceLibrary />
    <p className="qmt-script-note">脚本只做静态检查，工作台不会连接券商或执行交易。导入后需在你的 QMT 版本中核对并回测。</p>
  </div>
}
