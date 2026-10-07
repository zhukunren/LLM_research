import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { api } from '../../api'
import type { ResearchProjectSummary } from '../../research'

export default function ProjectMembership({ conversationId, projectId, disabled, onChange, onError, onOpenProject }: {
  conversationId: string; projectId?: string | null; disabled: boolean
  onChange: (id: string | null) => void; onError: (message: string) => void
  onOpenProject?: (id: string) => void
}) {
  const [projects, setProjects] = useState<ResearchProjectSummary[]>([])
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoadError(false)
    api<{ items: ResearchProjectSummary[] }>('/research-projects', { signal: controller.signal })
      .then(result => setProjects(result.items)).catch(() => { if (!controller.signal.aborted) setLoadError(true) })
    return () => controller.abort()
  }, [conversationId, projectId, reload])
  async function change(next: string) {
    setSaving(true)
    try {
      await api(`/conversations/${conversationId}/project`, { method: 'PATCH', body: JSON.stringify({ project_id: next || null }) })
      onChange(next || null)
    } catch (reason) { onError((reason as Error).message) }
    finally { setSaving(false) }
  }
  return <div className="project-membership">
    <FolderOpen size={15} aria-hidden="true" />
    <select aria-label="所属研究项目" value={projectId || ''} disabled={disabled || saving || loadError} onChange={event => void change(event.target.value)}>
      <option value="">未归入项目</option>
      {projectId && !projects.some(item => item.id === projectId) && <option value={projectId}>当前研究项目</option>}
      {projects.filter(item => item.status === 'active' || item.id === projectId).map(item => <option key={item.id} value={item.id}>{item.name}{item.status === 'archived' ? '（已归档）' : ''}</option>)}
    </select>
    {loadError ? <button className="text-button" onClick={() => setReload(value => value + 1)}>重试项目列表</button>
      : projectId && onOpenProject && <button className="text-button" onClick={() => onOpenProject(projectId)}>查看项目</button>}
  </div>
}
