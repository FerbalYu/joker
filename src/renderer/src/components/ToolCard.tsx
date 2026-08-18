import { useEffect, useMemo, useRef, useState } from 'react'
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
  XCircle,
  LockKeyhole,
  AlertTriangle,
  Clock3
} from 'lucide-react'
import type { GeneratedImageRef, GeneratedToolJobStatusView, ToolCallInfo } from '@shared/types'
import { useStore } from '../store'
import { t, toolLabel } from '../i18n'
import GeneratedImagePreview from './GeneratedImagePreview'
import { getToolOutputPreview } from '../tool-output-preview'
import { getEditDiffPreview } from '../edit-diff'
import { isInternalToolForgeTool } from '../tool-visibility'
import { generatedToolJobProductState, isTransientGeneratedToolJobStatus } from './generated-tools/generated-tools-settings-state'
import { appendSpillChunk, getToolResultSpill, initialSpillReadState, type SpillReadState, type ToolResultSpillRefView } from '../tool-spill'

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
  ToolForgeCancel: XCircle,
  GeneratedToolEnable: LockKeyhole
}

export default function ToolCard({ toolCall, showForgeSummary = true }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now())
  const Icon = TOOL_ICONS[toolCall.toolName] ?? Wrench
  const isRunning = toolCall.status === 'running'
  const isDone = toolCall.status === 'done'
  const isProposed = toolCall.status === 'proposed'
  const isAwaitingApproval = toolCall.status === 'awaiting-approval'
  const isOutcomeUnknown = toolCall.status === 'outcome-unknown'
  const editDiff = useMemo(() => toolCall.toolName === 'Edit' ? getEditDiffPreview(toolCall.metadata) : null, [toolCall.metadata, toolCall.toolName])
  const diffText = editDiff?.text ?? (typeof toolCall.metadata?.diff === 'string' ? toolCall.metadata.diff : '')
  const hasDiff = diffText.length > 0
  const generatedImages = useMemo(() => getGeneratedImages(toolCall.metadata), [toolCall.metadata])
  const spill = useMemo(() => getToolResultSpill(toolCall.metadata), [toolCall.metadata])
  const internalForgeTool = isInternalToolForgeTool(toolCall.toolName)
  const canExpand = !internalForgeTool && (toolCall.toolName !== 'GenerateImage' || !isDone) && (Boolean(toolCall.output) || hasDiff || Boolean(spill))

  const language = useStore((s) => s.language)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const forgeSummary = useMemo(
    () => getToolForgeSummary(toolCall, language),
    [language, toolCall]
  )
  const primaryArg = getPrimaryArg(toolCall.toolName, toolCall.input, language)
  const additions = editDiff?.additions ?? getMetadataCount(toolCall.metadata, 'additions')
  const deletions = editDiff?.deletions ?? getMetadataCount(toolCall.metadata, 'deletions')
  const activity = toolActivityView(toolCall, now, language)

  useEffect(() => {
    if (!isRunning) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [isRunning])

  return (
    <div
      data-tool-card
      data-tool-status={toolCall.status}
      className={`overflow-hidden rounded-lg border bg-[var(--color-surface)] shadow-[0_8px_24px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow,background-color] ${toolCardBorderClass(toolCall.status)}`}
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
          {activity && <span data-tool-health={activity.level} className={`font-mono text-[10px] tabular-nums ${activity.className}`} title={activity.title}>{activity.label}</span>}
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
          {isProposed && <Clock3 data-tool-state-icon="proposed" size={14} className="text-[var(--color-text-muted)]" />}
          {isAwaitingApproval && <LockKeyhole data-tool-state-icon="awaiting-approval" size={14} className="text-amber-300" />}
          {isOutcomeUnknown && <AlertTriangle data-tool-state-icon="outcome-unknown" size={14} className="text-red-300" />}
          {isRunning && <Loader2 data-tool-state-icon="running" size={14} className="animate-spin text-[var(--color-accent)]" />}
          {hasDiff && isDone && <FileDiff size={14} className="text-[var(--color-accent)]" />}
          {canExpand && (expanded ? (
            <ChevronDown size={15} className="text-[var(--color-text-muted)]" />
          ) : (
            <ChevronRight size={15} className="text-[var(--color-text-muted)]" />
          ))}
        </span>
      </button>

      {isOutcomeUnknown && (
        <div data-tool-outcome-unknown className="border-t border-red-900/70 bg-red-950/25 px-3 py-2 text-xs text-red-200">
          <p className="font-semibold">{t(language, 'tool.status.outcomeUnknown')}</p>
          <p className="mt-1 leading-5 text-red-200/80">{t(language, 'tool.status.outcomeUnknownDetail')}</p>
        </div>
      )}

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

      {canExpand && expanded && <ToolExpandedContent toolCall={toolCall} language={language} diffText={diffText} spill={spill} sessionId={activeSessionId} />}
    </div>
  )
}

