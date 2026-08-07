import { useMemo, useState } from 'react'
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
  GitCommit,
  Hammer,
  ShieldCheck,
  XCircle
} from 'lucide-react'
import type { GeneratedImageRef, ToolCallInfo } from '@shared/types'
import { useStore } from '../store'
import { t, toolLabel } from '../i18n'
import GeneratedImagePreview from './GeneratedImagePreview'
import { getToolOutputPreview } from '../tool-output-preview'
import { getEditDiffPreview } from '../edit-diff'

interface Props {
  toolCall: ToolCallInfo
  showForgeSummary?: boolean
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
  GitBranch: GitBranch,
  ToolSearch: Search,
  ToolForgeStart: Hammer,
  ToolForgeStatus: ShieldCheck,
  ToolPromote: ShieldCheck,
  ToolForgeCancel: XCircle
}

export default function ToolCard({ toolCall, showForgeSummary = true }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const Icon = TOOL_ICONS[toolCall.toolName] ?? Wrench
  const isRunning = toolCall.status === 'running'
  const isDone = toolCall.status === 'done'
  const editDiff = useMemo(() => toolCall.toolName === 'Edit' ? getEditDiffPreview(toolCall.metadata) : null, [toolCall.metadata, toolCall.toolName])
  const diffText = editDiff?.text ?? (typeof toolCall.metadata?.diff === 'string' ? toolCall.metadata.diff : '')
  const hasDiff = diffText.length > 0
  const generatedImages = useMemo(() => getGeneratedImages(toolCall.metadata), [toolCall.metadata])
  const canExpand = (toolCall.toolName !== 'GenerateImage' || toolCall.status === 'error') && (Boolean(toolCall.output) || hasDiff)

  const language = useStore((s) => s.language)
  const forgeSummary = useMemo(
    () => getToolForgeSummary(toolCall, language),
    [language, toolCall]
  )
  const primaryArg = getPrimaryArg(toolCall.toolName, toolCall.input, language)
  const additions = editDiff?.additions ?? getMetadataCount(toolCall.metadata, 'additions')
  const deletions = editDiff?.deletions ?? getMetadataCount(toolCall.metadata, 'deletions')

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

      {showForgeSummary && forgeSummary && (
        <ToolForgeSummary
          summary={forgeSummary}
          language={language}
        />
      )}

      {generatedImages.length > 0 && (
        <div className="grid gap-2 border-t border-[var(--color-border)]/70 p-3 sm:grid-cols-2">
          {generatedImages.map((image) => (
            <GeneratedImagePreview key={image.id} image={image} />
          ))}
        </div>
      )}

      {canExpand && expanded && <ToolExpandedContent toolCall={toolCall} language={language} diffText={diffText} />}
    </div>
  )
}

interface ToolForgeSummaryView {
  toolId?: string
  goal?: string
  status?: string
  permissionSummary?: string
  candidateFingerprint?: string
  validationReportId?: string
  capabilityRevision?: number
  canOpenWorkbench: boolean
}

