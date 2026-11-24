import { modelModes, type ModelMode, type ResearchModelCatalog } from '../modelSelection'

export function modelCatalog(unavailable?: ModelMode): ResearchModelCatalog {
  return {
    account_tier: 'paid', discovery_status: 'verified',
    default_model_id: 'gpt-6.2-astra', default_reasoning_effort: 'low',
    models: (['instant', 'deep'] as const).map(mode => {
      const { label, selection } = modelModes[mode]
      return {
        id: selection.model_id, label, description: selection.model_id,
        available: mode !== unavailable, unavailable_reason: mode === unavailable ? '当前账户不可用' : null,
        default_reasoning_effort: selection.reasoning_effort,
        reasoning_efforts: [{ id: selection.reasoning_effort, label: selection.reasoning_effort }],
      }
    }),
  }
}
