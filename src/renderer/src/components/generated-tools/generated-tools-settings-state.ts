import type {
  ForgeJobStatus,
  GeneratedToolContinuationView,
  GeneratedToolInventoryItem,
  GeneratedToolsInventorySnapshot,
  ToolForgeContinuationV2Status
} from '@shared/types'

const TRANSIENT_JOB_STATUSES = new Set<ForgeJobStatus>(['queued', 'planning', 'building', 'validating', 'promoting'])
const TRANSIENT_CONTINUATION_STATUSES = new Set<ToolForgeContinuationV2Status>(['ready', 'dispatched', 'running'])
const STALE_CAS_PATTERN = /\bstale\b|revision[^\n]*mismatch|expected[^\n]*revision/i

export type GeneratedToolProductState =
  | 'manufacturing'
  | 'enabled'
  | 'disabled'
  | 'validation-failed'
  | 'waiting-permission'

export function isTransientGeneratedToolJobStatus(status: ForgeJobStatus | string | undefined): boolean {
  return typeof status === 'string' && TRANSIENT_JOB_STATUSES.has(status as ForgeJobStatus)
}

export function generatedToolJobProductState(status: ForgeJobStatus | string | undefined): GeneratedToolProductState | null {
  if (isTransientGeneratedToolJobStatus(status)) return 'manufacturing'
  if (status === 'awaiting-policy') return 'waiting-permission'
  if (status === 'completed') return 'enabled'
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return 'validation-failed'
  return null
}

export function generatedToolProductState(item: GeneratedToolInventoryItem): GeneratedToolProductState {
  const candidateState = generatedToolJobProductState(item.candidate?.status)
  if (candidateState === 'manufacturing' || candidateState === 'waiting-permission') return candidateState
  if (item.availability === 'permission-required') return 'waiting-permission'
  if (item.availability === 'disabled') return 'disabled'
  if (item.activeVersionId && item.availability === 'available' && item.integrity === 'verified') return 'enabled'
  return 'validation-failed'
}

export function hasFailedGeneratedToolUpdate(item: GeneratedToolInventoryItem): boolean {
  return Boolean(item.activeVersionId && item.candidate && ['failed', 'cancelled', 'interrupted'].includes(item.candidate.status))
}

export function shouldPollGeneratedTools(
  snapshot: GeneratedToolsInventorySnapshot | null,
  continuations: GeneratedToolContinuationView[]
): boolean {
  const qualificationStatus = snapshot?.qualificationOperation?.status
  if (qualificationStatus === 'queued' || qualificationStatus === 'running') return true
  if (snapshot?.tools.some((tool) => isTransientGeneratedToolJobStatus(tool.candidate?.status))) return true
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