export function ToolForgeSummary({
  summary,
  language
}: {
  summary: ToolForgeSummaryView
  language: import('../i18n').Language
}): React.JSX.Element {
  const openWorkbench = (focus: 'overview' | 'edit'): void => {
    if (!summary.toolId) return
    window.dispatchEvent(new CustomEvent('joker:open-generated-tool', {
      detail: {
        toolId: summary.toolId,
        focus,
        requestedFrom: focus === 'edit' ? 'conversation' : 'settings'
      }
    }))
  }

  return (
    <div
      data-testid="toolforge-conversation-summary"
      className="border-t border-[var(--color-border)]/70 bg-[var(--color-bg)]/45 px-3 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-accent)]">
            {t(language, 'toolforge.conversationEvidence')}
          </p>
          {summary.goal && (
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">
              {summary.goal}
            </p>
          )}
        </div>
        {summary.status && (
          <span className="rounded-full border border-[var(--color-border-light)] bg-[var(--color-surface-active)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)]">
            {formatToolForgeStatus(language, summary.status)}
          </span>
        )}
      </div>

      <dl className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
        {summary.toolId && (
          <div className="min-w-0">
            <dt className="text-[var(--color-text-muted)]">{t(language, 'toolforge.conversationTool')}</dt>
            <dd className="truncate font-mono text-[var(--color-text-secondary)]" title={summary.toolId}>{summary.toolId}</dd>
          </div>
        )}
        {summary.permissionSummary && (
          <div className="min-w-0">
            <dt className="text-[var(--color-text-muted)]">{t(language, 'toolforge.permissions')}</dt>
            <dd className="truncate text-[var(--color-text-secondary)]" title={summary.permissionSummary}>{summary.permissionSummary}</dd>
          </div>
        )}
        {summary.validationReportId && (
          <div className="min-w-0">
            <dt className="text-[var(--color-text-muted)]">{t(language, 'toolforge.validationEvidence')}</dt>
            <dd className="truncate font-mono text-[var(--color-text-secondary)]" title={summary.validationReportId}>{summary.validationReportId}</dd>
          </div>
        )}
        {summary.candidateFingerprint && (
          <div className="min-w-0">
            <dt className="text-[var(--color-text-muted)]">{t(language, 'toolforge.candidateFingerprint')}</dt>
            <dd className="truncate font-mono text-[var(--color-text-secondary)]" title={summary.candidateFingerprint}>{summary.candidateFingerprint.slice(0, 16)}…</dd>
          </div>
        )}
        {summary.capabilityRevision !== undefined && (
          <div className="min-w-0">
            <dt className="text-[var(--color-text-muted)]">{t(language, 'toolforge.capabilityRevision')}</dt>
            <dd className="font-mono text-[var(--color-text-secondary)]">{summary.capabilityRevision}</dd>
          </div>
        )}
      </dl>

      {summary.canOpenWorkbench && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            data-testid="toolforge-open-workbench"
            type="button"
            onClick={() => openWorkbench('overview')}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-[var(--color-accent)]/15 px-3 text-xs font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25"
          >
            <ShieldCheck size={13} />
            {t(language, 'toolforge.viewTool')}
          </button>
          <button
            data-testid="toolforge-open-edit"
            type="button"
            onClick={() => openWorkbench('edit')}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--color-border-light)] px-3 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <Hammer size={13} />
            {t(language, 'toolforge.edit')}
          </button>
        </div>
      )}
    </div>
  )
}

function ToolExpandedContent({ toolCall, language, diffText }: { toolCall: ToolCallInfo; language: import('../i18n').Language; diffText: string }): React.JSX.Element {
  const hasDiff = diffText.length > 0
  const outputPreview = toolCall.output ? getToolOutputPreview(toolCall.toolName, toolCall.output, language) : null

  return (
    <div className="border-t border-[var(--color-border)]/70 px-2 py-1.5">
      {outputPreview && !(toolCall.toolName === 'Edit' && hasDiff) && (
        <div className={hasDiff ? 'mb-2' : undefined}>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'tool.output')}</p>
          <pre className="max-w-full overflow-hidden whitespace-pre-wrap break-words rounded bg-[var(--color-bg)] p-2 text-xs text-[var(--color-text-secondary)]">
            {outputPreview.text}
          </pre>
        </div>
      )}

      {hasDiff && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'tool.diff')}</p>
          <pre className="max-w-full overflow-hidden whitespace-pre-wrap break-words rounded bg-[var(--color-bg)] p-2 text-xs">
            <code className="font-mono">
              {diffText.split('\n').map((line, index) => (
                <span
                  key={index}
                  className={line.startsWith('+')
                    ? 'text-green-400'
                    : line.startsWith('-')
                      ? 'text-red-400'
                      : 'text-[var(--color-text-muted)]'}
                >
                  {line + '\n'}
                </span>
              ))}
            </code>
          </pre>
        </div>
      )}
    </div>
  )
}

