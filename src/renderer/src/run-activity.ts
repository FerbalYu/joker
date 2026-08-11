import type { ApprovalRequest, GoalState, RunMode, StreamEvent, ToolCallInfo } from '@shared/types'
import type { Language } from './i18n'

export type RunActivityPhase =
  | 'idle'
  | 'starting'
  | 'waiting-model'
  | 'streaming-text'
  | 'running-tools'
  | 'awaiting-approval'
  | 'finalizing'
  | 'cancelling'
  | 'cancelled'
  | 'failed'

export type RunActivityDataStatus = 'idle' | 'running' | 'waiting' | 'cancelling' | 'cancelled' | 'failed'

export interface RunActivityState {
  phase: RunActivityPhase
  runId: string | null
  sessionId: string | null
  runMode: RunMode | null
  toolCalls: ToolCallInfo[]
  approval: ApprovalRequest | null
  goal: GoalState | null
  error: string | null
}

interface StepStartEvent {
  type: 'step-start'
  sessionId: string
  runId?: string
  runMode?: RunMode
  stepNumber?: number
}

type RunActivityStreamEvent = Exclude<StreamEvent, { type: 'step-start' }> | StepStartEvent

export type RunActivityAction =
  | {
      type: 'send-accepted'
      runId: string
      sessionId: string
      runMode: RunMode
      goal?: GoalState
    }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved'; requestId: string }
  | { type: 'abort-request' }
  | RunActivityStreamEvent

export interface RunActivityViewModel {
  phase: RunActivityPhase
  label: string
  dataStatus: RunActivityDataStatus
  runMode?: RunMode
  goal?: GoalState
  toolCount?: number
  toolName?: string
  error?: string
}

export const initialRunActivityState: RunActivityState = {
  phase: 'idle',
  runId: null,
  sessionId: null,
  runMode: null,
  toolCalls: [],
  approval: null,
  goal: null,
  error: null
}

export function runActivityReducer(state: RunActivityState, action: RunActivityAction): RunActivityState {
  if (action.type === 'send-accepted') {
    return {
      phase: 'starting',
      runId: action.runId,
      sessionId: action.sessionId,
      runMode: action.runMode,
      toolCalls: [],
      approval: null,
      goal: action.goal ?? null,
      error: null
    }
  }

  if (action.type === 'abort-request') return { ...state, phase: 'cancelling' }

  if (action.type === 'approval') {
    return {
      ...state,
      phase: 'awaiting-approval',
      approval: action.request
    }
  }

  if (action.type === 'approval-resolved') {
    if (state.approval?.requestId !== action.requestId) return state
    return {
      ...state,
      phase: state.toolCalls.some((toolCall) => toolCall.status === 'running') ? 'running-tools' : 'waiting-model',
      approval: null
    }
  }

  const eventType: string = action.type
  if (eventType === 'message-start' || eventType === 'step-start') {
    const event = action as Extract<RunActivityStreamEvent, { type: 'message-start' | 'step-start' }>
    return {
      ...state,
      phase: 'waiting-model',
      runMode: event.runMode ?? state.runMode,
      approval: null,
      error: null
    }
  }

  switch (action.type) {
    case 'token':
      return { ...state, phase: 'streaming-text', approval: null }
    case 'tool-call': {
      const now = action.startedAt ?? action.updatedAt ?? Date.now()
      const toolCall: ToolCallInfo = {
        toolCallId: action.toolCallId,
        toolName: action.toolName,
        input: action.input,
        status: 'running',
        startedAt: now,
        updatedAt: action.updatedAt ?? now,
        lastProgressAt: action.lastProgressAt ?? now,
        deadlineAt: action.deadlineAt
      }
      return {
        ...state,
        phase: 'running-tools',
        toolCalls: upsertToolCall(state.toolCalls, toolCall),
        approval: null
      }
    }
    case 'tool-status': {
      const toolCalls = state.toolCalls.map((toolCall) => sameToolCall(toolCall, action.toolCallId, action.toolName)
        ? {
            ...toolCall,
            status: action.status,
            startedAt: action.startedAt ?? toolCall.startedAt,
            updatedAt: action.updatedAt,
            lastProgressAt: action.lastProgressAt ?? toolCall.lastProgressAt,
            deadlineAt: action.deadlineAt ?? toolCall.deadlineAt,
            durationMs: action.durationMs ?? toolCall.durationMs,
            error: action.error ?? toolCall.error
          }
        : toolCall)
      return {
        ...state,
        phase: toolCalls.some((toolCall) => toolCall.status === 'running') ? 'running-tools' : 'waiting-model',
        toolCalls,
        approval: null
      }
    }
    case 'tool-result':
      return settleToolCall(state, action.toolCallId, action.toolName, {
        status: 'done',
        output: action.output,
        metadata: action.metadata,
        startedAt: action.startedAt,
        updatedAt: action.updatedAt,
        lastProgressAt: action.lastProgressAt,
        deadlineAt: action.deadlineAt,
        durationMs: action.durationMs
      })
    case 'tool-error':
      return settleToolCall(state, action.toolCallId, action.toolName, {
        status: action.status ?? 'error',
        output: action.error,
        error: action.error,
        startedAt: action.startedAt,
        updatedAt: action.updatedAt,
        lastProgressAt: action.lastProgressAt,
        deadlineAt: action.deadlineAt,
        durationMs: action.durationMs
      })
    case 'message-end':
      return { ...state, phase: 'finalizing', approval: null }
    case 'goal-update':
      return { ...state, goal: action.goal ?? null }
    case 'abort':
      return { ...state, phase: 'cancelled', approval: null }
    case 'error':
      return { ...state, phase: 'failed', approval: null, error: action.error }
    case 'done':
      return { ...initialRunActivityState }
    case 'context-usage':
    case 'queue-updated':
    case 'message-queued':
    case 'message-applied':
    case 'message-deferred':
      return state
    default:
      return state
  }
}

