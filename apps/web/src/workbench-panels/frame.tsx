import { createRoot } from 'react-dom/client'
import WorkspacePanelDeck, { completeDeck, type SnapshotDeckData } from './WorkspacePanelDeck'
import type { SnapshotPanelData } from './WorkspaceSnapshotPanel'
import catalog from './catalog.json'
import '../tokens.css'
import '../data-surfaces.css'
import '../control-states.css'
import '../pages/observation-toolbar.css'
import './frame.css'

const mount = document.getElementById('workbench-panel')
const seed = document.getElementById('workbench-panel-data')
if (mount && seed) {
  try {
    const data = JSON.parse(seed.textContent ?? '') as SnapshotPanelData | SnapshotDeckData
    const panels = 'panels' in data ? data.panels : [data]
    if (!Array.isArray(panels) || !panels.every(panel => Object.hasOwn(catalog, panel.panel) && Array.isArray(panel.rows) && Number.isFinite(panel.total))) {
      throw new Error('Invalid panel data')
    }
    if (!panels.some(panel => panel.panel === data.panel)) throw new Error('Missing active panel')
    createRoot(mount).render(<WorkspacePanelDeck data={completeDeck({ panel: data.panel, panels })} />)
  } catch {
    mount.textContent = '面板数据无法读取，请重新打开面板。'
  }
}
