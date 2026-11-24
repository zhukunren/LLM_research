import { modelModes, type ModelMode } from '../modelSelection'
import './model-mode-switch.css'

type Props = {
  value: ModelMode
  onChange: (mode: ModelMode) => void
  disabled?: boolean
  unavailable?: Partial<Record<ModelMode, string>>
}

const modes: ModelMode[] = ['instant', 'deep']

export default function ModelModeSwitch({ value, onChange, disabled, unavailable }: Props) {
  return <div className="model-mode-switch" role="group" aria-label="模型档位">
    {modes.map(mode => <button key={mode} type="button" className="workspace-button"
      aria-pressed={value === mode} disabled={disabled || !!unavailable?.[mode]} title={unavailable?.[mode]}
      onClick={() => { if (mode !== value) onChange(mode) }}>
      {modelModes[mode].label}
    </button>)}
  </div>
}