export function formatElapsedDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function runActivityLabel(phase: RunActivityPhase, language: Language): string {
  return labels[language][phase]
}

export function runActivityDataStatus(phase: RunActivityPhase): RunActivityDataStatus {
  if (phase === 'idle') return 'idle'
  if (phase === 'waiting-model' || phase === 'awaiting-approval') return 'waiting'
  if (phase === 'cancelling') return 'cancelling'
  if (phase === 'cancelled') return 'cancelled'
  if (phase === 'failed') return 'failed'
  return 'running'
}

export function toRunActivityViewModel(state: RunActivityState, language: Language): RunActivityViewModel {
  const runningTools = state.toolCalls.filter((toolCall) => toolCall.status === 'running')
  const showsTool = state.phase === 'running-tools' || state.phase === 'awaiting-approval'
  const activeTool = showsTool ? state.approval?.toolName ?? runningTools.at(-1)?.toolName : undefined
  const toolCount = showsTool ? (runningTools.length > 0 ? runningTools.length : state.approval ? 1 : 0) : 0

  return {
    phase: state.phase,
    label: runActivityLabel(state.phase, language),
    dataStatus: runActivityDataStatus(state.phase),
    ...(state.runMode ? { runMode: state.runMode } : {}),
    ...(state.goal ? { goal: state.goal } : {}),
    ...(toolCount > 0 ? { toolCount } : {}),
    ...(activeTool ? { toolName: activeTool } : {}),
    ...(state.error ? { error: state.error } : {})
  }
}

function upsertToolCall(toolCalls: ToolCallInfo[], next: ToolCallInfo): ToolCallInfo[] {
  const index = toolCalls.findIndex((toolCall) => sameToolCall(toolCall, next.toolCallId, next.toolName))
  if (index === -1) return [...toolCalls, next]
  return toolCalls.map((toolCall, toolIndex) => toolIndex === index ? next : toolCall)
}

function settleToolCall(
  state: RunActivityState,
  toolCallId: string,
  toolName: string,
  result: Partial<Pick<ToolCallInfo, 'status' | 'output' | 'metadata' | 'startedAt' | 'updatedAt' | 'lastProgressAt' | 'deadlineAt' | 'durationMs' | 'error'>> & Pick<ToolCallInfo, 'status'>
): RunActivityState {
  const toolCalls = state.toolCalls.map((toolCall) => sameToolCall(toolCall, toolCallId, toolName)
    ? { ...toolCall, ...result }
    : toolCall)
  return {
    ...state,
    phase: toolCalls.some((toolCall) => toolCall.status === 'running') ? 'running-tools' : 'waiting-model',
    toolCalls,
    approval: null
  }
}

function sameToolCall(toolCall: ToolCallInfo, toolCallId: string | undefined, toolName: string): boolean {
  return (toolCallId !== undefined && toolCall.toolCallId === toolCallId) || (!toolCall.toolCallId && toolCall.toolName === toolName)
}

const labels: Record<Language, Record<RunActivityPhase, string>> = {
  zh: {
    idle: '空闲',
    starting: '正在启动',
    'waiting-model': '等待模型',
    'streaming-text': '正在生成',
    'running-tools': '正在运行工具',
    'awaiting-approval': '等待审批',
    finalizing: '正在完成',
    cancelling: '正在取消',
    cancelled: '已取消',
    failed: '运行失败'
  },
  en: {
    idle: 'Idle',
    starting: 'Starting',
    'waiting-model': 'Waiting for model',
    'streaming-text': 'Generating response',
    'running-tools': 'Running tools',
    'awaiting-approval': 'Awaiting approval',
    finalizing: 'Finalizing',
    cancelling: 'Cancelling',
    cancelled: 'Cancelled',
    failed: 'Run failed'
  }
}
