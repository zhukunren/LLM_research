import ResearchFileList from './ResearchFileList'

export type GeneratedFile = {
  name: string
  bytes: number
  modified_at: number
  file_type: string
  media_type: string
  url: string
  conversation_id: string
}

export default function GeneratedFiles({ files }: { files: GeneratedFile[] }) {
  if (!files.length) return null
  return <section className="generated-files" aria-label="生成文件">
    <h3>生成文件</h3>
    <p className="conversation-muted">按原格式下载，可继续编辑。</p>
    <ResearchFileList files={files} />
  </section>
}
