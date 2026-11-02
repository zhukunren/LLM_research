type Question = { id: string; role: string; content: string; display_content?: string | null }

/** Index only actual user messages, never inferred topics or regenerated answers. */
export default function ResearchQuestionIndex({ messages, onJump }: { messages: Question[]; onJump: (id: string) => void }) {
  const questions = messages.filter(message => message.role === 'user')
  if (questions.length < 4 && !(questions.length >= 2 && messages.reduce((size, message) => size + message.content.length, 0) >= 6000)) return null
  const label = (message: Question, index: number) => `${index + 1}. ${(message.display_content ?? message.content).replace(/\s+/g, ' ').trim() || '附件问题'}`
  return <nav className="research-question-index" aria-label="研究问题索引">
    <details><summary>问题索引 · {questions.length}</summary><ol>{questions.map((message, index) => <li key={message.id}><button type="button" className="text-button workspace-button" onClick={() => onJump(message.id)}>{label(message, index)}</button></li>)}</ol></details>
    <label className="research-question-select">定位研究问题<select className="workspace-field" aria-label="定位研究问题" value="" onChange={event => { if (event.target.value) onJump(event.target.value) }}><option value="">选择问题（{questions.length}）</option>{questions.map((message, index) => <option key={message.id} value={message.id}>{label(message, index)}</option>)}</select></label>
  </nav>
}
