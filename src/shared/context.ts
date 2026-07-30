import type { StreamUsage } from './types'

export const CONTEXT_OPTIMIZATION_MODES = ['legacy', 'observe', 'v2', 'disabled'] as const
export type ContextOptimizationMode = typeof CONTEXT_OPTIMIZATION_MODES[number]

export const DEFAULT_CONTEXT_POLICY_VERSION = 'context-v2.1'
export const DEFAULT_CONTEXT_OUTPUT_RESERVE = 8_192
export const DEFAULT_CONTEXT_SAFETY_RESERVE = 4_096
export const MIN_CONTEXT_INPUT_BUDGET = 2_048

export interface ContextBudget {
  maxContextTokens: number
  outputTokenReserve: number
  safetyReserve: number
  inputBudget: number
  compressionThreshold: number
}

export function normalizeContextOptimizationMode(value: unknown): ContextOptimizationMode {
  return typeof value === 'string' && (CONTEXT_OPTIMIZATION_MODES as readonly string[]).includes(value)
    ? value as ContextOptimizationMode
    : 'legacy'
}

export function createSafeContextBudget(options: {
  maxContextTokens: number
  outputTokenReserve?: number
  safetyReserve?: number
  triggerRatio?: number
}): ContextBudget {
  const maxContextTokens = positiveInteger(options.maxContextTokens, 262_144)
  const safetyReserve = Math.min(
    positiveInteger(options.safetyReserve, DEFAULT_CONTEXT_SAFETY_RESERVE),
    Math.max(0, maxContextTokens - MIN_CONTEXT_INPUT_BUDGET)
  )
  const maximumOutputReserve = Math.max(0, maxContextTokens - safetyReserve - MIN_CONTEXT_INPUT_BUDGET)
  const outputTokenReserve = Math.min(
    positiveInteger(options.outputTokenReserve, DEFAULT_CONTEXT_OUTPUT_RESERVE),
    maximumOutputReserve
  )
  const inputBudget = Math.max(MIN_CONTEXT_INPUT_BUDGET, maxContextTokens - outputTokenReserve - safetyReserve)
  const ratio = typeof options.triggerRatio === 'number' && Number.isFinite(options.triggerRatio)
    ? Math.min(0.95, Math.max(0.5, options.triggerRatio))
    : 0.8
  return {
    maxContextTokens,
    outputTokenReserve,
    safetyReserve,
    inputBudget,
    compressionThreshold: Math.max(MIN_CONTEXT_INPUT_BUDGET, Math.min(Math.floor(maxContextTokens * ratio), inputBudget))
  }
}

export interface SessionContextSummary {
  goal: string
  confirmedFacts: string[]
  decisions: string[]
  filesRead: string[]
  changesMade: string[]
  failedAttempts: string[]
  openTasks: string[]
  criticalIdentifiers: string[]
}

export interface SessionContextCheckpoint {
  version: 1
  policyVersion: string
  sourceFromMessageId: string
  sourceUntilMessageId: string
  sourceHash: string
  createdAt: number
  summary: SessionContextSummary
  estimatedSourceTokens: number
  estimatedSummaryTokens: number
  summaryUsage?: StreamUsage
}

export type ContextReferenceSource = 'message' | 'tool-result' | 'artifact'

export interface ContextReference {
  contextId: string
  sessionId: string
  messageId: string
  toolCallId?: string
  sourceType: ContextReferenceSource
  sourceName?: string
  contentHash: string
  originalTokens: number
  projectedTokens: number
  createdAt: number
}

export interface ContextTransformMetric {
  sourceType?: string
  transform: string
  beforeTokens: number
  afterTokens: number
  durationMs?: number
  contextId?: string
  retrievable?: boolean
  error?: string
}

export interface ContextOptimizationMetrics {
  policyVersion?: string
  mode: ContextOptimizationMode
  transforms?: ContextTransformMetric[]
  lastTransform?: ContextTransformMetric
  summaryInputTokens?: number
  summaryOutputTokens?: number
  retrievalInputTokens?: number
  retrievalOutputTokens?: number
  estimatedAvoidedInputTokens?: number
  estimatedNetSavedTokens?: number
  retrievalCount?: number
  retrievalFailureCount?: number
  checkpointReused?: boolean
  error?: string
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}
