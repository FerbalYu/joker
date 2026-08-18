import { transitionToolCall } from '../../shared/types'
import type { ApprovalRequest, ApprovalResolvedEvent, GoalState, RunMode, StreamEvent, ToolCallInfo } from '@shared/types'
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
  | { type: 'approval-resolved'; event: ApprovalResolvedEvent }
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
    const now = action.request.askedAt ?? Date.now()
    const toolCalls = updateApprovalTool(state.toolCalls, action.request, (toolCall) => transitionToolCall(toolCall, {
      status: 'awaiting-approval',
      approvalAskedAt: toolCall.approvalAskedAt ?? now,
      updatedAt: Math.max(toolCall.updatedAt ?? 0, now)
    }))
    return {
      ...state,
      phase: 'awaiting-approval',
      toolCalls,
      approval: action.request
    }
  }

  if (action.type === 'approval-resolved') {
    if (state.approval?.requestId !== action.event.requestId) return state
    const now = action.event.resolvedAt
    const toolCalls = updateApprovalTool(state.toolCalls, state.approval, (toolCall) => transitionToolCall(toolCall, {
      status: action.event.approved ? 'proposed' : 'denied',
      approvalDecidedAt: now,
      approvalOutcome: action.event.approved ? 'allow' : 'deny',
      completedAt: action.event.approved ? toolCall.completedAt : now,
      updatedAt: Math.max(toolCall.updatedAt ?? 0, now)
    }))
    return {
      ...state,
      phase: phaseForToolCalls(toolCalls),
      toolCalls,
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
      const now = action.proposedAt ?? action.updatedAt ?? Date.now()
      const toolCall: ToolCallInfo = {
        toolCallId: action.toolCallId,
        toolName: action.toolName,
        input: action.input,
        status: 'proposed',
        proposedAt: now,
        updatedAt: action.updatedAt ?? now
      }
      return {
        ...state,
        phase: state.approval ? 'awaiting-approval' : 'waiting-model',
        toolCalls: upsertToolCall(state.toolCalls, toolCall),
        approval: state.approval
      }
    }
    case 'tool-status': {
      const existing = state.toolCalls.find((toolCall) => sameToolCall(toolCall, action.toolCallId, action.toolName))
      const next = transitionToolCall(existing ?? {
        toolCallId: action.toolCallId,
        toolName: action.toolName,
        input: {},
        status: 'proposed'
      }, {
        status: action.status,
        proposedAt: action.proposedAt,
        approvalAskedAt: action.approvalAskedAt,
        approvalDecidedAt: action.approvalDecidedAt,
        approvalOutcome: action.approvalOutcome,
        startedAt: action.startedAt,
        completedAt: action.completedAt,
        updatedAt: action.updatedAt,
        lastProgressAt: action.lastProgressAt,
        deadlineAt: action.deadlineAt,
        durationMs: action.durationMs,
        error: action.error,
        errorCode: action.errorCode
      })
      const toolCalls = upsertToolCall(state.toolCalls, next)
      return {
        ...state,
        phase: phaseForToolCalls(toolCalls, state.approval),
        toolCalls,
        approval: state.approval
      }
    }
    case 'tool-result':
      return settleToolCall(state, action.toolCallId, action.toolName, {
        status: 'done',
        output: action.output,
        metadata: action.metadata,
        proposedAt: action.proposedAt,
        approvalAskedAt: action.approvalAskedAt,
        approvalDecidedAt: action.approvalDecidedAt,
        approvalOutcome: action.approvalOutcome,
        startedAt: action.startedAt,
        completedAt: action.completedAt ?? action.updatedAt,
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
        errorCode: action.errorCode,
        proposedAt: action.proposedAt,
        approvalAskedAt: action.approvalAskedAt,
        approvalDecidedAt: action.approvalDecidedAt,
        approvalOutcome: action.approvalOutcome,
        startedAt: action.startedAt,
        completedAt: action.completedAt ?? action.updatedAt,
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
  return toolCalls.map((toolCall, toolIndex) => toolIndex === index ? mergeToolCall(toolCall, next) : toolCall)
}

function settleToolCall(
  state: RunActivityState,
  toolCallId: string,
  toolName: string,
  result: Partial<ToolCallInfo> & Pick<ToolCallInfo, 'status'>
): RunActivityState {
  const existing = state.toolCalls.find((toolCall) => sameToolCall(toolCall, toolCallId, toolName))
  const next = transitionToolCall(existing ?? { toolCallId, toolName, input: {}, status: 'proposed' }, result)
  const toolCalls = upsertToolCall(state.toolCalls, next)
  return {
    ...state,
    phase: phaseForToolCalls(toolCalls, state.approval),
    toolCalls,
    approval: null
  }
}

function updateApprovalTool(
  toolCalls: ToolCallInfo[],
  request: ApprovalRequest,
  updater: (toolCall: ToolCallInfo) => ToolCallInfo
): ToolCallInfo[] {
  const exactIndex = request.toolCallId
    ? toolCalls.findIndex((toolCall) => toolCall.toolCallId === request.toolCallId)
    : -1
  const fallbackIndex = exactIndex >= 0
    ? exactIndex
    : toolCalls.findLastIndex((toolCall) => toolCall.toolName === request.toolName && (toolCall.status === 'proposed' || toolCall.status === 'awaiting-approval'))
  if (fallbackIndex >= 0) return toolCalls.map((toolCall, index) => index === fallbackIndex ? updater(toolCall) : toolCall)
  const now = Date.now()
  return [...toolCalls, updater({
    ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
    toolName: request.toolName,
    input: request.input,
    status: 'proposed',
    proposedAt: now,
    updatedAt: now
  })]
}

function mergeToolCall(current: ToolCallInfo, next: ToolCallInfo): ToolCallInfo {
  if (current.status === 'awaiting-approval' && next.status === 'proposed') {
    return transitionToolCall(current, { ...next, status: 'awaiting-approval', input: Object.keys(next.input).length > 0 ? next.input : current.input })
  }
  return transitionToolCall(current, { ...next, input: Object.keys(next.input).length > 0 ? next.input : current.input })
}

function phaseForToolCalls(toolCalls: ToolCallInfo[], approval?: ApprovalRequest | null): RunActivityPhase {
  if (approval || toolCalls.some((toolCall) => toolCall.status === 'awaiting-approval')) return 'awaiting-approval'
  if (toolCalls.some((toolCall) => toolCall.status === 'running')) return 'running-tools'
  return 'waiting-model'
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
