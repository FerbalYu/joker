import { useState } from 'react'
import {
  FileText,
  FilePen,
  FilePenLine,
  Terminal,
  Search,
  FolderSearch,
  ListChecks,
  Wrench,
  Globe,
  ChevronDown,
  ChevronRight,
  Loader2,
  FileDiff,
  Image,
  GitBranch,
  GitCompare,
  GitCommit
} from 'lucide-react'
import type { GeneratedImageRef, ToolCallInfo } from '@shared/types'
import { useStore } from '../store'
import { t, toolLabel } from '../i18n'
import GeneratedImagePreview from './GeneratedImagePreview'
import { getToolOutputPreview } from '../tool-output-preview'
import { getEditDiffPreview } from '../edit-diff'

interface Props {
  toolCall: ToolCallInfo
}

const TOOL_ICONS: Record<string, React.ElementType> = {
  Read: FileText,
  Write: FilePen,
  Edit: FilePenLine,
  Bash: Terminal,
  Grep: Search,
  Glob: FolderSearch,
  TodoWrite: ListChecks,
  Agent: Wrench,
  WebRead: Globe,
  WebSearch: Search,
  GenerateImage: Image,
  GitStatus: GitBranch,
  GitDiff: GitCompare,
  GitLog: GitCommit,
  GitBranch: GitBranch
}

