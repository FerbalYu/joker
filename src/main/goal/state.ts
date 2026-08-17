import type {
  GoalCas,
  GoalCreateInput,
  GoalExecutionContext,
  GoalHistoryEntry,
  GoalState,
  GoalStatus,
  GoalStopReason,
  ReasoningLevel,
  StreamUsage
} from '../../shared/types'
import { REASONING_LEVELS } from '../../shared/types'

export const MAX_GOAL_OBJECTIVE_LENGTH = 4_000
export const MAX_GOAL_FEEDBACK_LENGTH = 8_000
export const MAX_GOAL_EVALUATION_LENGTH = 16_000
export const MAX_GOAL_ID_LENGTH = 128
export const MAX_GOAL_SKILL_IDS = 64
export const MAX_GOAL_HISTORY = 128
export const MAX_GOAL_USAGE_OPERATIONS = 128
export const MAX_GOAL_ROUNDS = 100
export const MAX_GOAL_TOKEN_LIMIT = 1_000_000_000
export const LEGACY_DEFAULT_GOAL_TOKEN_LIMIT = 1_000_000
export const DEFAULT_GOAL_MAX_ROUNDS = 10

const GOAL_STATUSES: readonly GoalStatus[] = [
  'queued',
  'executing',
  'validating',
  'paused',
  'blocked',
  'completed',
  'interrupted'
]
const GOAL_STOP_REASONS: readonly GoalStopReason[] = [
  'user-paused',
  'legacy-migration',
  'recovered-after-restart',
  'max-rounds',
  'token-limit',
  'evaluator-blocked',
  'completed',
  'execution-error',
  'evaluation-error'
]
const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'noCacheTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'stepCount',
  'firstTokenMs',
  'generationMs'
] as const
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function isTimestamp(value: unknown): value is number {
  return isBoundedInteger(value, 0, Number.MAX_SAFE_INTEGER)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

function isOptionalBoundedText(value: unknown, maximum: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim())
}

export function isValidStreamUsage(value: unknown): value is StreamUsage {
  if (!isRecord(value) || !hasOnlyKeys(value, USAGE_KEYS)) return false
  return USAGE_KEYS.every((key) => value[key] === undefined || isBoundedInteger(value[key], 0, Number.MAX_SAFE_INTEGER))
}

export function addGoalUsage(left: StreamUsage, right: StreamUsage): StreamUsage {
  const result: StreamUsage = {}
  for (const key of USAGE_KEYS) {
    const leftValue = left[key]
    const rightValue = right[key]
    if (key === 'firstTokenMs') {
      if (leftValue !== undefined && rightValue !== undefined) result.firstTokenMs = Math.min(leftValue, rightValue)
      else if (leftValue !== undefined || rightValue !== undefined) result.firstTokenMs = (leftValue ?? rightValue) as number
      continue
    }
    if (leftValue !== undefined || rightValue !== undefined) result[key] = (leftValue ?? 0) + (rightValue ?? 0)
  }
  const leftTotal = Math.max(left.totalTokens ?? 0, (left.inputTokens ?? 0) + (left.outputTokens ?? 0))
  const rightTotal = Math.max(right.totalTokens ?? 0, (right.inputTokens ?? 0) + (right.outputTokens ?? 0))
  if (leftTotal > 0 || rightTotal > 0) result.totalTokens = leftTotal + rightTotal
  return result
}

export function sameGoalUsage(left: StreamUsage, right: StreamUsage): boolean {
  return USAGE_KEYS.every((key) => left[key] === right[key])
}

function isValidExecutionContext(value: unknown): value is GoalExecutionContext {
  if (!isRecord(value) || !hasOnlyKeys(value, ['projectId', 'skillIds', 'reasoningLevel'])) return false
  if (value.projectId !== undefined && (typeof value.projectId !== 'string' || !IDENTIFIER_PATTERN.test(value.projectId))) return false
  if (!Array.isArray(value.skillIds) || value.skillIds.length > MAX_GOAL_SKILL_IDS) return false
  if (!value.skillIds.every((id) => typeof id === 'string' && SKILL_ID_PATTERN.test(id))) return false
  if (new Set(value.skillIds).size !== value.skillIds.length) return false
  return typeof value.reasoningLevel === 'string' && REASONING_LEVELS.includes(value.reasoningLevel as ReasoningLevel)
}