function parseToolOutput(output: string | undefined): Record<string, unknown> | null {
  if (!output) return null
  try {
    const parsed = JSON.parse(output)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function permissionSummary(value: unknown, language: import('../i18n').Language): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const permissions = value as Record<string, unknown>
  const declared: string[] = []
  const filesystem = permissions.filesystem
  if (filesystem && typeof filesystem === 'object' && !Array.isArray(filesystem)) {
    const filesystemPermissions = filesystem as Record<string, unknown>
    if (Array.isArray(filesystemPermissions.read) && filesystemPermissions.read.length > 0) declared.push('project-read')
    if (Array.isArray(filesystemPermissions.write) && filesystemPermissions.write.length > 0) declared.push('filesystem-write')
  }
  const network = permissions.network
  if (network && typeof network === 'object' && !Array.isArray(network)) {
    const hosts = (network as Record<string, unknown>).hosts
    if (Array.isArray(hosts) && hosts.length > 0) declared.push('network')
  }
  const process = permissions.process
  if (process && typeof process === 'object' && !Array.isArray(process)) {
    const commands = (process as Record<string, unknown>).commands
    if (Array.isArray(commands) && commands.length > 0) declared.push('process')
  }
  const environment = permissions.environment
  if (environment && typeof environment === 'object' && !Array.isArray(environment)) {
    const keys = (environment as Record<string, unknown>).keys
    if (Array.isArray(keys) && keys.length > 0) declared.push('environment')
  }
  const secrets = permissions.secrets
  if (secrets && typeof secrets === 'object' && !Array.isArray(secrets)) {
    const handles = (secrets as Record<string, unknown>).handles
    if (Array.isArray(handles) && handles.length > 0) declared.push('secrets')
  }
  return declared.length > 0 ? declared.join(', ') : t(language, 'toolforge.noneDeclared')
}

export function getToolForgeSummary(
  toolCall: ToolCallInfo,
  language: import('../i18n').Language
): ToolForgeSummaryView | null {
  if (!['ToolForgeStart', 'ToolForgeStatus', 'ToolPromote', 'ToolForgeCancel'].includes(toolCall.toolName)) return null
  const output = parseToolOutput(toolCall.output)
  const spec = toolCall.input.spec && typeof toolCall.input.spec === 'object' && !Array.isArray(toolCall.input.spec)
    ? toolCall.input.spec as Record<string, unknown>
    : null
  const toolId = stringValue(output?.toolId) ?? stringValue(spec?.id)
  const status = stringValue(output?.status)
  return {
    toolId,
    goal: stringValue(spec?.goal) ?? stringValue(spec?.reason),
    status,
    permissionSummary: permissionSummary(spec?.permissions, language),
    candidateFingerprint: stringValue(output?.candidateFingerprint),
    validationReportId: stringValue(output?.validationReportId),
    capabilityRevision: numberValue(output?.capabilityRevision),
    canOpenWorkbench: Boolean(
      toolId &&
      (
        toolCall.toolName === 'ToolPromote' ||
        ['awaiting-policy', 'promoting', 'completed', 'failed', 'cancelled', 'interrupted'].includes(status ?? '')
      )
    )
  }
}

function formatToolForgeStatus(
  language: import('../i18n').Language,
  status: string
): string {
  const key = `toolforge.job.${status}`
  const translated = t(language, key)
  return translated === key ? status : translated
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
    case 'ToolSearch':
      return typeof input.query === 'string' ? input.query.slice(0, 80) : null
    case 'ToolForgeStart': {
      const spec = input.spec && typeof input.spec === 'object' && !Array.isArray(input.spec)
        ? input.spec as Record<string, unknown>
        : null
      return typeof spec?.id === 'string' ? spec.id : null
    }
    case 'ToolForgeStatus':
    case 'ToolPromote':
    case 'ToolForgeCancel':
      return typeof input.jobId === 'string' ? input.jobId : null
    default:
      return null
  }
}
