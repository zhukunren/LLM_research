import { describe, expect, it } from 'vitest'
import { fitKairosDesktopFrame, getKairosDesktopFrameUrl } from './kairosDesktopViewport'

const site = 'https://workbench.test/?lang=zh#/observation'
const kairos = 'Mozilla/5.0 开阳同智/1.1.1 Chrome/126.0 Electron/31.7.7'

describe('Kairos desktop viewport', () => {
  it('keeps the address and route when creating the desktop browsing context', () => {
    expect(getKairosDesktopFrameUrl(site, kairos)).toBe('https://workbench.test/?lang=zh&llmr_desktop_frame=1#/observation')
    expect(getKairosDesktopFrameUrl(site, kairos.replace('开阳同智', '????'))).toContain('llmr_desktop_frame=1')
  })

  it('mounts the ordinary Web app inside its desktop frame', () => {
    expect(getKairosDesktopFrameUrl(getKairosDesktopFrameUrl(site, kairos)!, kairos)).toBeNull()
  })

  it('leaves normal phone browsers and other desktop apps on the ordinary entry', () => {
    expect(getKairosDesktopFrameUrl(site, 'Mozilla/5.0 (Linux; Android 15) Chrome/126.0 Mobile Safari/537.36')).toBeNull()
    expect(getKairosDesktopFrameUrl(site, 'Mozilla/5.0 ExampleApp/1.1.1 Electron/31.7.7')).toBeNull()
  })

  it('fits the desktop viewport into a narrow preview without changing its layout width', () => {
    expect(fitKairosDesktopFrame(560, 760)).toEqual({ width: 1280, height: 1738, scale: 0.4375 })
    expect(fitKairosDesktopFrame(1440, 960)).toEqual({ width: 1440, height: 960, scale: 1 })
  })
})