function isValidHistoryEntry(value: unknown): value is GoalHistoryEntry {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'phase', 'status', 'round', 'revision', 'createdAt', 'invocationId', 'messageId',
    'usageOperationId', 'usage', 'feedback', 'evaluation', 'stopReason'
  ])) return false
  return (value.phase === 'execution' || value.phase === 'validation' || value.phase === 'system') &&
    typeof value.status === 'string' && GOAL_STATUSES.includes(value.status as GoalStatus) &&
    isBoundedInteger(value.round, 1, MAX_GOAL_ROUNDS) &&
    isBoundedInteger(value.revision, 0, Number.MAX_SAFE_INTEGER) &&
    isTimestamp(value.createdAt) &&
    (value.invocationId === undefined || isIdentifier(value.invocationId)) &&
    (value.messageId === undefined || isIdentifier(value.messageId)) &&
    (value.usageOperationId === undefined || isIdentifier(value.usageOperationId)) &&
    (value.usage === undefined || isValidStreamUsage(value.usage)) &&
    isOptionalBoundedText(value.feedback, MAX_GOAL_FEEDBACK_LENGTH) &&
    isOptionalBoundedText(value.evaluation, MAX_GOAL_EVALUATION_LENGTH) &&
    (value.stopReason === undefined || (typeof value.stopReason === 'string' && GOAL_STOP_REASONS.includes(value.stopReason as GoalStopReason)))
}

export function isValidGoalState(value: unknown): value is GoalState {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'objective', 'status', 'generation', 'revision', 'currentRound', 'history',
    'currentInvocationIds', 'executionContext', 'cumulativeUsage', 'appliedUsageOperations',
    'maxRounds', 'tokenLimit', 'createdAt', 'updatedAt', 'startedAt', 'completedAt',
    'pausedAt', 'resumePhase', 'feedback', 'evaluation', 'stopReason'
  ])) return false
  if (!isIdentifier(value.id)) return false
  if (typeof value.objective !== 'string' || value.objective.length === 0 || value.objective.length > MAX_GOAL_OBJECTIVE_LENGTH || value.objective !== value.objective.trim()) return false
  if (typeof value.status !== 'string' || !GOAL_STATUSES.includes(value.status as GoalStatus)) return false
  if (!isBoundedInteger(value.generation, 1, Number.MAX_SAFE_INTEGER) || !isBoundedInteger(value.revision, 0, Number.MAX_SAFE_INTEGER)) return false
  if (!isBoundedInteger(value.maxRounds, 1, MAX_GOAL_ROUNDS) || !isBoundedInteger(value.currentRound, 1, value.maxRounds)) return false
  if (value.tokenLimit !== undefined && !isBoundedInteger(value.tokenLimit, 1, MAX_GOAL_TOKEN_LIMIT)) return false
  if (!Array.isArray(value.history) || value.history.length > MAX_GOAL_HISTORY || !value.history.every(isValidHistoryEntry)) return false
  if (!isRecord(value.currentInvocationIds) || !hasOnlyKeys(value.currentInvocationIds, ['execution', 'validation'])) return false
  if (value.currentInvocationIds.execution !== undefined && !isIdentifier(value.currentInvocationIds.execution)) return false
  if (value.currentInvocationIds.validation !== undefined && !isIdentifier(value.currentInvocationIds.validation)) return false
  if (!isValidExecutionContext(value.executionContext) || !isValidStreamUsage(value.cumulativeUsage)) return false
  if (!Array.isArray(value.appliedUsageOperations) || value.appliedUsageOperations.length > MAX_GOAL_USAGE_OPERATIONS) return false
  if (!value.appliedUsageOperations.every((operation) => isRecord(operation) && hasOnlyKeys(operation, ['id', 'invocationId', 'phase', 'messageId', 'usage', 'appliedAt']) &&
    isIdentifier(operation.id) && isIdentifier(operation.invocationId) &&
    (operation.phase === undefined || operation.phase === 'execution' || operation.phase === 'validation') &&
    (operation.messageId === undefined || isIdentifier(operation.messageId)) &&
    (operation.phase === 'validation' || operation.messageId !== undefined) &&
    isValidStreamUsage(operation.usage) && isTimestamp(operation.appliedAt))) return false
  if (new Set(value.appliedUsageOperations.map((operation) => operation.id)).size !== value.appliedUsageOperations.length) return false
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) return false
  if (value.startedAt !== undefined && !isTimestamp(value.startedAt)) return false
  if (value.completedAt !== undefined && !isTimestamp(value.completedAt)) return false
  if (value.pausedAt !== undefined && !isTimestamp(value.pausedAt)) return false
  if (value.resumePhase !== undefined && value.resumePhase !== 'execution' && value.resumePhase !== 'validation') return false
  if (!isOptionalBoundedText(value.feedback, MAX_GOAL_FEEDBACK_LENGTH) || !isOptionalBoundedText(value.evaluation, MAX_GOAL_EVALUATION_LENGTH)) return false
  if (value.stopReason !== undefined && (typeof value.stopReason !== 'string' || !GOAL_STOP_REASONS.includes(value.stopReason as GoalStopReason))) return false
  if (value.status === 'executing' && !value.currentInvocationIds.execution) return false
  if (value.status !== 'executing' && value.currentInvocationIds.execution !== undefined) return false
  if (value.status !== 'validating' && value.currentInvocationIds.validation !== undefined) return false
  if (value.status === 'completed' && (value.completedAt === undefined || value.stopReason !== 'completed')) return false
  if (value.status !== 'completed' && value.completedAt !== undefined) return false
  const maxRounds = value.maxRounds
  const revision = value.revision
  return value.history.every((entry) => entry.round <= maxRounds && entry.revision <= revision)
}

