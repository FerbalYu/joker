import { create } from 'zustand'
import type { AppConfig, AssistantSegment, ChatMessage, ContextUsage, StreamFlowState, StreamUsage, ToolCallInfo, ApprovalRequest, SessionSummary, ReasoningLevel, ProjectEntry, RunMode, PendingUserMessage, SubagentActivity, UserQuestionRequest } from '@shared/types'
import { getInitialLanguage, persistLanguage, type Language } from './i18n'
import { initialRunActivityState, runActivityReducer, type RunActivityAction, type RunActivityState } from './run-activity'
import {
  appendTextSegment,
  appendToolSegment,
  flattenSegmentText,
  flattenToolCalls,
  updateRunningToolsInSegments,
  updateToolInSegments
} from './assistant-segments'

export interface SessionRuntimeState {
  streamText: string
  streamSegments: AssistantSegment[]
  streaming: boolean
  sendStarting: boolean
  streamStartedAt: number | null
  streamProviderName: string | null
  streamModelName: string | null
  contextUsage: ContextUsage | null
  latestUsage: StreamUsage | null
  reasoningLevel: ReasoningLevel
  activeRunMode: RunMode
  streamRunMode: RunMode | null
  pendingToolCalls: ToolCallInfo[]
  subagentActivities: SubagentActivity[]
  pendingUserMessages: PendingUserMessage[]
  streamFlow: StreamFlowState | null
  runActivity: RunActivityState
}

interface AppState extends SessionRuntimeState {
  messages: ChatMessage[]
  sessionRuntimes: Record<string, SessionRuntimeState>

  approvalQueue: ApprovalRequest[]
  selectedApproval: ApprovalRequest | null

  userQuestions: UserQuestionRequest[]

  sessions: SessionSummary[]
  activeSessionId: string | null
  sessionLoading: boolean
  sessionError: string | null

  language: Language
  config: AppConfig | null
  projects: ProjectEntry[]
  activeProjectId: string | null
  projectLoading: boolean
  projectError: string | null

  addMessage: (msg: ChatMessage) => void
  removeMessage: (messageId: string) => void
  setMessages: (messages: ChatMessage[]) => void
  ensureSessionRuntime: (sessionId: string) => void
  removeSessionRuntime: (sessionId: string) => void
  startStream: (sessionId: string) => void
  appendToken: (sessionId: string, token: string) => void
  appendTokenBatch: (tokens: Array<{ sessionId: string; runId?: string; text: string }>) => void
  commitStream: (sessionId: string, messageId: string, usage?: StreamUsage) => ChatMessage | null
  clearStream: (sessionId: string) => void
  resetTransientState: (sessionId: string) => void
  setStreaming: (sessionId: string, v: boolean) => void
  setSendStarting: (sessionId: string, v: boolean) => void
  setStreamModel: (sessionId: string, providerName: string | undefined, modelName: string | undefined) => void
  setContextUsage: (sessionId: string, usage: ContextUsage | null) => void
  setLatestUsage: (sessionId: string, usage: StreamUsage | null) => void
  setReasoningLevel: (level: ReasoningLevel) => void
  setActiveRunMode: (sessionId: string, mode: RunMode) => void
  setStreamRunMode: (sessionId: string, mode: RunMode | undefined) => void
  addPendingToolCall: (sessionId: string, tc: ToolCallInfo) => void
  resolveToolCall: (sessionId: string, toolCallId: string, toolName: string, output: string, metadata?: Record<string, unknown>, timing?: Partial<ToolCallInfo>) => void
  failToolCall: (sessionId: string, toolCallId: string, toolName: string, error: string, status?: Extract<ToolCallInfo['status'], 'error' | 'cancelled' | 'timed-out'>, timing?: Partial<ToolCallInfo>) => void
  updateToolStatus: (sessionId: string, update: ToolCallInfo) => void
  failRunningToolCalls: (sessionId: string, error: string) => void
  updateSubagentActivity: (sessionId: string, activity: SubagentActivity) => void
  setStreamFlow: (sessionId: string, flow: StreamFlowState | null) => void
  setPendingUserMessages: (sessionId: string, messages: PendingUserMessage[]) => void
  dispatchRunActivity: (sessionId: string, action: RunActivityAction) => void
  addApproval: (req: ApprovalRequest) => void
  setApprovals: (requests: ApprovalRequest[]) => void
  removeApproval: (requestId: string) => void
  removeApprovalsForSession: (sessionId: string) => void
  selectApproval: (req: ApprovalRequest | null) => void
  addUserQuestion: (request: UserQuestionRequest) => void
  removeUserQuestion: (requestId: string) => void
  setSessions: (sessions: SessionSummary[]) => void
  upsertSessionSummary: (summary: SessionSummary) => void
  removeSessionSummary: (sessionId: string) => void
  setSessionGoal: (sessionId: string, goal: SessionSummary['goal']) => void
  setActiveSession: (sessionId: string | null) => void
  setSessionLoading: (loading: boolean) => void
  setSessionError: (error: string | null) => void
  setLanguage: (language: Language) => void
  setConfig: (config: AppConfig) => void
  setProjects: (projects: ProjectEntry[]) => void
  setActiveProjectId: (projectId: string | null) => void
  setProjectLoading: (loading: boolean) => void
  setProjectError: (error: string | null) => void
}

