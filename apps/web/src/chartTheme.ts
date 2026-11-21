export const chartPalette = {
  fontFamily: 'system-ui, "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif',
  text: '#18273A', muted: '#43566C', faint: '#586B81', border: '#DCE4EC', grid: '#E8EDF3', surface: '#FFFFFF',
  primary: '#004A99', soft: '#E8F2FB', line: '#326E89', up: '#AA3442', down: '#176451',
}

export function chartAxisValue(value: number) {
  if (!Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 1e8) return `${Number((value / 1e8).toFixed(2))}亿`
  if (absolute >= 1e4) return `${Number((value / 1e4).toFixed(2))}万`
  if (absolute > 0 && absolute < 1e-4) return value.toExponential(2)
  return Number(value.toFixed(absolute < 1 ? 4 : 2)).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}
