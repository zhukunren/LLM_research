import type { ComponentProps } from 'react'
import ConversationWorkspace from '../components/conversation/ConversationWorkspace'

type Props = Omit<ComponentProps<typeof ConversationWorkspace>, 'initialWorkflowType'>

/** Research enters the conversation directly; it does not initialize strategy/condition catalogs. */
export default function ResearchWorkspace(props: Props) {
  return <div className="page-content workbench workbench-conversation"><ConversationWorkspace {...props} initialWorkflowType="research" /></div>
}
