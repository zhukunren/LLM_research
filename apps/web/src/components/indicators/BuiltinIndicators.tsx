import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { api, type DataStatus } from '../../api'
import LoadingState from '../LoadingState'
import StockSearch from '../StockSearch'
import { ResponsiveMarketIndicatorChart, type IndicatorChart } from '../MarketIndicatorChart'

type Indicator = { id: string; name: string; min_window?: number; max_window?: number }
type Preview = { stock_code: string; as_of: string; current: number | null; previous: number | null; warning: string; chart: IndicatorChart }
type Props = {
  data?: DataStatus | null
  stock: string
  asOf: string
  disabled?: boolean
  onStockChange: (value: string) => void
  onDateChange: (value: string) => void
  onGenerate: (description: string) => void
}

const ema = 'EMA 用首个完整窗口的简单均值初始化，之后按 alpha=2/(N+1) 递推；缺失值中断后重新预热。'
const macd = `DIF=EMA(close,12)-EMA(close,26)，DEA=EMA(DIF,9)，MACD柱=2*(DIF-DEA)。${ema}`
const kdj = 'RSV=(close-LLV(low,N))/(HHV(high,N)-LLV(low,N))*100；高低价相同时 RSV=50。K=(2*前K+RSV)/3，D=(2*前D+K)/3，J=3*K-2*D；K、D 初始值为50，缺失后重新初始化。'
const guides: Record<string, { window: number; explanation: string; formula: string }> = {
  sma: { window: 20, explanation: '观察价格相对近期平均收盘价的位置。', formula: 'SMA=最近 N 个有效收盘价的算术平均；窗口不完整或含缺失值时留空。' },
  ema: { window: 20, explanation: '给近期价格更高权重的均线。', formula: ema },
  rsi: { window: 14, explanation: '观察上涨与下跌的相对强度，通常在0到100之间。', formula: 'RSI=100-100/(1+平均涨幅/平均跌幅)。以首 N 个有效价格差的平均涨跌幅初始化，再按 (前均值*(N-1)+当日涨跌幅)/N 平滑；涨跌幅都为0时取50，仅跌幅为0时取100，仅涨幅为0时取0。缺失后重新预热。' },
  bollinger: { window: 20, explanation: '同时查看布林带上轨、中轨与下轨。', formula: '中轨=SMA(close,N)，上轨=中轨+2*STD(close,N)，下轨=中轨-2*STD(close,N)；标准差使用总体口径 ddof=0。窗口含缺失值时留空。' },
  macd_dif: { window: 9, explanation: '12日与26日指数均线之差。', formula: macd },
  macd_dea: { window: 9, explanation: 'DIF的9日指数平滑值。', formula: macd },
  macd_hist: { window: 9, explanation: 'DIF与DEA之差的两倍，以柱状图显示。', formula: macd },
  kdj_k: { window: 9, explanation: '观察收盘价在近期高低区间的位置并平滑。', formula: kdj },
  kdj_d: { window: 9, explanation: '对K值继续平滑，观察短期动量。', formula: kdj },
  kdj_j: { window: 9, explanation: '放大K与D的差异，数值可能超出0到100。', formula: kdj },
  atr: { window: 14, explanation: '观察价格波动大小，本身不表示涨跌方向。', formula: 'TR=max(high-low,abs(high-前收盘),abs(low-前收盘))；无有效前收盘时取 high-low。ATR 以首 N 个有效 TR 的简单均值初始化，之后按 (前ATR*(N-1)+TR)/N 平滑；缺失后重新预热。' },
}
const fmt = (value: number | null) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })

/** Fixed-formula previews share the conversation's securities and dates. Saving
 * continues through the existing generated-indicator trial/version workflow. */
