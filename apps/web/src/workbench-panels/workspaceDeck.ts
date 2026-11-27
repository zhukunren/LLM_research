import brandSymbol from '../../public/brand/soochow-symbol-blue.png?inline'
import definitions from './catalog.json'
import type { SnapshotPanelData } from './snapshotPresentation'

type PanelKey = keyof typeof definitions
export type PanelMount = (target: HTMLElement, data: SnapshotPanelData) => void
type DeckData = { panel: string; panels: SnapshotPanelData[] }
type WorkspaceTab = {
  item: HTMLDivElement; button: HTMLButtonElement; close: HTMLButtonElement; pane: HTMLElement
}

const groups: ReadonlyArray<{ label: string; keys: readonly PanelKey[] }> = [
  { label: '研究', keys: ['projects', 'research', 'observation'] },
  { label: '选股工具', keys: ['screening-plans', 'screening-runs', 'conditions', 'patterns'] },
  { label: '资料库', keys: ['intelligence', 'reports', 'news'] },
  { label: '服务', keys: ['daily-signals', 'client-service', 'data-status'] },
]
const shortLabels: Partial<Record<PanelKey, string>> = { 'client-service': '对客服务', 'data-status': '数据与服务' }

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag)
  node.textContent = text
  node.className = className
  return node
}

