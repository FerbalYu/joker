import type { ContextUsage } from '@shared/types'

export type ContextOptimizationMode = 'legacy' | 'observe' | 'v2' | 'disabled'

export interface ContextTransformView {
  sourceType?: string
  transform: string
  beforeTokens: number
  afterTokens: number
  durationMs?: number
  contextId?: string
  retrievable: boolean
  error?: string
}

export interface ContextOptimizationView {
  mode?: ContextOptimizationMode
  policyVersion?: string
  latestTransform?: ContextTransformView
  summaryInputTokens: number
  summaryOutputTokens: number
  estimatedNetSavedTokens?: number
  retrievalCount: number
  retrievalFailureCount: number
  error?: string
}

type OptimizationPayload = Partial<ContextOptimizationView> & {
  transforms?: Array<Partial<ContextTransformView>>
  lastTransform?: Partial<ContextTransformView>
  optimizationError?: string
}

type UsageWithOptimization = ContextUsage & OptimizationPayload & {
  optimization?: OptimizationPayload
  contextOptimization?: OptimizationPayload
}

const MODES: ContextOptimizationMode[] = ['legacy', 'observe', 'v2', 'disabled']

export function contextOptimizationView(usage: ContextUsage): ContextOptimizationView | null {
  const candidate = usage as UsageWithOptimization
  const nested = candidate.optimization ?? candidate.contextOptimization
  const payload: OptimizationPayload = nested ? { ...candidate, ...nested } : candidate
  const transforms = Array.isArray(payload.transforms) ? payload.transforms : []
  const rawTransform = payload.lastTransform ?? transforms.at(-1)
  const legacyTransform = usage.compressionBeforeTokens !== undefined && usage.compressionAfterTokens !== undefined
    ? {
        transform: 'legacy-summary',
        beforeTokens: usage.compressionBeforeTokens,
        afterTokens: usage.compressionAfterTokens,
        retrievable: false
      }
    : undefined
  const transform = normalizeTransform(rawTransform) ?? legacyTransform
  const mode = MODES.includes(payload.mode as ContextOptimizationMode) ? payload.mode as ContextOptimizationMode : undefined
  const summaryInputTokens = finiteNonNegative(payload.summaryInputTokens)
  const summaryOutputTokens = finiteNonNegative(payload.summaryOutputTokens)
  const retrievalCount = finiteNonNegative(payload.retrievalCount)
  const retrievalFailureCount = finiteNonNegative(payload.retrievalFailureCount)
  const estimatedNetSavedTokens = finiteNumber(payload.estimatedNetSavedTokens)
  const error = stringValue(payload.error) ?? stringValue(payload.optimizationError) ?? normalizeTransform(rawTransform)?.error ?? usage.compressionError
  const policyVersion = stringValue(payload.policyVersion)

  if (!mode && !policyVersion && !transform && !summaryInputTokens && !summaryOutputTokens && estimatedNetSavedTokens === undefined && !retrievalCount && !retrievalFailureCount && !error) return null

  return {
    mode,
    policyVersion,
    latestTransform: transform,
    summaryInputTokens,
    summaryOutputTokens,
    estimatedNetSavedTokens,
    retrievalCount,
    retrievalFailureCount,
    error
  }
}

function normalizeTransform(value: Partial<ContextTransformView> | undefined): ContextTransformView | undefined {
  if (!value || !stringValue(value.transform)) return undefined
  const contextId = stringValue(value.contextId)
  return {
    sourceType: stringValue(value.sourceType),
    transform: value.transform as string,
    beforeTokens: finiteNonNegative(value.beforeTokens),
    afterTokens: finiteNonNegative(value.afterTokens),
    durationMs: finiteNumber(value.durationMs),
    contextId,
    retrievable: typeof value.retrievable === 'boolean' ? value.retrievable : Boolean(contextId),
    error: stringValue(value.error)
  }
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
