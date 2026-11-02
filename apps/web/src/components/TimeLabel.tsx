function parsedTime(value: string): Date | null {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  // Date normalizes e.g. February 30; do not present that as a real timestamp.
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (day) {
    const year = Number(day[1]), month = Number(day[2]), number = Number(day[3])
    const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (month < 1 || month > 12 || number < 1 || number > days[month - 1]) return null
  }
  return date
}

/** Display dates in the viewer's actual zone (or an explicitly requested zone). */
export function fullTimeDescription(value: string, timeZone?: string): string {
  const date = parsedTime(value)
  if (!date) return '时间不可用'
  const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'longOffset' })
  return `${formatter.format(date)}（${formatter.resolvedOptions().timeZone}）`
}

export default function TimeLabel({ value, timeZone, focusable = true, hour12 }: { value: string; timeZone?: string; focusable?: boolean; hour12?: boolean }) {
  const date = parsedTime(value)
  const detail = fullTimeDescription(value, timeZone)
  const short = date ? date.toLocaleString('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(hour12 === undefined ? {} : { hour12 }) }) : '—'
  return <time dateTime={date ? date.toISOString() : undefined} tabIndex={focusable ? 0 : undefined} aria-label={detail} data-tooltip={detail}>{short}</time>
}
