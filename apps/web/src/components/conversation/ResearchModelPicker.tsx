import { useEffect, useMemo, useRef } from 'react'
import { modelModeForSelection, modelModes, validateModelCatalog, type ModelMode, type ModelSelection } from '../../modelSelection'
import { useRemoteResource } from '../../useRemoteResource'
import ModelModeSwitch from '../ModelModeSwitch'

type Props = {
  value?: Partial<ModelSelection>
  disabled: boolean
  onChange: (selection: ModelSelection) => void
  onAvailabilityChange: (available: boolean) => void
}

export default function ResearchModelPicker({ value, disabled, onChange, onAvailabilityChange }: Props) {
  const { data, error, retry } = useRemoteResource<unknown>('/research-models')
  const availabilityCallback = useRef(onAvailabilityChange)
  availabilityCallback.current = onAvailabilityChange
  const mode = modelModeForSelection(value)
  const { unavailable, invalid } = useMemo(() => {
    const unavailable: Partial<Record<ModelMode, string>> = {}
    if (!data) return { unavailable, invalid: false }
    try {
      const catalog = validateModelCatalog(data)
      for (const key of ['instant', 'deep'] as const) {
        const { model_id, reasoning_effort } = modelModes[key].selection
        const model = catalog.models.find(item => item.id === model_id)
        if (!model?.available || model.default_reasoning_effort !== reasoning_effort) {
          unavailable[key] = model?.unavailable_reason || '当前模型档位不可用'
        }
      }
      return { unavailable, invalid: false }
    } catch {
      return { unavailable, invalid: true }
    }
  }, [data])
  const selectedReason = unavailable[mode]
  useEffect(() => { availabilityCallback.current(!selectedReason) }, [mode, selectedReason, value?.model_id, value?.reasoning_effort])

  return <div className="research-model-picker">
    <ModelModeSwitch value={mode} disabled={disabled} unavailable={unavailable} onChange={next => onChange(modelModes[next].selection)} />
    {selectedReason && <small role="status">{selectedReason}</small>}
    {(error || invalid) && <button type="button" className="text-button workspace-button" onClick={retry}>重试读取模型状态</button>}
  </div>
}
