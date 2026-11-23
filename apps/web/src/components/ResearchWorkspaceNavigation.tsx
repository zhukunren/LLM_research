import { useEffect, useId, useRef, useState } from 'react'
import { Bookmark, ChartNoAxesCombined, ChevronDown, FlaskConical, GitBranch, History, Library, SlidersHorizontal } from 'lucide-react'
import type { WorkflowType } from '../api'
import type { PageId } from '../navigation'
import type { ScreeningView } from '../workspaceRoute'
import type { ScreeningMethod } from '../screeningMethods'

const managementTools = [
  { view: 'library', label: '条件库', description: '维护可复用的单条条件', icon: Library },
  { view: 'saved', label: '管理方案', description: '查看和编辑已保存的方案版本', icon: Bookmark },
  { view: 'history', label: '筛选记录', description: '跨任务查找筛选批次和结果', icon: History },
] as const

export default function ResearchWorkspaceNavigation({ compact = false, showTaskTypes, workspace, page, view = 'conversation', screeningMethod, onTaskTypeChange, onScreeningView, onFixedRules, onPatternSamples }: {
  compact?: boolean; showTaskTypes: boolean; workspace: WorkflowType; page: PageId; view?: ScreeningView
  screeningMethod?: ScreeningMethod
  onTaskTypeChange: (workflow: WorkflowType) => void
  onScreeningView: (view: 'saved' | 'history' | 'compose' | 'library') => void
  onFixedRules: () => void
  onPatternSamples: () => void
}) {
  const [open, setOpen] = useState(false)
  const navigation = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const currentView = page === 'conditions' ? (view === 'create' ? 'library' : view) : undefined

  useEffect(() => { setOpen(false) }, [showTaskTypes, workspace, page, view, screeningMethod])
  useEffect(() => {
    if (!open) return
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !navigation.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismissOutside)
    return () => document.removeEventListener('pointerdown', dismissOutside)
  }, [open])

  function closeTools() {
    setOpen(false)
    trigger.current?.focus()
  }

  return <div className="research-workspace-navigation">
    {showTaskTypes && <div className="research-workflow-switch" role="group" aria-label="研究任务类型">
      <button type="button" className="workspace-button" aria-pressed={page === 'screening'} onClick={() => onTaskTypeChange('research')}>研究对话</button>
      <button type="button" className="workspace-button" aria-pressed={page === 'conditions'} onClick={() => onTaskTypeChange('screening')}>选股对话</button>
    </div>}
    {workspace === 'screening' && <nav ref={navigation} className="screening-tools-navigation" aria-label="选股工具" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }} onKeyDown={event => {
      if (!open || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeTools()
    }}>
      <button ref={trigger} type="button" className="workspace-button screening-tools-trigger" aria-label="选股工具" aria-controls={panelId} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <SlidersHorizontal size={compact ? 18 : 15} aria-hidden="true" />{compact ? <span className="screening-tools-compact-label">工具</span> : <>选股工具<ChevronDown size={14} aria-hidden="true" /></>}
      </button>
      <div id={panelId} className="screening-tools-popover" hidden={!open}>
        <div className="screening-tools-section" role="group" aria-label="条件工具">
          <span className="screening-tools-caption" aria-hidden="true">条件工具</span>
          <button type="button" className="workspace-button screening-tool-option" aria-label="组合选股" aria-current={currentView === 'compose' ? 'page' : undefined} onClick={() => { closeTools(); onScreeningView('compose') }}>
            <GitBranch size={16} aria-hidden="true" /><span><strong>组合选股</strong><small>编排多条条件和筛选逻辑</small></span>
          </button>
          <button type="button" className="workspace-button screening-tool-option" aria-label="固定规则与试算" aria-haspopup="dialog" onClick={() => { closeTools(); onFixedRules() }}>
            <FlaskConical size={16} aria-hidden="true" /><span><strong>固定规则与试算</strong><small>核对指标参数和单股计算</small></span>
          </button>
          <button type="button" className="workspace-button screening-tool-option" aria-label="选取形态样本" aria-current={screeningMethod === 'pattern' ? 'page' : undefined} onClick={() => { closeTools(); onPatternSamples() }}>
            <ChartNoAxesCombined size={16} aria-hidden="true" /><span><strong>选取形态样本</strong><small>截取 K 线、上传截图或绘图</small></span>
          </button>
        </div>
        <div className="screening-tools-section" role="group" aria-label="管理与回看">
          <span className="screening-tools-caption" aria-hidden="true">管理与回看</span>
          {managementTools.map(({ view, label, description, icon: Icon }) => (
            <button type="button" key={view} className="workspace-button screening-tool-option" aria-label={label} aria-current={currentView === view ? 'page' : undefined} onClick={() => { closeTools(); onScreeningView(view) }}>
              <Icon size={16} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span>
            </button>
          ))}
        </div>
      </div>
    </nav>}
  </div>
}
