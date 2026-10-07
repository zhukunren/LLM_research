import type { ConversationScope } from '../../api'
import type { PageId } from '../../navigation'

export type TaskDestination = { kind: 'conversation'; conversation_id: string; scope: ConversationScope }
  | { kind: 'settings' } | { kind: 'page'; page: PageId } | { kind: 'project'; project_id: string }
export type UserTask = {
  id: string; kind: string; title: string; kind_label: string; state: string; state_label: string
  stage: string; created_at: string; updated_at: string; action_label: string; destination: TaskDestination
}
export type TaskCatalog = { items: UserTask[]; active_count: number }
