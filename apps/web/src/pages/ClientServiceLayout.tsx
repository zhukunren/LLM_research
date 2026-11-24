import { useRef, useState, type ComponentProps, type FormEventHandler, type ReactNode, type Ref } from 'react'
import { Eye, FilePenLine, LoaderCircle, Sparkles } from 'lucide-react'
import ClientGenerationFocus from '../components/ClientGenerationFocus'
import ModelModeSwitch from '../components/ModelModeSwitch'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import type { ModelMode } from '../modelSelection'
import { clientServiceMenus, type ServiceView } from '../navigation'
import './client-service.css'

type Pane = 'edit' | 'preview'

export default function ClientServiceLayout({ view, pageRef, ariaLabel, actions, children }: {
  view: ServiceView; pageRef?: Ref<HTMLDivElement>; ariaLabel?: string; actions?: ReactNode; children: ReactNode
}) {
  const title = clientServiceMenus.find(item => item.id === view)!.label
  return <div ref={pageRef} className="page-content workspace-tool-page client-service-page"
    data-service-view={view} role="region" aria-label={ariaLabel ?? `${title}工作区`} tabIndex={0}>
    <WorkspacePageHeading actions={actions}><h1>{title}</h1></WorkspacePageHeading>
    {children}
  </div>
}

export function useClientServicePane() {
  const pageRef = useRef<HTMLDivElement>(null)
  const scroll = useRef({ edit: 0, preview: 0 })
  const current = useRef<Pane>('edit')
  const [pane, setPane] = useState<Pane>('edit')

  function switchPane(next: Pane) {
    if (next === current.current) return
    const page = pageRef.current
    if (page) scroll.current[current.current] = page.scrollTop
    current.current = next
    setPane(next)
    requestAnimationFrame(() => {
      if (page?.isConnected && current.current === next) page.scrollTop = scroll.current[next]
    })
  }

  return { pageRef, pane, switchPane }
}

export function ClientServiceStudio({ pane, onChange, label, showSwitch = true, children }: {
  pane: Pane; onChange: (pane: Pane) => void; label: string; showSwitch?: boolean; children: ReactNode
}) {
  return <>
    {showSwitch && <div className="client-pane-bar">
      <div className="client-mobile-pane-switch" role="group" aria-label={label}>
        <button type="button" className="workspace-button" aria-pressed={pane === 'edit'} onClick={() => onChange('edit')}>
          <FilePenLine size={17} aria-hidden="true" />编辑
        </button>
        <button type="button" className="workspace-button" aria-pressed={pane === 'preview'} onClick={() => onChange('preview')}>
          <Eye size={17} aria-hidden="true" />预览
        </button>
      </div>
    </div>}
    <div className="client-service-studio" data-mobile-pane={showSwitch ? pane : 'edit'}>{children}</div>
  </>
}

export function ClientServiceEditor({ label, title, actions, generation, footer, onSubmit, children }: {
  label: string; title: string; actions?: ReactNode; generation?: ReactNode; footer?: ReactNode
  onSubmit?: FormEventHandler<HTMLFormElement>; children: ReactNode
}) {
  const Panel = onSubmit ? 'form' : 'section'
  return <Panel className="client-card-editor" aria-label={label} onSubmit={onSubmit}>
    <header className="client-panel-heading"><h2>{title}</h2>{actions}</header>
    <div className="client-editor-body">{generation}{children}</div>
    {footer && <footer className="client-editor-footer">{footer}</footer>}
  </Panel>
}

export function ClientServiceGeneration({ mode, onModeChange, focus, canGenerate, busy, locked, onGenerate, progress }: {
  mode: ModelMode; onModeChange: (mode: ModelMode) => void
  focus: Omit<ComponentProps<typeof ClientGenerationFocus>, 'disabled'>
  canGenerate: boolean; busy?: boolean; locked?: boolean; onGenerate?: () => void; progress?: ReactNode
}) {
  const disabled = busy || locked
  return <div className="client-generation-controls">
    <ModelModeSwitch value={mode} disabled={disabled} onChange={onModeChange} />
    <button type={onGenerate ? 'button' : 'submit'} className="primary-button workspace-button"
      disabled={disabled || !canGenerate} aria-busy={busy || undefined} onClick={onGenerate}>
      {busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}AI生成
    </button>
    <ClientGenerationFocus {...focus} disabled={disabled} />
    {progress && <div className="client-generation-progress">{progress}</div>}
  </div>
}

export function ClientServicePreview({ label, title, toolbar, meta, actions, status, themes, busy, children }: {
  label: string; title: string; toolbar?: ReactNode; meta?: ReactNode; actions: ReactNode; status?: ReactNode
  themes?: ReactNode; busy?: boolean; children: ReactNode
}) {
  return <section className="client-preview-workspace" aria-label={label}>
    <section className="client-preview-panel" aria-label={title} aria-busy={busy}>
      <header className="client-preview-header">
        <div className="client-panel-heading">
          <h2>{title}</h2>
          {toolbar && <div className="client-preview-toolbar">{toolbar}</div>}
        </div>
        {meta && <div className="client-preview-meta">{meta}</div>}
      </header>
      <div className="client-preview-body">{children}</div>
      <footer className="client-export-bar">{status}<div className="client-export-actions">{actions}</div></footer>
    </section>
    {themes}
  </section>
}