export default function BuiltinIndicators({ data, stock, asOf, disabled, onStockChange, onDateChange, onGenerate }: Props) {
  const [items, setItems] = useState<Indicator[]>([])
  const [selected, setSelected] = useState('sma')
  const [window, setWindow] = useState(20)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{ key: string; value: Preview } | null>(null)
  const indicator = items.find(item => item.id === selected)
  const guide = guides[selected]
  const maxWindow = indicator?.max_window ?? (selected.startsWith('kdj_') ? 100 : 250)
  const invalid = !/^\d{6}\.(SH|SZ|BJ)$/.test(stock) ? '请输入完整证券代码，例如 000001.SH。'
    : !asOf ? '请选择试算截止日。'
      : data?.last_date && asOf > data.last_date ? '截止日期不能晚于最新行情日期。'
        : !Number.isInteger(window) || window < (indicator?.min_window ?? 2) || window > maxWindow ? `指标周期应在 ${indicator?.min_window ?? 2}–${maxWindow} 之间。` : ''
  const inputKey = JSON.stringify([selected, stock, asOf, window])
  const preview = result?.key === inputKey ? result.value : null

  useEffect(() => {
    const controller = new AbortController()
    setCatalogLoading(true); setCatalogError('')
    api<{ items: Indicator[] }>('/indicators', { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setItems(response.items.filter(item => item.id in guides)) })
      .catch(reason => { if (!controller.signal.aborted) setCatalogError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setCatalogLoading(false) })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    const controller = new AbortController()
    setError(''); setResult(null)
    if (invalid || !indicator) { setBusy(false); return }
    setBusy(true)
    const timer = globalThis.setTimeout(() => {
      api<Preview>('/indicators/preview', { method: 'POST', signal: controller.signal, body: JSON.stringify({ stock_code: stock, indicator: selected, window, field: 'close', as_of: asOf }) })
        .then(value => { if (!controller.signal.aborted) setResult({ key: inputKey, value }) })
        .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
        .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    }, 150)
    return () => { controller.abort(); globalThis.clearTimeout(timer) }
  }, [inputKey, invalid, indicator, retry])

  function generate() {
    if (!preview || !indicator || disabled || invalid || busy) return
    const outputs = selected === 'bollinger' ? '上轨、中轨和下轨' : indicator.name
    onGenerate(`以常用指标“${indicator.name}”（${selected}）创建可保存的数值指标，输出${outputs}。\n${selected.startsWith('macd_') ? '固定快线12日、慢线26日、信号线9日。' : `周期 N=${window} 个交易日。`}\n计算口径：${guide.formula}\n请保持上述初始化、平滑、预热和缺失值口径，并核对生成结果与内置预览的差异。内置预览实际行情日 ${preview.as_of}，当日输出 ${preview.current ?? '缺失'}，前一交易日输出 ${preview.previous ?? '缺失'}${selected === 'bollinger' ? '（此数值为上轨）' : ''}。不同历史输入长度可能影响递推结果，请明确说明。`)
  }

  return <section className="my-indicators-builtins" aria-label="常用指标预览">
    <h3>常用指标</h3>
    <p className="my-indicators-muted">选择常用公式，调整参数并查看行情。需要保存、修改或用于选股时，带入当前对话生成并试算，再确认保存版本。</p>
    {catalogLoading && <LoadingState compact label="正在读取常用指标…" />}
    {catalogError && <div role="alert" className="workspace-error">{catalogError}<button className="text-button workspace-button" onClick={() => setRetry(value => value + 1)}>重试常用指标</button></div>}
    {!catalogLoading && !catalogError && !items.length && <p className="my-indicators-muted">暂无可用常用指标。</p>}
    <div className="my-indicators-inputs">
      <label className="workspace-field-label">常用指标<select aria-label="常用指标" value={selected} disabled={!items.length} onChange={event => { setSelected(event.target.value); setWindow(guides[event.target.value].window) }} className="workspace-field workspace-select">{items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id.toUpperCase().replaceAll('_', ' ')}</option>)}</select></label>
      <label className="workspace-field-label">指标周期<input type="number" aria-label="常用指标周期" value={Number.isNaN(window) ? '' : window} min={indicator?.min_window ?? 2} max={maxWindow} disabled={selected.startsWith('macd_')} onChange={event => setWindow(event.target.value === '' ? NaN : Number(event.target.value))} className="workspace-field" /></label>
      <label className="workspace-field-label">试算证券<StockSearch label="指标试算证券" includeIndices value={stock} onChange={onStockChange} /></label>
      <label className="workspace-field-label">截止日期<input type="date" aria-label="指标试算日期" value={asOf} max={data?.last_date} onChange={event => onDateChange(event.target.value)} className="workspace-field" /></label>
    </div>
    <p className="my-indicators-description">{guide.explanation}</p>
    <details className="my-indicators-source"><summary>查看计算口径</summary><p>{guide.formula}</p></details>
    {invalid && <p role="alert" className="my-indicators-error">{invalid}</p>}
    {error && <div role="alert" className="my-indicators-error">{error}<button className="text-button workspace-button" onClick={() => setRetry(value => value + 1)}>重新试算常用指标</button></div>}
    {busy && <LoadingState label="正在加载 K 线和指标…" skeleton />}
    {preview && <>
      <div className="my-indicators-latest workspace-metric-grid"><div><span>当日数值</span><strong>{fmt(preview.current)}</strong></div><div><span>上一交易日</span><strong>{fmt(preview.previous)}</strong></div><div><span>实际行情日</span><strong>{preview.as_of}</strong></div></div>
      <ResponsiveMarketIndicatorChart chart={preview.chart} />
      <p className="my-indicators-muted">{preview.stock_code} · 最近最多120个交易日的图表 · {preview.warning}</p>
    </>}
    <button type="button" className="primary-button workspace-button" disabled={disabled || busy || !!invalid || !preview || !!catalogError} onClick={generate}>带入对话生成可保存版本<ArrowRight size={14} /></button>
  </section>
}
