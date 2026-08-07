import type {
  ForgeJobStatus,
  GeneratedToolContinuationView,
  GeneratedToolsInventorySnapshot,
  ToolForgeContinuationV2Status
} from '@shared/types'

const TRANSIENT_JOB_STATUSES = new Set<ForgeJobStatus>(['queued', 'planning', 'building', 'validating', 'promoting'])
const TRANSIENT_CONTINUATION_STATUSES = new Set<ToolForgeContinuationV2Status>(['ready', 'dispatched', 'running'])
const STALE_CAS_PATTERN = /\bstale\b|revision[^\n]*mismatch|expected[^\n]*revision/i

export function shouldPollGeneratedTools(
  snapshot: GeneratedToolsInventorySnapshot | null,
  continuations: GeneratedToolContinuationView[]
): boolean {
  const qualificationStatus = snapshot?.qualificationOperation?.status
  if (qualificationStatus === 'queued' || qualificationStatus === 'running') return true
  if (snapshot?.tools.some((tool) => tool.candidate && TRANSIENT_JOB_STATUSES.has(tool.candidate.status))) return true
  return continuations.some((continuation) => TRANSIENT_CONTINUATION_STATUSES.has(continuation.status))
}

export function isStaleGeneratedToolsCasError(error: unknown): boolean {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : ''
  return STALE_CAS_PATTERN.test(message)
}
