import type { ChatMessage, StreamUsage, SubagentActivity, SubagentPhase, SubagentStatus, SubagentToolActivity } from '@shared/types'

const STATUSES = new Set<SubagentStatus>(['queued', 'running', 'completed', 'failed', 'cancelled'])
const PHASES = new Set<SubagentPhase>(['queued', 'starting', 'working', 'using-tool', 'finalizing', 'completed', 'failed', 'cancelled'])
const TOOL_STATUSES = new Set<SubagentToolActivity['status']>(['running', 'done', 'error', 'denied'])

export function subagentActivitiesForView(live: SubagentActivity[], messages: ChatMessage[]): SubagentActivity[] {
  const merged = new Map<string, SubagentActivity>()
  for (const message of messages) {
    for (const tool of messageTools(message)) {
      if (tool.toolName !== 'Agent') continue
      const activity = parseSubagentActivity(tool.metadata?.subagentActivity)
      if (activity) merged.set(activity.id, activity)
    }
  }
  for (const activity of live) merged.set(activity.id, cloneActivity(activity))
  return [...merged.values()]
    .sort((left, right) => statusRank(left.status) - statusRank(right.status) || right.updatedAt - left.updatedAt)
    .slice(0, 8)
}

export function parseSubagentActivity(value: unknown): SubagentActivity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || typeof input.task !== 'string') return null
  if (!STATUSES.has(input.status as SubagentStatus) || !PHASES.has(input.phase as SubagentPhase)) return null
  if (!isFiniteNumber(input.createdAt) || !isFiniteNumber(input.updatedAt)) return null
  if (!isFiniteNumber(input.currentStep) || !isFiniteNumber(input.maxSteps)) return null
  if (!Array.isArray(input.tools)) return null
  const tools = input.tools.map(parseToolActivity).filter((item): item is SubagentToolActivity => item !== null).slice(-40)
  const usage = parseUsage(input.usage)
  return {
    id: input.id,
    ...(typeof input.parentToolCallId === 'string' ? { parentToolCallId: input.parentToolCallId } : {}),
    task: input.task,
    status: input.status as SubagentStatus,
    phase: input.phase as SubagentPhase,
    createdAt: input.createdAt,
    ...(isFiniteNumber(input.startedAt) ? { startedAt: input.startedAt } : {}),
    updatedAt: input.updatedAt,
    ...(isFiniteNumber(input.completedAt) ? { completedAt: input.completedAt } : {}),
    currentStep: Math.max(0, Math.floor(input.currentStep)),
    maxSteps: Math.max(1, Math.floor(input.maxSteps)),
    tools,
    ...(typeof input.outputPreview === 'string' ? { outputPreview: input.outputPreview } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof input.error === 'string' ? { error: input.error } : {})
  }
}

function parseToolActivity(value: unknown): SubagentToolActivity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || typeof input.toolName !== 'string') return null
  if (!TOOL_STATUSES.has(input.status as SubagentToolActivity['status']) || !isFiniteNumber(input.startedAt)) return null
  return {
    id: input.id,
    toolName: input.toolName,
    ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
    status: input.status as SubagentToolActivity['status'],
    startedAt: input.startedAt,
    ...(isFiniteNumber(input.completedAt) ? { completedAt: input.completedAt } : {}),
    ...(isFiniteNumber(input.durationMs) ? { durationMs: Math.max(0, input.durationMs) } : {}),
    ...(typeof input.error === 'string' ? { error: input.error } : {})
  }
}

function parseUsage(value: unknown): StreamUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const usage: StreamUsage = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'noCacheTokens', 'cacheReadTokens', 'cacheWriteTokens', 'stepCount'] as const) {
    if (isFiniteNumber(input[key])) usage[key] = input[key]
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

function messageTools(message: ChatMessage) {
  return message.segments?.length
    ? message.segments.flatMap((segment) => segment.type === 'tools' ? segment.tools : [])
    : message.toolCalls ?? []
}

function statusRank(status: SubagentStatus): number {
  return status === 'running' ? 0 : status === 'queued' ? 1 : 2
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function cloneActivity(activity: SubagentActivity): SubagentActivity {
  return { ...activity, tools: activity.tools.map((tool) => ({ ...tool })), ...(activity.usage ? { usage: { ...activity.usage } } : {}) }
}
