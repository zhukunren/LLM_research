export const chartPalette = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif',
  text: '#242424', muted: '#666666', faint: '#777777', border: '#e5e5e5', grid: '#eeeeee', surface: '#ffffff',
  primary: '#00337a', soft: '#edf3fa', line: '#32839b', up: '#be414a', down: '#208575',
}

export function chartAxisValue(value: number) {
  if (!Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 1e8) return `${Number((value / 1e8).toFixed(2))}亿`
  if (absolute >= 1e4) return `${Number((value / 1e4).toFixed(2))}万`
  if (absolute > 0 && absolute < 1e-4) return value.toExponential(2)
  return Number(value.toFixed(absolute < 1 ? 4 : 2)).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}