function toolCardBorderClass(status: ToolCallInfo['status']): string {
  if (status === 'running') return 'border-[var(--color-accent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent),0_8px_24px_rgba(0,0,0,0.16)]'
  if (status === 'awaiting-approval') return 'border-amber-600/80 shadow-[0_0_0_1px_rgba(217,119,6,0.18),0_8px_24px_rgba(0,0,0,0.14)]'
  if (status === 'outcome-unknown') return 'border-red-600 shadow-[0_0_0_1px_rgba(220,38,38,0.2),0_8px_24px_rgba(0,0,0,0.16)]'
  if (status === 'done' || status === 'proposed') return 'border-[var(--color-border)]'
  if (status === 'denied' || status === 'cancelled') return 'border-amber-800/80'
  return 'border-red-700'
}

function toolActivityView(toolCall: ToolCallInfo, now: number, language: import('../i18n').Language): { level: string; label: string; title: string; className: string } | null {
  if (toolCall.status === 'proposed') return { level: 'proposed', label: t(language, 'tool.status.proposed'), title: t(language, 'tool.status.proposedDetail'), className: 'text-[var(--color-text-muted)]' }
  if (toolCall.status === 'awaiting-approval') return { level: 'awaiting-approval', label: t(language, 'tool.status.awaitingApproval'), title: t(language, 'tool.status.awaitingApprovalDetail'), className: 'text-amber-300' }
  if (toolCall.status === 'outcome-unknown') return { level: 'outcome-unknown', label: t(language, 'tool.status.outcomeUnknown'), title: t(language, 'tool.status.outcomeUnknownDetail'), className: 'text-red-300' }
  const startedAt = toolCall.startedAt
  if (startedAt === undefined) {
    if (toolCall.status === 'timed-out') return { level: 'timed-out', label: t(language, 'tool.status.timedOut'), title: t(language, 'tool.status.timedOut'), className: 'text-red-400' }
    if (toolCall.status === 'cancelled') return { level: 'cancelled', label: t(language, 'tool.status.cancelled'), title: t(language, 'tool.status.cancelled'), className: 'text-amber-400' }
    if (toolCall.status === 'denied') return { level: 'denied', label: t(language, 'tool.status.denied'), title: t(language, 'tool.status.deniedDetail'), className: 'text-amber-400' }
    return null
  }
  const elapsedMs = toolCall.durationMs ?? Math.max(0, now - startedAt)
  const progressAgeMs = Math.max(0, now - (toolCall.lastProgressAt ?? startedAt))
  const deadlineRemainingMs = toolCall.deadlineAt === undefined ? undefined : toolCall.deadlineAt - now
  const elapsed = formatToolDuration(elapsedMs)
  if (toolCall.status === 'denied') return { level: 'denied', label: `${t(language, 'tool.status.denied')} · ${elapsed}`, title: t(language, 'tool.status.deniedDetail'), className: 'text-amber-400' }
  if (toolCall.status === 'timed-out') return { level: 'timed-out', label: `${t(language, 'tool.status.timedOut')} · ${elapsed}`, title: t(language, 'tool.status.timedOutDetail', { elapsed }), className: 'text-red-400' }
  if (toolCall.status === 'cancelled') return { level: 'cancelled', label: `${t(language, 'tool.status.cancelled')} · ${elapsed}`, title: t(language, 'tool.status.cancelled'), className: 'text-amber-400' }
  if (toolCall.status !== 'running') return { level: toolCall.status, label: elapsed, title: t(language, 'tool.status.completedDetail', { elapsed }), className: 'text-[var(--color-text-muted)]' }
  const level = deadlineRemainingMs !== undefined && deadlineRemainingMs <= 0
    ? 'overdue'
    : progressAgeMs >= 60_000
      ? 'stalled'
      : progressAgeMs >= 15_000
        ? 'quiet'
        : 'active'
  const label = level === 'stalled'
    ? `${t(language, 'tool.status.possiblyStalled')} · ${elapsed}`
    : level === 'quiet'
      ? `${t(language, 'tool.status.noProgress')} · ${elapsed}`
      : level === 'overdue'
        ? `${t(language, 'tool.status.deadlineReached')} · ${elapsed}`
        : elapsed
  const title = t(language, 'tool.status.runningDetail', {
    elapsed,
    progress: formatToolDuration(progressAgeMs),
    deadline: deadlineRemainingMs === undefined ? '—' : formatToolDuration(Math.max(0, deadlineRemainingMs))
  })
  return {
    level,
    label,
    title,
    className: level === 'active' ? 'text-[var(--color-text-muted)]' : level === 'quiet' ? 'text-amber-300' : 'text-red-400'
  }
}

function formatToolDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}

interface ToolForgeSummaryView {
  jobId?: string
  toolId?: string
  goal?: string
  status?: string
  requiresApproval?: boolean
  jobRevision?: number
  currentPhase?: string
  attempt?: number
  maxAttempts?: number
  error?: string
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
  const [liveJob, setLiveJob] = useState<GeneratedToolJobStatusView | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [enableError, setEnableError] = useState('')
  const effective = liveJob && (!summary.jobRevision || liveJob.jobRevision >= summary.jobRevision)
    ? {
        ...summary,
        jobId: liveJob.jobId,
        toolId: liveJob.toolId,
        status: liveJob.status,
        requiresApproval: liveJob.requiresApproval,
        jobRevision: liveJob.jobRevision,
        currentPhase: liveJob.currentPhase,
        attempt: liveJob.attempt,
        maxAttempts: liveJob.maxAttempts,
        error: liveJob.error,
        candidateFingerprint: liveJob.candidateFingerprint,
        validationReportId: liveJob.validationReportId,
        capabilityRevision: liveJob.capabilityRevision,
        canOpenWorkbench: liveJob.status === 'completed'
      }
    : summary

  useEffect(() => {
    const jobId = summary.jobId
    if (!jobId) {
      setLiveJob(null)
      return
    }
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const result = await window.joker.generatedTools.jobStatus(jobId)
        if (cancelled) return
        if (result.success) {
          setLiveJob((current) => !current || result.data.jobRevision >= current.jobRevision ? result.data : current)
          if (isTransientGeneratedToolJobStatus(result.data.status)) {
            timer = window.setTimeout(() => { void poll() }, 1_000)
          }
        }
      } catch {
        // The original tool output remains available when the management channel is unavailable.
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [summary.jobId])

  const openWorkbench = (focus: 'overview' | 'edit'): void => {
    if (!effective.toolId) return
    window.dispatchEvent(new CustomEvent('joker:open-generated-tool', {
      detail: {
        toolId: effective.toolId,
        focus,
        requestedFrom: focus === 'edit' ? 'conversation' : 'settings'
      }
    }))
  }

  const enableTool = async (): Promise<void> => {
    if (!effective.jobId || enabling) return
    setEnabling(true)
    setEnableError('')
    try {
      const result = await window.joker.generatedTools.enable({ jobId: effective.jobId })
      if (!result.success) {
        setEnableError(result.error.message)
        return
      }
      const statusResult = await window.joker.generatedTools.jobStatus(effective.jobId)
      if (statusResult.success) setLiveJob(statusResult.data)
    } catch (error) {
      setEnableError(error instanceof Error ? error.message : String(error))
    } finally {
      setEnabling(false)
    }
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
          {effective.goal && (
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">
              {effective.goal}
            </p>
          )}
        </div>
        {effective.status && (
          <span className="rounded-full border border-[var(--color-border-light)] bg-[var(--color-surface-active)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)]">
            {formatToolForgeStatus(language, effective.status)}
          </span>
        )}
      </div>

      <dl className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
        {effective.permissionSummary && (
          <div className="min-w-0">
            <dt className="text-[var(--color-text-muted)]">{t(language, 'toolforge.permissions')}</dt>
            <dd className="truncate text-[var(--color-text-secondary)]" title={effective.permissionSummary}>{effective.permissionSummary}</dd>
          </div>
        )}
      </dl>

      {effective.error && (
        <p className="mt-2 whitespace-pre-wrap break-words rounded-md border border-red-900/60 bg-red-950/30 px-2 py-1.5 text-[11px] leading-5 text-red-300">
          {effective.error}
        </p>
      )}
      {enableError && <p className="mt-2 text-[11px] text-red-300">{enableError}</p>}

      {effective.status === 'awaiting-policy' && effective.jobId && (
        <div className="mt-3">
          <p className="text-xs text-amber-300">{t(language, effective.requiresApproval ? 'toolforge.waitingPermissionHint' : 'toolforge.readyToEnableHint')}</p>
          <button data-testid="toolforge-enable" type="button" onClick={() => void enableTool()} disabled={enabling} className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-md bg-amber-300/15 px-3 text-xs font-semibold text-amber-200 hover:bg-amber-300/25 disabled:opacity-50"><LockKeyhole size={13} /> {enabling ? t(language, 'toolforge.enabling') : t(language, 'toolforge.enable')}</button>
        </div>
      )}

      {effective.canOpenWorkbench && (
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

function ToolExpandedContent({
  toolCall,
  language,
  diffText,
  spill,
  sessionId
}: {
  toolCall: ToolCallInfo
  language: import('../i18n').Language
  diffText: string
  spill: ToolResultSpillRefView | null
  sessionId: string | null
}): React.JSX.Element {
  const hasDiff = diffText.length > 0
  const outputPreview = toolCall.output ? getToolOutputPreview(toolCall.toolName, toolCall.output, language) : null
  const requestRevisionRef = useRef(0)
  const spillLoadingRef = useRef(false)
  const [spillState, setSpillState] = useState<SpillReadState>(initialSpillReadState)
  const [spillLoading, setSpillLoading] = useState(false)
  const [spillError, setSpillError] = useState('')

  useEffect(() => {
    requestRevisionRef.current += 1
    setSpillState(initialSpillReadState)
    spillLoadingRef.current = false
    setSpillLoading(false)
    setSpillError('')
  }, [sessionId, spill?.id])

  const loadMoreSpill = async (): Promise<void> => {
    if (!spill || !sessionId || spillLoadingRef.current || spillState.eof) return
    const revision = ++requestRevisionRef.current
    spillLoadingRef.current = true
    setSpillLoading(true)
    setSpillError('')
    try {
      const [chunk] = await Promise.all([
        window.joker.session.readToolResult(sessionId, spill.id, spillState.nextOffsetBytes, 64_000),
        new Promise<void>((resolve) => window.setTimeout(resolve, 150))
      ])
      if (revision !== requestRevisionRef.current) return
      if (!chunk) throw new Error(t(language, 'tool.spill.unavailable'))
      setSpillState(appendSpillChunk(spillState, chunk))
    } catch (error) {
      if (revision !== requestRevisionRef.current) return
      setSpillError(error instanceof Error ? error.message : String(error))
    } finally {
      if (revision === requestRevisionRef.current) {
        spillLoadingRef.current = false
        setSpillLoading(false)
      }
    }
  }

  return (
    <div className="border-t border-[var(--color-border)]/70 px-2 py-1.5">
      {outputPreview && !(toolCall.toolName === 'Edit' && hasDiff) && (
        <div className={hasDiff ? 'mb-2' : undefined}>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, spill ? 'tool.spill.preview' : 'tool.output')}</p>
          <pre data-tool-spill-preview={spill ? '' : undefined} className="max-w-full overflow-hidden whitespace-pre-wrap break-words rounded bg-[var(--color-bg)] p-2 text-xs text-[var(--color-text-secondary)]">
            {outputPreview.text}
          </pre>
        </div>
      )}

      {spill && (
        <div data-tool-spill className={`${outputPreview ? 'mt-2' : ''} rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/55 p-2`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{t(language, 'tool.spill.fullResult')}</p>
              <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                {t(language, 'tool.spill.progress', {
                  loaded: formatBytes(spillState.loadedBytes),
                  total: formatBytes(spillState.totalBytes ?? spill.bytes)
                })}
              </p>
            </div>
            {!spillState.eof && (
              <button
                data-tool-spill-load-more
                type="button"
                onClick={() => void loadMoreSpill()}
                disabled={spillLoading || !sessionId}
                className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-[var(--color-border-light)] px-2 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {spillLoading && <Loader2 data-tool-spill-loading size={12} className="animate-spin text-[var(--color-accent)]" />}
                {spillLoading ? t(language, 'tool.spill.loading') : t(language, spillError ? 'tool.spill.retry' : 'tool.spill.loadMore')}
              </button>
            )}
          </div>
          {spillState.content && (
            <pre data-tool-spill-content className="mt-2 max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-[#08090a] p-2 text-xs leading-5 text-[var(--color-text-secondary)]">
              {spillState.content}
            </pre>
          )}
          {spillError && (
            <p data-tool-spill-error role="alert" className="mt-2 rounded border border-red-900/70 bg-red-950/25 px-2 py-1.5 text-[11px] text-red-300">
              {t(language, 'tool.spill.error', { error: spillError })}
            </p>
          )}
          {!sessionId && !spillError && (
            <p data-tool-spill-error role="alert" className="mt-2 rounded border border-amber-800/70 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-200">
              {t(language, 'tool.spill.unavailable')}
            </p>
          )}
          {spillState.eof && (
            <p data-tool-spill-eof className="mt-2 text-[11px] text-emerald-400">{t(language, 'tool.spill.eof')}</p>
          )}
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
  const jobId = stringValue(output?.jobId) ?? stringValue(toolCall.input.jobId)
  return {
    jobId,
    toolId,
    goal: stringValue(spec?.goal) ?? stringValue(spec?.reason),
    status,
    requiresApproval: typeof output?.requiresApproval === 'boolean' ? output.requiresApproval : undefined,
    jobRevision: numberValue(output?.jobRevision) ?? numberValue(output?.revision),
    currentPhase: stringValue(output?.currentPhase),
    attempt: numberValue(output?.attempt),
    maxAttempts: numberValue(output?.maxAttempts),
    error: stringValue(output?.error) ?? stringValue(output?.reason),
    permissionSummary: permissionSummary(spec?.permissions, language),
    candidateFingerprint: stringValue(output?.candidateFingerprint),
    validationReportId: stringValue(output?.validationReportId),
    capabilityRevision: numberValue(output?.capabilityRevision),
    canOpenWorkbench: Boolean(toolId && status === 'completed')
  }
}

function formatToolForgeStatus(
  language: import('../i18n').Language,
  status: string
): string {
  const productState = generatedToolJobProductState(status)
  if (productState) return t(language, `toolforge.productState.${productState}`)
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
