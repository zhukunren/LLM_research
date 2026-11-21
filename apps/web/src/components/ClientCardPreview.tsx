import { useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Download, FileText, Image } from 'lucide-react'
import ConditionWorkspaceDrawer from './ConditionWorkspaceDrawer'

export type CardPreviewMode = 'image' | 'text'
type StepTheme = (direction: -1 | 1) => void

export function ClientCardPreviewSwitch({ mode, onChange }: { mode: CardPreviewMode; onChange: (mode: CardPreviewMode) => void }) {
  return <div className="client-preview-switch" role="group" aria-label="预览方式">
    <button type="button" className="workspace-button" aria-pressed={mode === 'image'} onClick={() => onChange('image')}><Image size={15} />图片</button>
    <button type="button" className="workspace-button" aria-pressed={mode === 'text'} onClick={() => onChange('text')}><FileText size={15} />文案</button>
  </div>
}

export function ClientCardImageStage({ pending, onStep, children }: { pending: boolean; onStep: StepTheme; children: ReactNode }) {
  return <div className="client-preview-stage">
    <button type="button" className="workspace-button client-theme-arrow client-theme-previous" aria-label="上一套底图" title="切换上一套底图" onClick={() => onStep(-1)}><ChevronLeft size={22} /></button>
    <div className="client-card-canvas" aria-busy={pending}>{children}</div>
    <button type="button" className="workspace-button client-theme-arrow client-theme-next" aria-label="下一套底图" title="切换下一套底图" onClick={() => onStep(1)}><ChevronRight size={22} /></button>
  </div>
}

export function ClientCardFullscreen({ title, description, theme, downloadLabel, canDownload, onDownload, onStep, onClose, children }: {
  title: string; description: string; theme: string; downloadLabel: string; canDownload: boolean
  onDownload: () => void; onStep: StepTheme; onClose: () => void; children: (mode: 'fit' | 'read') => ReactNode
}) {
  const [reading, setReading] = useState(false)
  return <ConditionWorkspaceDrawer title={title} description={description} closeLabel="退出全屏预览" className="client-card-fullscreen" onClose={onClose}
    footer={<>
      <div className="client-fullscreen-themes">
        <button type="button" className="workspace-button" onClick={() => onStep(-1)}><ChevronLeft size={17} />上一套</button>
        <span>{theme}</span>
        <button type="button" className="workspace-button" onClick={() => onStep(1)}>下一套<ChevronRight size={17} /></button>
      </div>
      <div className="client-fullscreen-actions">
        <button type="button" className="workspace-button" aria-pressed={reading} onClick={() => setReading(value => !value)}>{reading ? '适应窗口' : '放大阅读'}</button>
        <button type="button" className="workspace-button" disabled={!canDownload} onClick={onDownload}><Download size={15} />{downloadLabel}</button>
      </div>
    </>}>
    <div className={`client-fullscreen-canvas${reading ? ' is-reading' : ''}`}>{children(reading ? 'read' : 'fit')}</div>
  </ConditionWorkspaceDrawer>
}