function createSessionRuntime(activeRunMode: RunMode = 'chat', reasoningLevel: ReasoningLevel = 'auto'): SessionRuntimeState {
  return {
    streamText: '',
    streamSegments: [],
    streaming: false,
    sendStarting: false,
    streamStartedAt: null,
    streamProviderName: null,
    streamModelName: null,
    contextUsage: null,
    latestUsage: null,
    reasoningLevel,
    activeRunMode,
    streamRunMode: null,
    pendingToolCalls: [],
    subagentActivities: [],
    pendingUserMessages: [],
    streamFlow: null,
    runActivity: { ...initialRunActivityState, toolCalls: [] }
  }
}

function runtimeProjection(runtime: SessionRuntimeState): SessionRuntimeState {
  return runtime
}

function updateRuntime(
  state: AppState,
  sessionId: string,
  updater: (runtime: SessionRuntimeState) => SessionRuntimeState
): Partial<AppState> {
  const runtime = updater(state.sessionRuntimes[sessionId] ?? createSessionRuntime())
  return {
    sessionRuntimes: { ...state.sessionRuntimes, [sessionId]: runtime },
    ...(state.activeSessionId === sessionId ? runtimeProjection(runtime) : {})
  }
}

const initialRuntime = createSessionRuntime()

export const useStore = create<AppState>((set, get) => ({
  ...initialRuntime,
  messages: [],
  sessionRuntimes: {},
  approvalQueue: [],
  selectedApproval: null,
  userQuestions: [],
  sessions: [],
  activeSessionId: null,
  sessionLoading: false,
  sessionError: null,
  language: getInitialLanguage(),
  config: null,
  projects: [],
  activeProjectId: null,
  projectLoading: false,
  projectError: null,

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  removeMessage: (messageId) => set((s) => ({ messages: s.messages.filter((message) => message.id !== messageId) })),
  setMessages: (messages) => set({ messages }),
  ensureSessionRuntime: (sessionId) => set((state) => state.sessionRuntimes[sessionId]
    ? {}
    : updateRuntime(state, sessionId, (runtime) => runtime)),
  removeSessionRuntime: (sessionId) => set((state) => {
    const { [sessionId]: _removed, ...sessionRuntimes } = state.sessionRuntimes
    return { sessionRuntimes }
  }),

  startStream: (sessionId) => set((state) => updateRuntime(state, sessionId, (runtime) => ({
    ...runtime,
    streaming: true,
    sendStarting: false,
    streamStartedAt: Date.now(),
    streamText: '',
    streamSegments: [],
    pendingToolCalls: [],
    subagentActivities: [],
    contextUsage: null,
    latestUsage: null
  }))),
  appendToken: (sessionId, token) => set((state) => updateRuntime(state, sessionId, (runtime) => {
    const streamSegments = appendTextSegment(runtime.streamSegments, token)
    return { ...runtime, streamSegments, streamText: runtime.streamText + token }
  })),
  appendTokenBatch: (tokens) => set((state) => {
    if (tokens.length === 0) return {}
    const grouped = new Map<string, { runId?: string; text: string }>()
    for (const token of tokens) {
      if (!token.text) continue
      const current = grouped.get(token.sessionId)
      grouped.set(token.sessionId, {
        runId: token.runId ?? current?.runId,
        text: (current?.text ?? '') + token.text
      })
    }
    if (grouped.size === 0) return {}

    const sessionRuntimes = { ...state.sessionRuntimes }
    for (const [sessionId, token] of grouped) {
      const runtime = sessionRuntimes[sessionId] ?? createSessionRuntime()
      const streamSegments = appendTextSegment(runtime.streamSegments, token.text)
      sessionRuntimes[sessionId] = {
        ...runtime,
        streamSegments,
        streamText: runtime.streamText + token.text,
        runActivity: runtime.runActivity.phase === 'streaming-text'
          ? runtime.runActivity
          : runActivityReducer(runtime.runActivity, {
              type: 'token',
              sessionId,
              runId: token.runId,
              text: token.text
            })
      }
    }

    const activeRuntime = state.activeSessionId ? sessionRuntimes[state.activeSessionId] : undefined
    return {
      sessionRuntimes,
      ...(activeRuntime ? runtimeProjection(activeRuntime) : {})
    }
  }),

  commitStream: (sessionId, messageId, usage) => {
    const state = get()
    const runtime = state.sessionRuntimes[sessionId] ?? createSessionRuntime()
    const segments = runtime.streamSegments
    const toolCalls = flattenToolCalls(segments)
    const message: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content: flattenSegmentText(segments),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      segments: segments.length > 0 ? segments : undefined,
      usage,
      durationMs: runtime.streamStartedAt === null ? undefined : Math.max(0, Date.now() - runtime.streamStartedAt),
      runMode: runtime.streamRunMode ?? undefined,
      createdAt: Date.now()
    }
    set((current) => ({
      ...updateRuntime(current, sessionId, (sessionRuntime) => ({
        ...sessionRuntime,
        streamText: '',
        streamSegments: [],
        pendingToolCalls: [],
        streamStartedAt: null,
        streamRunMode: null
      })),
      ...(current.activeSessionId === sessionId ? { messages: [...current.messages, message] } : {})
    }))
    return message
  },

  clearStream: (sessionId) => set((state) => updateRuntime(state, sessionId, (runtime) => ({
    ...runtime,
    streamText: '',
    streamSegments: [],
    pendingToolCalls: [],
    streamStartedAt: null,
    streamRunMode: null
  }))),
  resetTransientState: (sessionId) => set((state) => updateRuntime(state, sessionId, (runtime) => createSessionRuntime(runtime.activeRunMode, runtime.reasoningLevel))),
  setStreaming: (sessionId, streaming) => set((state) => updateRuntime(state, sessionId, (runtime) => ({ ...runtime, streaming }))),
  setSendStarting: (sessionId, sendStarting) => set((state) => updateRuntime(state, sessionId, (runtime) => ({ ...runtime, sendStarting }))),
  setStreamModel: (sessionId, providerName, modelName) => set((state) => updateRuntime(state, sessionId, (runtime) => ({
    ...runtime,
    streamProviderName: providerName ?? null,
    streamModelName: modelName ?? null
  }))),
  setContextUsage: (sessionId, contextUsage) => set((state) => updateRuntime(state, sessionId, (runtime) => ({ ...runtime, contextUsage }))),
  setLatestUsage: (sessionId, latestUsage) => set((state) => updateRuntime(state, sessionId, (runtime) => ({ ...runtime, latestUsage }))),
  setReasoningLevel: (reasoningLevel) => set((state) => {
    const sessionId = state.activeSessionId
    return sessionId ? updateRuntime(state, sessionId, (runtime) => ({ ...runtime, reasoningLevel })) : { reasoningLevel }
  }),
  setActiveRunMode: (sessionId, activeRunMode) => set((state) => updateRuntime(state, sessionId, (runtime) => ({ ...runtime, activeRunMode }))),
  setStreamRunMode: (sessionId, streamRunMode) => set((state) => updateRuntime(state, sessionId, (runtime) => ({ ...runtime, streamRunMode: streamRunMode ?? null }))),

  addPendingToolCall: (sessionId, tc) => set((state) => updateRuntime(state, sessionId, (runtime) => {
    const streamSegments = appendToolSegment(runtime.streamSegments, tc)
    return {
      ...runtime,
      streamSegments,
      pendingToolCalls: flattenToolCalls(streamSegments),
      streamText: runtime.streamText
    }
  })),
  resolveToolCall: (sessionId, toolCallId, toolName, output, metadata, timing) => set((state) => updateRuntime(state, sessionId, (runtime) => {
    const streamSegments = updateToolInSegments(
      runtime.streamSegments,
      (tc) => tc.toolCallId === toolCallId || (!tc.toolCallId && tc.toolName === toolName),
      (tc) => ({ ...tc, ...timing, output, metadata, status: 'done' as const })
    )
    return {
      ...runtime,
      streamSegments,
      pendingToolCalls: flattenToolCalls(streamSegments),
      streamText: runtime.streamText
    }
  })),
  failToolCall: (sessionId, toolCallId, toolName, error, status = 'error', timing) => set((state) => updateRuntime(state, sessionId, (runtime) => {
    const streamSegments = updateToolInSegments(
      runtime.streamSegments,
      (tc) => tc.toolCallId === toolCallId || (!tc.toolCallId && tc.toolName === toolName),
      (tc) => ({
        ...tc,
        ...timing,
        output: error,
        error,
        status: tc.status === 'timed-out' || tc.status === 'cancelled' || tc.status === 'denied' ? tc.status : status
      })
    )
    return {
      ...runtime,
      streamSegments,
      pendingToolCalls: flattenToolCalls(streamSegments),
      streamText: runtime.streamText
    }
  })),
  updateToolStatus: (sessionId, update) => set((state) => updateRuntime(state, sessionId, (runtime) => {
    const streamSegments = updateToolInSegments(
      runtime.streamSegments,
      (tc) => (update.toolCallId !== undefined && tc.toolCallId === update.toolCallId) || (!tc.toolCallId && tc.toolName === update.toolName),
      (tc) => {
        if (tc.status !== 'running' && update.status === 'running') return tc
        if (tc.updatedAt !== undefined && update.updatedAt !== undefined && update.updatedAt < tc.updatedAt) return tc
        return { ...tc, ...update, input: Object.keys(update.input).length > 0 ? update.input : tc.input }
      }
    )
    return { ...runtime, streamSegments, pendingToolCalls: flattenToolCalls(streamSegments) }
  })),
  failRunningToolCalls: (sessionId, error) => set((state) => updateRuntime(state, sessionId, (runtime) => {
    const streamSegments = updateRunningToolsInSegments(runtime.streamSegments, (tc) => ({
      ...tc,
      output: error,
      status: 'error' as const
    }))
    return {
      ...runtime,
      streamSegments,
      pendingToolCalls: flattenToolCalls(streamSegments),
      streamText: runtime.streamText
    }
  })),

  updateSubagentActivity: (sessionId, activity) => set((state) => updateRuntime(state, sessionId, (runtime) => {
    const index = runtime.subagentActivities.findIndex((item) => item.id === activity.id)
    const subagentActivities = index >= 0
      ? runtime.subagentActivities.map((item, itemIndex) => itemIndex === index ? activity : item)
      : [...runtime.subagentActivities, activity]
    return { ...runtime, subagentActivities: subagentActivities.slice(-8) }
  })),
  setStreamFlow: (sessionId, streamFlow) => set((state) => updateRuntime(state, sessionId, (runtime) => ({ ...runtime, streamFlow }))),

  setPendingUserMessages: (sessionId, pendingUserMessages) => set((state) => updateRuntime(state, sessionId, (runtime) => ({ ...runtime, pendingUserMessages }))),
  dispatchRunActivity: (sessionId, action) => set((state) => updateRuntime(state, sessionId, (runtime) => ({
    ...runtime,
    runActivity: runActivityReducer(runtime.runActivity, action)
  }))),

  addApproval: (req) => set((state) => {
    const approvalQueue = state.approvalQueue.some((item) => item.requestId === req.requestId)
      ? state.approvalQueue
      : [...state.approvalQueue, req]
    return {
      ...updateRuntime(state, req.sessionId, (runtime) => ({
        ...runtime,
        runActivity: runActivityReducer(runtime.runActivity, { type: 'approval', request: req })
      })),
      approvalQueue,
      selectedApproval: state.activeSessionId === req.sessionId
        ? (state.selectedApproval?.sessionId === req.sessionId ? state.selectedApproval : req)
        : state.selectedApproval
    }
  }),
  setApprovals: (requests) => set((state) => {
    const approvalQueue = requests.filter((request, index) => requests.findIndex((candidate) => candidate.requestId === request.requestId) === index)
    let sessionRuntimes = state.sessionRuntimes
    for (const request of approvalQueue) {
      const runtime = sessionRuntimes[request.sessionId] ?? createSessionRuntime()
      sessionRuntimes = {
        ...sessionRuntimes,
        [request.sessionId]: {
          ...runtime,
          runActivity: runActivityReducer(runtime.runActivity, { type: 'approval', request })
        }
      }
    }
    const activeRuntime = state.activeSessionId ? sessionRuntimes[state.activeSessionId] : undefined
    return {
      sessionRuntimes,
      ...(activeRuntime ? runtimeProjection(activeRuntime) : {}),
      approvalQueue,
      selectedApproval: state.activeSessionId
        ? (approvalQueue.find((approval) => approval.sessionId === state.activeSessionId) ?? null)
        : null
    }
  }),
  removeApproval: (requestId) => set((state) => {
    const removed = state.approvalQueue.find((approval) => approval.requestId === requestId)
    const queue = state.approvalQueue.filter((approval) => approval.requestId !== requestId)
    const runtimeUpdate = removed
      ? updateRuntime(state, removed.sessionId, (runtime) => ({
          ...runtime,
          runActivity: runActivityReducer(runtime.runActivity, { type: 'approval-resolved', requestId })
        }))
      : {}
    return {
      ...runtimeUpdate,
      approvalQueue: queue,
      selectedApproval: state.selectedApproval?.requestId === requestId
        ? (queue.find((approval) => approval.sessionId === state.activeSessionId) ?? null)
        : state.selectedApproval
    }
  }),
  removeApprovalsForSession: (sessionId) => set((state) => {
    const queue = state.approvalQueue.filter((approval) => approval.sessionId !== sessionId)
    return {
      approvalQueue: queue,
      selectedApproval: state.selectedApproval?.sessionId === sessionId
        ? (queue.find((approval) => approval.sessionId === state.activeSessionId) ?? null)
        : state.selectedApproval
    }
  }),
  selectApproval: (req) => set({ selectedApproval: req }),
  addUserQuestion: (request) => set((state) => ({
    userQuestions: state.userQuestions.some((item) => item.requestId === request.requestId)
      ? state.userQuestions
      : [...state.userQuestions, request]
  })),
  removeUserQuestion: (requestId) => set((state) => ({
    userQuestions: state.userQuestions.filter((question) => question.requestId !== requestId)
  })),

  setSessions: (sessions) => set({ sessions }),
  upsertSessionSummary: (summary) => set((state) => {
    const index = state.sessions.findIndex((session) => session.id === summary.id)
    return {
      sessions: index === -1
        ? [summary, ...state.sessions]
        : state.sessions.map((session) => session.id === summary.id ? summary : session)
    }
  }),
  removeSessionSummary: (sessionId) => set((state) => ({
    sessions: state.sessions.filter((session) => session.id !== sessionId)
  })),
  setSessionGoal: (sessionId, goal) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId
      ? { ...session, ...(goal ? { goal } : { goal: undefined }), updatedAt: goal?.updatedAt ?? session.updatedAt }
      : session)
  })),
  setActiveSession: (sessionId) => set((state) => {
    const runtime = sessionId ? (state.sessionRuntimes[sessionId] ?? createSessionRuntime()) : createSessionRuntime()
    return {
      activeSessionId: sessionId,
      ...(sessionId && !state.sessionRuntimes[sessionId]
        ? { sessionRuntimes: { ...state.sessionRuntimes, [sessionId]: runtime } }
        : {}),
      ...runtimeProjection(runtime),
      selectedApproval: sessionId ? (state.approvalQueue.find((approval) => approval.sessionId === sessionId) ?? null) : null
    }
  }),
  setSessionLoading: (sessionLoading) => set({ sessionLoading }),
  setSessionError: (sessionError) => set({ sessionError }),

  setLanguage: (language) => {
    persistLanguage(language)
    set({ language })
  },
  setConfig: (config) => set({ config }),
  setProjects: (projects) => set({ projects, projectError: null }),
  setActiveProjectId: (activeProjectId) => set({ activeProjectId, projectError: null }),
  setProjectLoading: (projectLoading) => set({ projectLoading }),
  setProjectError: (projectError) => set({ projectError })
}))

export function isSessionRuntimeBusy(runtime: SessionRuntimeState | undefined): boolean {
  return Boolean(runtime?.streaming || runtime?.sendStarting)
}

export function sessionRuntime(state: AppState, sessionId: string | null): SessionRuntimeState {
  return sessionId ? (state.sessionRuntimes[sessionId] ?? createSessionRuntime()) : createSessionRuntime()
}

export type { AppState }