function mountDeck(host: HTMLElement, data: DeckData, mountPanel: PanelMount) {
  const snapshots = new Map(data.panels.map(panel => [panel.panel, panel]))
  const deck = element('div', '', 'snapshot-deck')
  const sidebar = element('aside', '', 'snapshot-sidebar')
  const identity = element('div', '', 'snapshot-brand')
  const symbol = element('img')
  symbol.src = brandSymbol
  symbol.alt = ''
  const name = element('div')
  name.append(element('strong', '东吴证券'), element('small', 'SOOCHOW SECURITIES'))
  identity.append(symbol, name)
  const search = element('input')
  search.type = 'search'
  search.placeholder = '搜索面板'
  search.setAttribute('aria-label', search.placeholder)
  const searchField = element('label', '', 'snapshot-nav-search')
  searchField.append(search)
  const nav = element('nav')
  nav.setAttribute('aria-label', '工作台面板')
  const empty = element('p', '未找到面板', 'snapshot-nav-empty')
  empty.hidden = true
  sidebar.append(identity, element('p', '张家港营业部投研工作台', 'snapshot-workspace-name'), searchField, nav)

  const workspace = element('div', '', 'snapshot-workspace')
  const tabBar = element('header', '', 'workspace-tab-bar')
  const tabList = element('div', '', 'workspace-tab-list')
  tabList.setAttribute('role', 'tablist')
  tabList.setAttribute('aria-label', '工作台标签')
  tabBar.append(tabList)
  const content = element('div', '', 'snapshot-deck-content')
  workspace.append(tabBar, content)
  deck.append(sidebar, workspace)
  host.replaceChildren(deck)

  const menu = new Map<PanelKey, HTMLButtonElement>()
  const tabs = new Map<PanelKey, WorkspaceTab>()
  let selected: PanelKey | undefined

  function update(tab: WorkspaceTab, active: boolean) {
    tab.item.dataset.active = String(active)
    tab.button.setAttribute('aria-selected', String(active))
    tab.button.tabIndex = active ? 0 : -1
    tab.pane.hidden = !active
  }

  function updateCloseButtons() {
    for (const tab of tabs.values()) tab.close.hidden = tabList.childElementCount < 2
  }

  function closeTab(key: PanelKey) {
    const tab = tabs.get(key)!
    if (tabList.childElementCount < 2) return
    const neighbour = tab.item.nextElementSibling ?? tab.item.previousElementSibling
    tab.item.remove()
    updateCloseButtons()
    if (selected === key) neighbour?.querySelector<HTMLButtonElement>('[role=tab]')?.click()
    if (selected) tabs.get(selected)?.button.focus()
  }

  function open(key: PanelKey) {
    if (selected === key) return
    if (selected) {
      update(tabs.get(selected)!, false)
      menu.get(selected)?.removeAttribute('aria-current')
    }
    let tab = tabs.get(key)
    if (!tab) {
      const title = definitions[key].title
      const item = element('div', '', 'workspace-tab-item')
      const button = element('button')
      button.type = 'button'
      button.id = 'snapshot-tab-' + key
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-controls', 'snapshot-panel-' + key)
      button.setAttribute('aria-label', title)
      button.append(element('span', shortLabels[key] ?? title))
      button.addEventListener('click', () => open(key))
      const close = element('button', '×', 'workspace-tab-close')
      close.type = 'button'
      close.setAttribute('aria-label', '关闭' + title + '标签')
      close.addEventListener('click', () => closeTab(key))
      item.append(button, close)
      const pane = element('section', '', 'snapshot-pane')
      pane.id = 'snapshot-panel-' + key
      pane.setAttribute('role', 'tabpanel')
      pane.setAttribute('aria-labelledby', button.id)
      content.append(pane)
      mountPanel(pane, snapshots.get(key) ?? {
        panel: key, rows: [], total: 0, unavailable: true, notice: '可发送「刷新面板」读取数据。',
      })
      tab = { item, button, close, pane }
      tabs.set(key, tab)
    }
    if (!tab.item.isConnected) tabList.append(tab.item)
    selected = key
    update(tab, true)
    updateCloseButtons()
    menu.get(key)?.setAttribute('aria-current', 'page')
    tab.item.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  tabList.addEventListener('keydown', event => {
    const buttons = [...tabList.querySelectorAll<HTMLButtonElement>('[role=tab]')]
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!step && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next = event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons.at(-1)
      : buttons[(index + step + buttons.length) % buttons.length]
    next?.click()
    next?.focus()
  })

  const sections = groups.map(group => {
    const section = element('div', '', 'snapshot-nav-group')
    section.append(element('h2', group.label))
    for (const key of group.keys) {
      const title = definitions[key].title
      const button = element('button', shortLabels[key] ?? title, 'snapshot-sidebar-button')
      button.type = 'button'
      button.setAttribute('aria-label', title)
      button.addEventListener('click', () => open(key))
      menu.set(key, button)
      section.append(button)
    }
    nav.append(section)
    return { section, group }
  })
  nav.append(empty)
  search.addEventListener('input', () => {
    const term = search.value.trim().toLocaleLowerCase('zh-CN')
    for (const { section, group } of sections) {
      for (const key of group.keys) {
        menu.get(key)!.hidden = !definitions[key].title.toLocaleLowerCase('zh-CN').includes(term)
      }
      section.hidden = group.keys.every(key => menu.get(key)!.hidden)
    }
    empty.hidden = sections.some(({ section }) => !section.hidden)
  })
  search.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    const first = [...menu.values()].find(button => !button.hidden)
    first?.click()
    first?.focus()
  })
  deck.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault()
      search.focus()
    }
  })
  open(data.panel as PanelKey)
}

export function startSnapshotDeck(mountPanel: PanelMount) {
  const host = document.getElementById('workbench-panel')
  if (!host) return
  try {
    const data = JSON.parse(document.getElementById('workbench-panel-data')?.textContent ?? '') as DeckData | SnapshotPanelData
    const panels = 'panels' in data ? data.panels : [data]
    if (!Object.hasOwn(definitions, data.panel) || !Array.isArray(panels) ||
        !panels.every(panel => Object.hasOwn(definitions, panel.panel) && Array.isArray(panel.rows) && Number.isFinite(panel.total))) {
      throw new Error('Invalid panel data')
    }
    mountDeck(host, { panel: data.panel, panels }, mountPanel)
  } catch {
    host.textContent = '面板数据无法读取，请刷新面板。'
  }
}
