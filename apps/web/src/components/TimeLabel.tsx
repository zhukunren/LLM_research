import { fullTimeDescription, parsedTime, shortTime } from '../timeLabels'

export { fullTimeDescription } from '../timeLabels'

export default function TimeLabel({ value, timeZone, focusable = true, hour12 }: { value: string; timeZone?: string; focusable?: boolean; hour12?: boolean }) {
  const date = parsedTime(value)
  const detail = fullTimeDescription(value, timeZone)
  const short = shortTime(date, timeZone, hour12)
  return <time dateTime={date ? date.toISOString() : undefined} tabIndex={focusable ? 0 : undefined} aria-label={detail} data-tooltip={detail}>{short}</time>
}