export function normalizeGoalCreateInput(value: unknown): GoalCreateInput | null {
  if (typeof value === 'string') value = { objective: value }
  if (!isRecord(value) || !hasOnlyKeys(value, ['objective', 'executionContext', 'maxRounds', 'tokenLimit'])) return null
  if (typeof value.objective !== 'string') return null
  const objective = value.objective.trim()
  if (!objective || objective.length > MAX_GOAL_OBJECTIVE_LENGTH) return null
  const execution = value.executionContext
  if (execution !== undefined && !isRecord(execution)) return null
  if (execution && !hasOnlyKeys(execution, ['projectId', 'skillIds', 'reasoningLevel'])) return null
  const projectId = execution?.projectId
  const rawSkillIds = execution?.skillIds ?? []
  if (!Array.isArray(rawSkillIds)) return null
  const skillIds = rawSkillIds as string[]
  const reasoningLevel = execution?.reasoningLevel ?? 'auto'
  const context = { projectId, skillIds, reasoningLevel }
  if (!isValidExecutionContext(context)) return null
  const maxRounds = value.maxRounds ?? DEFAULT_GOAL_MAX_ROUNDS
  const tokenLimit = value.tokenLimit
  if (!isBoundedInteger(maxRounds, 1, MAX_GOAL_ROUNDS)) return null
  if (tokenLimit !== undefined && !isBoundedInteger(tokenLimit, 1, MAX_GOAL_TOKEN_LIMIT)) return null
  return {
    objective,
    executionContext: {
      ...(typeof projectId === 'string' ? { projectId } : {}),
      skillIds: [...skillIds],
      reasoningLevel: reasoningLevel as ReasoningLevel
    },
    maxRounds,
    ...(tokenLimit === undefined ? {} : { tokenLimit })
  }
}

export function createGoalState(input: GoalCreateInput, generation: number, now: number, id: string = crypto.randomUUID()): GoalState {
  const context = input.executionContext ?? {}
  return {
    id,
    objective: input.objective,
    status: 'queued',
    generation,
    revision: 0,
    currentRound: 1,
    history: [],
    currentInvocationIds: {},
    executionContext: {
      ...(context.projectId ? { projectId: context.projectId } : {}),
      skillIds: [...(context.skillIds ?? [])],
      reasoningLevel: context.reasoningLevel ?? 'auto'
    },
    cumulativeUsage: {},
    appliedUsageOperations: [],
    maxRounds: input.maxRounds ?? DEFAULT_GOAL_MAX_ROUNDS,
    ...(input.tokenLimit === undefined ? {} : { tokenLimit: input.tokenLimit }),
    createdAt: now,
    updatedAt: now
  }
}

export function migrateLegacyGoal(objective: string, now: number, id?: string): GoalState | null {
  const normalized = normalizeGoalCreateInput({ objective })
  if (!normalized) return null
  const goal = createGoalState(normalized, 1, now, id)
  goal.status = 'interrupted'
  goal.stopReason = 'legacy-migration'
  goal.history = [{
    phase: 'system',
    status: 'interrupted',
    round: 1,
    revision: 0,
    createdAt: now,
    stopReason: 'legacy-migration'
  }]
  return goal
}

export function normalizeRecoveredGoal(goal: GoalState, recoveredAt: number): GoalState {
  if (goal.status !== 'executing' && goal.status !== 'validating') return goal
  const revision = goal.revision + 1
  const recovered: GoalState = {
    ...goal,
    status: 'interrupted',
    revision,
    currentInvocationIds: {},
    updatedAt: Math.max(goal.updatedAt, recoveredAt),
    stopReason: 'recovered-after-restart',
    resumePhase: goal.status === 'validating' ? 'validation' : 'execution',
    history: boundedHistory(goal.history, {
      phase: 'system',
      status: 'interrupted',
      round: goal.currentRound,
      revision,
      createdAt: Math.max(goal.updatedAt, recoveredAt),
      stopReason: 'recovered-after-restart'
    })
  }
  return recovered
}

export function goalCasMatches(goal: GoalState, expected: GoalCas): boolean {
  return goal.id === expected.goalId && goal.generation === expected.generation && goal.revision === expected.revision
}

export function boundedHistory(history: GoalHistoryEntry[], entry: GoalHistoryEntry): GoalHistoryEntry[] {
  return [...history, entry].slice(-MAX_GOAL_HISTORY)
}

export function normalizeGoalCas(value: unknown): GoalCas | null {
  if (!isRecord(value) || !isIdentifier(value.goalId) ||
    !isBoundedInteger(value.generation, 1, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.revision, 0, Number.MAX_SAFE_INTEGER)) return null
  return { goalId: value.goalId, generation: value.generation, revision: value.revision }
}

export function isValidGoalCas(value: unknown): boolean {
  return normalizeGoalCas(value) !== null
}

export function isValidGoalIdentifier(value: unknown): value is string {
  return isIdentifier(value)
}

export function isValidGoalText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim()
}
