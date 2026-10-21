import { Search, X } from 'lucide-react'
export default function SearchField({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (value: string) => void }) {
  return <div className="workspace-search workspace-field-shell"><Search size={16} aria-hidden="true" /><input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} className="workspace-field" />{value && <button type="button" className="icon-button workspace-button" aria-label={'清除' + label} onClick={() => onChange('')}><X size={14} /></button>}</div>
}
