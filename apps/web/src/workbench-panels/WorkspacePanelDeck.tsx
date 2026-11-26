import { useState } from 'react'
import { LayoutDashboard } from 'lucide-react'
import { workspaceMenus, type PageId } from '../navigation'
import WorkspaceSnapshotPanel, { type SnapshotPanelData } from './WorkspaceSnapshotPanel'
import catalog from './catalog.json'

const navigation: Record<keyof typeof catalog, PageId> = {
  projects: 'home', research: 'screening', 'screening-plans': 'conditions', 'screening-runs': 'conditions',
  conditions: 'conditions', observation: 'watchlist', intelligence: 'intelligence', reports: 'reports',
  news: 'news', patterns: 'patterns', 'daily-signals': 'daily-signals', 'client-service': 'client-service', 'data-status': 'data-download',
}

export type SnapshotDeckData = { panel: string; panels: SnapshotPanelData[] }

export function completeDeck(data: SnapshotDeckData): SnapshotDeckData {
  const available = new Map(data.panels.map(panel => [panel.panel, panel]))
  return {
    panel: data.panel,
    panels: Object.keys(catalog).map(panel => available.get(panel) ?? { panel, rows: [], total: 0, unavailable: true, notice: '请在对话中重新打开该面板以读取数据。' }),
  }
}

export default function WorkspacePanelDeck({ data }: { data: SnapshotDeckData }) {
  const [selected, setSelected] = useState(data.panel)
  const [visited, setVisited] = useState(() => new Set([data.panel]))
  function open(panel: string) {
    setVisited(current => current.has(panel) ? current : new Set([...current, panel]))
    setSelected(panel)
  }
  return <div className="snapshot-deck">
    <aside className="snapshot-sidebar">
      <strong className="snapshot-sidebar-title">投研工作台</strong>
      <nav aria-label="工作台面板">
        {data.panels.map(({ panel }) => {
          const id = panel as keyof typeof catalog
          const Icon = workspaceMenus.find(item => item.id === navigation[id])?.icon ?? LayoutDashboard
          return <button key={id} type="button" className="snapshot-sidebar-button workspace-button"
            aria-current={selected === id ? 'page' : undefined} onClick={() => open(id)}>
            <Icon size={15} aria-hidden="true" /><span>{catalog[id].title}</span>
          </button>
        })}
      </nav>
    </aside>
    <div className="snapshot-deck-content">
      {data.panels.filter(({ panel }) => visited.has(panel)).map(panel =>
        <section key={panel.panel} hidden={selected !== panel.panel}>
          <WorkspaceSnapshotPanel data={panel} active={selected === panel.panel} />
        </section>,
      )}
    </div>
  </div>
}
