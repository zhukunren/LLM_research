import { useEffect, useId, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { useSecurities } from '../StockSearch'
import { useSessionState } from '../../useSessionState'
import { useWorkspaceSession } from '../../WorkspaceSession'
import CompanyCommandMenu, { type CompanyCommandOption } from './CompanyCommandMenu'
import CompanyCommandDialog from './CompanyCommandDialog'
import { companyCommands, companyQuestion, matchCommandCompanies, parseCompanyCommand, type CommandCompany, type CompanyCommand, type CompanyCommandKind } from './companyCommands'
import './company-commands.css'

type Companies = Record<string, CommandCompany | null>
const validCompanies = (value: unknown): value is Companies => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every(item => item === null || item && typeof item === 'object'
    && typeof item.name === 'string' && typeof item.stock_code === 'string' && /^\d{6}\.(SH|SZ|BJ)$/.test(item.stock_code))

export function useCompanyCommands({ enabled, disabled, draft, contextKey, anchor, onChange }: {
  enabled: boolean; disabled: boolean; draft: string; contextKey: string; anchor: RefObject<HTMLTextAreaElement>; onChange: (value: string) => void
}) {
  const catalog = useSecurities(), session = useWorkspaceSession(), id = useId()
  const [companies, setCompanies] = useSessionState<Companies>('conversation.commandCompanies', {}, validCompanies)
  const company = companies[contextKey] ?? null
  const [cursor, setCursor] = useState(0), [focused, setFocused] = useState(false), [dismissed, setDismissed] = useState('')
  const [opened, setOpened] = useState<{ company: CommandCompany; kind: Exclude<CompanyCommandKind, 'company'> } | null>(null)
  const parsed = useMemo(() => enabled ? parseCompanyCommand(draft) : null, [enabled, draft])
  const queryKey = contextKey + ':' + draft
  const menuOpen = !!parsed && session.active && focused && !disabled && dismissed !== queryKey && !opened
  const matches = useMemo(() => parsed?.stage === 'company'
    ? parsed.query ? matchCommandCompanies(catalog.items, parsed.query) : company ? [company] : []
    : [], [parsed, catalog.items, company])
  useEffect(() => { setCursor(0) }, [draft, contextKey])
  useEffect(() => { setOpened(null); setDismissed('') }, [contextKey, session.active])
  function focus() { anchor.current?.focus() }
  function complete(command: CompanyCommand) {
    onChange('/' + command.name + ' '); setCursor(0); setDismissed(''); focus()
  }
  function execute(command: CompanyCommand, selected: CommandCompany) {
    if (disabled || !session.active) return
    if (command.kind === 'company') setCompanies(current => ({ ...current, [contextKey]: selected }))
    else setOpened({ company: selected, kind: command.kind })
    onChange(''); setDismissed(''); setCursor(0)
    if (command.kind === 'company') focus()
  }
  const options: CompanyCommandOption[] = parsed?.stage === 'command'
    ? parsed.commands.map(command => ({ id: command.kind, label: '/' + command.name + ' · ' + command.label, detail: command.description, choose: () => complete(command) }))
    : parsed?.stage === 'company' && !parsed.multiline
      ? matches.map(item => ({ id: item.stock_code, label: item.name, detail: item.stock_code + ' · ' + parsed.command.label, choose: () => execute(parsed.command, item) }))
      : []
  const selected = Math.min(cursor, Math.max(0, options.length - 1))
  let message = ''
  if (!message && parsed?.stage === 'company') {
    message = parsed.multiline ? '请将命令和一家公司放在同一行。'
      : catalog.error ? '公司列表暂时无法读取，请重试。'
      : catalog.loading ? '正在读取公司列表…'
      : !parsed.query && !company ? '输入公司名称、六位股票代码或完整代码，例如：贵州茅台、600519、600519.SH。'
      : !matches.length ? '没有匹配的公司，请检查名称或股票代码。'
      : !parsed.query ? '将使用当前公司，也可以继续输入其他公司。' : ''
  }
  if (!message && parsed?.stage === 'command' && !options.length) message = '未找到命令，可输入 ' + companyCommands.map(command => '/' + command.name).join('、') + '。'
  function submit(value: string) {
    const command = enabled ? parseCompanyCommand(value) : null
    if (!command) return false
    if (disabled || !session.active) return true
    setFocused(true); setDismissed('')
    if (value === draft && options[selected]) options[selected].choose()
    else if (command.stage === 'command') {
      if (command.commands.length === 1) complete(command.commands[0])
    } else if (!command.multiline) {
      const choices = command.query ? matchCommandCompanies(catalog.items, command.query) : company ? [company] : []
      if (choices.length) execute(command.command, choices[0])
    }
    return true
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!menuOpen) return false
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(queryKey); return true }
    if (!options.length) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setCursor((selected + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length); return true
    }
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      if (parsed?.stage === 'company' && matches[selected]) { onChange('/' + parsed.command.name + ' ' + matches[selected].stock_code); setCursor(0) }
      else options[selected].choose()
      return true
    }
    return false
  }
  function move(from: string, to: string) {
    if (from === to) return
    setCompanies(current => {
      if (!(from in current)) return current
      const next = { ...current, [to]: current[from] }; delete next[from]; return next
    })
  }
  function clear(key = contextKey) { setCompanies(current => ({ ...current, [key]: null })) }
  function remember(key: string, value: CommandCompany | null) { setCompanies(current => ({ ...current, [key]: value })) }
  const context = enabled && company ? <div className="company-command-context" role="group" aria-label="当前研究公司">
    <span>当前公司：<strong>{company.name}</strong> · {company.stock_code}</span>
    <button type="button" className="text-button workspace-button" disabled={disabled} onClick={() => setOpened({ company, kind: 'financials' })}>查财务</button>
    <button type="button" className="text-button workspace-button" disabled={disabled} onClick={() => setOpened({ company, kind: 'disclosures' })}>原始披露</button>
    <button type="button" className="text-button workspace-button" disabled={disabled} onClick={() => clear()}>清除当前公司</button>
    <small>后续提问会带上公司名称和代码。</small>
  </div> : null
  return {
    company, context, move, clear, remember, submit, keyDown, isCommand: !!parsed,
    question: (value: string) => companyQuestion(value, enabled ? company : null),
    inputProps: {
      'aria-autocomplete': menuOpen ? 'list' as const : undefined,
      'aria-haspopup': enabled ? 'listbox' as const : undefined,
      'aria-controls': menuOpen ? id : undefined,
      'aria-activedescendant': menuOpen && options.length ? id + '-' + selected : undefined,
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    },
    overlays: <>
      {menuOpen && <CompanyCommandMenu id={id} anchor={anchor} options={options} selected={selected} title={parsed?.stage === 'company' ? parsed.command.label + ' · 选择公司' : '选择快捷命令'}
        message={message} retry={parsed?.stage === 'company' && catalog.error ? catalog.refresh : undefined} onSelect={setCursor} />}
      {enabled && session.active && opened && <CompanyCommandDialog key={opened.company.stock_code + opened.kind} {...opened} returnFocus={anchor} onClose={() => setOpened(null)} />}
    </>,
  }
}
