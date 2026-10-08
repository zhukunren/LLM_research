import type { ComponentProps } from 'react'
import WorkbenchPage from './WorkbenchPage'
import SavedScreeningPlans from './SavedScreeningPlans'

type Props = Omit<ComponentProps<typeof WorkbenchPage>, 'workflowOnly' | 'conversationWorkflowType' | 'screeningOnly' | 'scope'>

/** One explicit screening entry owns its authoring, composition and history views. */
export default function ScreeningWorkspace(props: Props) {
  if (props.view === 'saved') return <SavedScreeningPlans data={props.data} onOpenConversation={props.onResumeConversation} />
  return <WorkbenchPage {...props} workflowOnly conversationWorkflowType="screening" />
}
