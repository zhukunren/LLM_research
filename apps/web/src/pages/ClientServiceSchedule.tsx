import { Clock3, Save } from 'lucide-react'
import { contentFields, withFixedDisclosure, type ServiceSettings, type ServiceTemplate } from '../clientService'

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export default function ClientServiceSchedule({ schedule, busy, saving, dirty, onChange, onSave, onReset }: {
  schedule: ServiceSettings; busy: boolean; saving: boolean; dirty: boolean
  onChange: (schedule: ServiceSettings) => void; onSave: () => void; onReset: () => void
}) {
  function changeSlot(id: string, patch: Partial<ServiceTemplate>) {
    onChange({ ...schedule, templates: schedule.templates.map(item => item.id === id ? { ...item, ...patch } : item) })
  }

  return <>
    <div className="client-management-grid">
      <section className="client-management-panel client-schedule" aria-label="每日生成计划">
        <header className="client-panel-heading"><h2>每日生成计划</h2></header>
        <label className="client-schedule-toggle">
          <input type="checkbox" checked={schedule.enabled} disabled={busy} onChange={event => onChange({ ...schedule, enabled: event.target.checked })} />
          开启每日自动生成
        </label>
        <p className="client-plan-note"><Clock3 size={17} aria-hidden="true" />
          <span>按北京时间执行。后台服务运行时，关闭页面仍会执行计划。错过 15 分钟的时点需手动采集。</span>
        </p>
        <fieldset disabled={busy}>
          <legend>选择生成日期</legend>
          <div className="client-weekdays">{weekdays.map((day, index) => <label key={day}>
            <input type="checkbox" checked={schedule.weekdays.includes(index)} onChange={event => {
              const days = event.target.checked ? [...schedule.weekdays, index].sort() : schedule.weekdays.filter(value => value !== index)
              onChange({ ...schedule, weekdays: days })
            }} />{day}
          </label>)}</div>
          <p className="client-plan-help">按星期执行，请在法定休市日前调整计划。</p>
          {!schedule.weekdays.length && <p role="alert" className="client-field-error">请至少选择一个生成日期。</p>}
        </fieldset>
        <fieldset className="client-schedule-times" disabled={busy}>
          <legend>生成时点</legend>
          {schedule.templates.map(item => <div key={item.id}>
            <label><input type="checkbox" checked={item.enabled} onChange={event => changeSlot(item.id, { enabled: event.target.checked })} />{item.title}</label>
            <input type="time" aria-label={`${item.title}生成时间`} className="workspace-field" value={item.time}
              onChange={event => { if (event.target.value) changeSlot(item.id, { time: event.target.value }) }} />
          </div>)}
        </fieldset>
      </section>
      <section className="client-management-panel client-template-library" aria-label="服务模板文案">
        <header className="client-panel-heading"><h2>服务模板文案</h2></header>
        <p className="client-plan-help">保存后用于后续生成，已有卡片保留原内容。</p>
        {schedule.templates.map(item => <details key={item.id}>
          <summary>{item.title} · {item.time}</summary>
          <div className="client-content-fields client-template-fields">{contentFields.map(field => <label key={field.key}>
            <span>{field.label}</span>
            <textarea aria-label={`${item.title}${field.label}`} rows={field.rows || 1} maxLength={field.max} disabled={busy}
              value={item.content[field.key]} onChange={event => changeSlot(item.id, { content: withFixedDisclosure({ ...item.content, [field.key]: event.target.value }) })}
              className="workspace-field" />
          </label>)}</div>
        </details>)}
      </section>
    </div>
    <footer className="client-management-actions">
      <span>{dirty ? '计划有未保存的修改' : '计划已保存'} · {schedule.templates.filter(item => item.enabled).length} 个启用时点</span>
      <div className="client-editor-actions">
        <button type="button" className="secondary-button workspace-button" disabled={!dirty || busy} onClick={onReset}>放弃计划修改</button>
        <button type="button" className="primary-button workspace-button" disabled={busy || !schedule.weekdays.length || !dirty} onClick={onSave}>
          <Save size={15} />{saving ? '正在保存…' : '保存生成计划'}
        </button>
      </div>
    </footer>
  </>
}
