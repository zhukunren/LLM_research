import { ApiRequestError } from '../../api'

export type IndicatorRecoveryAction = 'retry' | 'services' | 'inputs' | 'recalculate' | 'refresh' | 'describe'
export type IndicatorRecovery = { message: string; guidance: string; actions: IndicatorRecoveryAction[] }
type Advice = Omit<IndicatorRecovery, 'message'>

// Match the server's stable categories, never guess a cause from translated text.
// The caller exposes only actions for which it has a real, currently usable handler.
const byCode: Record<string, Advice> = {
  indicator_runtime_unavailable: { guidance: '请检查数据与服务中的运行环境状态，恢复后重试。', actions: ['services', 'retry'] },
  indicator_bars_not_found: { guidance: '请调整证券或截止日期，或检查行情覆盖后再试算。', actions: ['inputs', 'services'] },
  indicator_stale_trial: { guidance: '请保留当前设置，重新试算后再保存。', actions: ['recalculate'] },
  indicator_data_context_changed: { guidance: '请按当前行情口径重新试算并保存新版本，再用于选股。', actions: ['recalculate'] },
  indicator_version_conflict: { guidance: '请刷新指标列表，核对已有版本后再决定保存位置；不会自动覆盖原版本。', actions: ['refresh'] },
  indicator_trial_not_found: { guidance: '请刷新试算记录并重新选择；当前编辑内容无需清空。', actions: ['refresh'] },
  indicator_not_found: { guidance: '请刷新指标列表，核对该指标及固定版本是否仍可访问。', actions: ['refresh'] },
  indicator_execution_failed: { guidance: '请根据上方执行错误补充修改要求，让 Codex 修正后重新试算。', actions: ['describe'] },
  indicator_lookahead_detected: { guidance: '请让 Codex 修正未来数据或全局长度依赖，重新通过校验后再保存。', actions: ['describe'] },
  indicator_request_conflict: { guidance: '请先刷新并核对已有保存结果和目标；不要直接重复提交冲突请求。', actions: ['refresh'] },
  indicator_cancelled: { guidance: '本次试算已取消，可以按当前设置重新试算。', actions: ['retry'] },
}

export function indicatorRecovery(reason: unknown): IndicatorRecovery {
  const message = reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : '请求未完成，请重试。'
  let advice: Advice | undefined
  if (reason instanceof ApiRequestError) {
    advice = reason.code && Object.hasOwn(byCode, reason.code) ? byCode[reason.code] : undefined
    if (!advice) {
      if (reason.status === 401) advice = { guidance: '请完成登录后重试；无需清空当前编辑内容。', actions: ['retry'] }
      else if (reason.status === 403) advice = { guidance: '当前请求未获授权。请核对账户权限，授权恢复后再操作。', actions: [] }
      else if (reason.status === 429) advice = { guidance: '请求受到频率或额度限制，请稍后按原设置重试。', actions: ['retry'] }
      else if (reason.status >= 500) advice = { guidance: '服务未能完成请求，请检查数据与服务状态后重试。', actions: ['services', 'retry'] }
      else if (reason.status === 422) advice = { guidance: '请核对输入设置；若错误涉及指标公式，可补充修改要求后重新生成。', actions: ['inputs', 'describe'] }
      else if (reason.status === 409) advice = { guidance: '请求与当前状态存在冲突，请刷新并核对现有记录后再操作。', actions: ['refresh'] }
    }
  }
  return { message, ...(advice ?? { guidance: '请先核对上方提示，可重试当前操作或检查数据与服务；无需清空编辑内容。', actions: ['retry', 'services'] }) }
}
