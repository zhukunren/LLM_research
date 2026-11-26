import { useLayoutEffect, useRef, useState } from 'react'
import { fitKairosDesktopFrame } from '../kairosDesktopViewport'

export default function KairosDesktopViewport({ address }: { address: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState<ReturnType<typeof fitKairosDesktopFrame> | null>(null)

  useLayoutEffect(() => {
    const element = viewport.current!
    function fit() {
      const { clientWidth, clientHeight } = element
      if (clientWidth > 0 && clientHeight > 0) setFrame(fitKairosDesktopFrame(clientWidth, clientHeight))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return <div className="kairos-desktop-viewport" role="region" aria-label="投研工作台桌面布局" ref={viewport}>
    {frame && <iframe src={address} title="投研工作台（桌面版）"
      style={{ width: frame.width, height: frame.height, transform: `scale(${frame.scale})` }} />}
  </div>
}
