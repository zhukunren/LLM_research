const desktopFrameParameter = 'llmr_desktop_frame'
const desktopWidth = 1280

export function getKairosDesktopFrameUrl(href: string, userAgent: string): string | null {
  // Kairos reports its Chinese app name, which some environments replace with question marks.
  if (!/Electron\//i.test(userAgent) || !/(?:开阳同智|\?{4})\/\d/.test(userAgent)) return null
  const url = new URL(href)
  if (url.searchParams.get(desktopFrameParameter) === '1') return null
  url.searchParams.set(desktopFrameParameter, '1')
  return url.toString()
}

export function fitKairosDesktopFrame(availableWidth: number, availableHeight: number) {
  const width = Math.max(availableWidth, desktopWidth)
  const scale = availableWidth / width
  return { width, height: Math.ceil(availableHeight / scale), scale }
}
