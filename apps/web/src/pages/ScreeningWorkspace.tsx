import type { ComponentProps } from 'react'
import WorkbenchPage from './WorkbenchPage'

type Props = Omit<ComponentProps<typeof WorkbenchPage>, 'workflowOnly' | 'conversationWorkflowType' | 'screeningOnly' | 'scope'>

/** One explicit screening entry owns its authoring, composition and history views. */
export default function ScreeningWorkspace(props: Props) {
  return <WorkbenchPage {...props} workflowOnly conversationWorkflowType="screening" />
}
