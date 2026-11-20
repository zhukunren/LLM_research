import { useState } from 'react'
import { ArrowRight, Check, Copy, ExternalLink } from 'lucide-react'
import type { ResearchAssistant } from '../../api'
import ConditionWorkspaceDrawer from '../ConditionWorkspaceDrawer'
import './research-method-library.css'

function ResearchMethodDetails({ method }: { method: ResearchAssistant }) {
  const [copyFeedback, setCopyFeedback] = useState('')
  const guide = method.method_guide

  async function copyExample(example: string) {
    try {
      await navigator.clipboard.writeText(example)
      setCopyFeedback('已复制示例')
    } catch {
      setCopyFeedback('可选中示例文字手动复制。')
    }
  }

  return <article className="method-library-details">
    <h3>{method.name}</h3>
    {guide ? <>
      <dl>
        <div><dt>适用问题</dt><dd>{guide.use_when}</dd></div>
        <div><dt>所需资料</dt><dd>{guide.inputs}</dd></div>
        <div><dt>预期产出</dt><dd>{guide.outputs}</dd></div>
      </dl>
      <div className="method-library-example">
        <div className="method-library-example-heading">
          <h4>示例提问</h4>
          <button type="button" className="text-button workspace-button" onClick={() => void copyExample(guide.example_prompt)}>
            <Copy size={14} aria-hidden="true" />复制示例
          </button>
        </div>
        <p>{guide.example_prompt}</p>
        {copyFeedback && <p className="method-library-copy-feedback" role="status">{copyFeedback}</p>}
      </div>
      {guide.source && <p className="method-library-source">
        <span>开源来源</span>
        <a href={guide.source.url} target="_blank" rel="noopener noreferrer">
          {guide.source.name}<ExternalLink size={13} aria-hidden="true" />
        </a>
        <code title={guide.source.revision}>{guide.source.revision.slice(0, 7)}</code>
      </p>}
    </> : <p>{method.description}</p>}
  </article>
}

export default function ResearchMethodLibrary({ methods, currentId, disabled, onUse, onClose }: {
  methods: ResearchAssistant[]
  currentId: string
  disabled: boolean
  onUse: (method: ResearchAssistant) => void
  onClose: () => void
}) {
  const [previewId, setPreviewId] = useState(currentId)
  const preview = methods.find(method => method.id === previewId) ?? methods[0]
  if (!preview) return null

  return <ConditionWorkspaceDrawer title="研究方法库" closeLabel="关闭研究方法库"
    className="research-method-library" onClose={onClose} footer={
      <button type="button" className="primary-button workspace-button" disabled={disabled} onClick={() => onUse(preview)}>
        使用此方法<ArrowRight size={16} aria-hidden="true" />
      </button>
    }>
    <div className="method-library-layout">
      <ul className="method-library-list" aria-label="可用研究方法">
        {methods.map(method => <li key={method.id}>
          <button type="button" className="method-library-choice workspace-button" aria-pressed={method.id === preview.id}
            onClick={() => setPreviewId(method.id)}>
            <span>{method.name}</span>
            {method.id === currentId && <Check size={15} role="img" aria-label="当前使用" />}
          </button>
        </li>)}
      </ul>
      <ResearchMethodDetails key={preview.id} method={preview} />
    </div>
  </ConditionWorkspaceDrawer>
}
