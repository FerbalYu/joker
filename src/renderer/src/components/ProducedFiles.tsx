import { useMemo } from 'react'
import { FileOutput } from 'lucide-react'
import type { ToolCallInfo } from '@shared/types'
import { useStore } from '../store'
import { t } from '../i18n'

/** Tools whose success means the file at the extracted path was created or changed. */
const MUTATION_TOOL_NAMES = new Set(['Write', 'Edit'])

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

/**
 * Paths produced (created or edited) by one assistant turn, deduplicated
 * in call order. Read-only from the persisted tool call records.
 */
export function producedFilesOf(toolCalls: readonly ToolCallInfo[]): string[] {
  const paths: string[] = []
  for (const toolCall of toolCalls) {
    if (toolCall.status !== 'done' || !MUTATION_TOOL_NAMES.has(toolCall.toolName)) continue
    const inputPath = typeof toolCall.input?.filePath === 'string' ? String(toolCall.input.filePath) : ''
    const fromOutput = /^(?:File written:\s*|Edited\s+)(.+)$/m.exec(toolCall.output ?? '')
    const path = inputPath || (fromOutput?.[1] ?? '')
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths
}

export default function ProducedFiles({ toolCalls }: { toolCalls: readonly ToolCallInfo[] }): React.JSX.Element | null {
  const language = useStore((s) => s.language)
  const files = useMemo(() => producedFilesOf(toolCalls), [toolCalls])
  if (files.length === 0) return null

  return (
    <div data-produced-files className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
        <FileOutput size={12} />
        {t(language, 'message.producedFiles')}
      </span>
      {files.map((path) => (
        <button
          key={path}
          type="button"
          data-produced-file={basename(path)}
          title={path}
          onClick={() => void window.joker.file.reveal(path)}
          className="flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)]"
        >
          {basename(path)}
        </button>
      ))}
    </div>
  )
}