export default function ToolCard({ toolCall }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const Icon = TOOL_ICONS[toolCall.toolName] ?? Wrench
  const isRunning = toolCall.status === 'running'
  const isDone = toolCall.status === 'done'
  const editDiff = getEditDiffPreview(toolCall.metadata)
  const diffText = toolCall.toolName === 'Edit'
    ? editDiff.text
    : typeof toolCall.metadata?.diff === 'string'
      ? toolCall.metadata.diff
      : ''
  const hasDiff = diffText.length > 0
  const generatedImages = getGeneratedImages(toolCall.metadata)
  const canExpand = toolCall.toolName !== 'GenerateImage' && (Boolean(toolCall.output) || hasDiff)

  const language = useStore((s) => s.language)
  const primaryArg = getPrimaryArg(toolCall.toolName, toolCall.input, language)
  const outputPreview = toolCall.output ? getToolOutputPreview(toolCall.toolName, toolCall.output, language) : null
  const additions = toolCall.toolName === 'Edit'
    ? editDiff.additions
    : getMetadataCount(toolCall.metadata, 'additions')
  const deletions = toolCall.toolName === 'Edit'
    ? editDiff.deletions
    : getMetadataCount(toolCall.metadata, 'deletions')

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-[var(--color-surface)] shadow-[0_8px_24px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow,background-color] ${
        isRunning
          ? 'border-[var(--color-accent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent),0_8px_24px_rgba(0,0,0,0.16)]'
          : isDone
            ? 'border-[var(--color-border)]'
            : 'border-red-700'
      }`}
    >
      <button
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-expanded={canExpand ? expanded : undefined}
        className={`flex min-h-6 min-w-0 w-full items-center gap-2 px-2 py-1 text-left transition-colors ${
          canExpand
            ? 'hover:bg-[var(--color-surface-hover)]'
            : 'cursor-default'
        }`}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg)] text-[var(--color-text-secondary)]">
          <Icon size={14} />
        </span>
        <span className="shrink-0 whitespace-nowrap rounded-md bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[12px] font-medium leading-none text-[var(--color-text-primary)]">
          {toolLabel(language, toolCall.toolName)}
        </span>
        {primaryArg && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-text-muted)]"
            title={primaryArg}
          >
            {primaryArg}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {toolCall.toolName === 'Edit' && isDone && (
            <span className="flex items-center gap-1 font-mono text-[10px] tabular-nums">
              <span className="text-green-400">+{additions}</span>
              <span className="text-red-400">-{deletions}</span>
            </span>
          )}
          {toolCall.metadata?.source === 'http' && isDone && (
            <span className="hidden rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-text-muted)] sm:inline">
              HTTP
            </span>
          )}
          {toolCall.metadata?.source === 'browser' && isDone && (
            <span className="hidden rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-text-muted)] sm:inline">
              Browser
            </span>
          )}
          {isRunning && <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />}
          {hasDiff && isDone && <FileDiff size={14} className="text-[var(--color-accent)]" />}
          {canExpand && (expanded ? (
            <ChevronDown size={15} className="text-[var(--color-text-muted)]" />
          ) : (
            <ChevronRight size={15} className="text-[var(--color-text-muted)]" />
          ))}
        </span>
      </button>

      {generatedImages.length > 0 && (
        <div className="grid gap-2 border-t border-[var(--color-border)]/70 p-3 sm:grid-cols-2">
          {generatedImages.map((image) => (
            <GeneratedImagePreview key={image.id} image={image} />
          ))}
        </div>
      )}

      {canExpand && expanded && (
        <div className="border-t border-[var(--color-border)]/70 px-2 py-1.5">
          {/* Output */}
          {outputPreview && !(toolCall.toolName === 'Edit' && hasDiff) && (
            <div className={hasDiff ? 'mb-2' : undefined}>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'tool.output')}</p>
              <pre className="max-w-full overflow-hidden whitespace-pre-wrap break-words rounded bg-[var(--color-bg)] p-2 text-xs text-[var(--color-text-secondary)]">
                {outputPreview.text}
              </pre>
            </div>
          )}

          {/* Diff */}
          {hasDiff && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'tool.diff')}</p>
              <pre className="max-w-full overflow-hidden whitespace-pre-wrap break-words rounded bg-[var(--color-bg)] p-2 text-xs">
                <code className="font-mono">
                  {diffText
                    .split('\n')
                    .map((line, i) => (
                      <span
                        key={i}
                        className={
                          line.startsWith('+')
                            ? 'text-green-400'
                            : line.startsWith('-')
                              ? 'text-red-400'
                              : 'text-[var(--color-text-muted)]'
                        }
                      >
                        {line + '\n'}
                      </span>
                    ))}
                </code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function getMetadataCount(metadata: Record<string, unknown> | undefined, key: string): number {
  const value = metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function getGeneratedImages(metadata: Record<string, unknown> | undefined): GeneratedImageRef[] {
  const value = metadata?.generatedImages
  if (!Array.isArray(value)) return []
  return value.filter(isGeneratedImageRef)
}

function isGeneratedImageRef(value: unknown): value is GeneratedImageRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Partial<GeneratedImageRef>
  return typeof ref.id === 'string' &&
    typeof ref.sessionId === 'string' &&
    typeof ref.filename === 'string' &&
    (ref.mediaType === 'image/png' || ref.mediaType === 'image/jpeg' || ref.mediaType === 'image/webp') &&
    typeof ref.sizeBytes === 'number' &&
    typeof ref.createdAt === 'number'
}

function getPrimaryArg(
  toolName: string,
  input: Record<string, unknown>,
  language: import('../i18n').Language
): string | null {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return (input.filePath as string) ?? null
    case 'Bash':
      return (input.command as string) ?? null
    case 'Grep':
      return (input.pattern as string) ?? null
    case 'Glob':
      return (input.pattern as string) ?? null
    case 'TodoWrite':
      return t(language, 'tool.items', { count: (input.todos as unknown[])?.length ?? 0 })
    case 'Agent':
      return (input.prompt as string)?.slice(0, 40) ?? null
    case 'WebRead':
      return (input.url as string) ?? null
    case 'WebSearch':
      return typeof input.query === 'string' ? input.query.slice(0, 60) : null
    case 'GenerateImage':
      return typeof input.prompt === 'string' ? input.prompt.slice(0, 60) : null
    case 'GitDiff':
      return input.staged === true ? t(language, 'tool.gitStaged') : t(language, 'tool.gitWorkingTree')
    case 'GitLog':
      return t(language, 'tool.gitRecentCommits', { count: typeof input.limit === 'number' ? input.limit : 10 })
    case 'GitBranch':
      return input.all === true ? t(language, 'tool.gitAllBranches') : t(language, 'tool.gitLocalBranches')
    default:
      return null
  }
}
