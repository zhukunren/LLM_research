import type { ComponentProps, ReactNode } from 'react'
import { Search } from 'lucide-react'

export function WorkspaceSearchField({ className = '', children, ...input }: ComponentProps<'input'> & { children?: ReactNode }) {
  return <label className={`workspace-field-shell ${className}`.trim()}>
    <Search size={17} aria-hidden="true" />
    <input {...input} className="workspace-field" />
    {children}
  </label>
}

export function WorkspaceSelect({ className = '', ...props }: ComponentProps<'select'>) {
  return <select {...props} className={`workspace-field workspace-select ${className}`.trim()} />
}

export function WorkspaceDataTable({ className = '', ...props }: ComponentProps<'table'>) {
  return <table {...props} className={`workspace-data-table ${className}`.trim()} />
}

export function WorkspaceMetric({ label, value, tone = '', hint, breakdown }: { label: string; value: string; tone?: string; hint?: string; breakdown?: boolean }) {
  return <div className="observation-summary-value" data-breakdown={breakdown || undefined} data-tooltip={hint} aria-label={label + ' ' + value + (hint ? ' · ' + hint : '')}>
    <span>{label}</span><strong className={tone}>{value}</strong>
  </div>
}
