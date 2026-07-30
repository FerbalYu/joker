import { create } from 'zustand'
import type { AppConfig, AssistantSegment, ChatMessage, ContextUsage, StreamUsage, ToolCallInfo, ApprovalRequest, SessionMeta, ReasoningLevel, ProjectEntry, RunMode } from '@shared/types'
import { getInitialLanguage, persistLanguage, type Language } from './i18n'
import {
  appendTextSegment,
  appendToolSegment,
  flattenSegmentText,
  flattenToolCalls,
  updateRunningToolsInSegments,
  updateToolInSegments
} from './assistant-segments'

interface AppState {
  messages: ChatMessage[]
  streamText: string
  streamSegments: AssistantSegment[]
  streaming: boolean
  streamStartedAt: number | null
  streamProviderName: string | null
  streamModelName: string | null
  contextUsage: ContextUsage | null
  latestUsage: StreamUsage | null
  reasoningLevel: ReasoningLevel
  activeRunMode: RunMode
  streamRunMode: RunMode | null
  pendingToolCalls: ToolCallInfo[]

  approvalQueue: ApprovalRequest[]
  selectedApproval: ApprovalRequest | null

  sessions: SessionMeta[]
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
  startStream: () => void
  appendToken: (token: string) => void
  commitStream: (messageId: string, usage?: StreamUsage) => ChatMessage | null
  clearStream: () => void
  resetTransientState: () => void
  setStreaming: (v: boolean) => void
  setStreamModel: (providerName: string | undefined, modelName: string | undefined) => void
  setContextUsage: (usage: ContextUsage | null) => void
  setLatestUsage: (usage: StreamUsage | null) => void
  setReasoningLevel: (level: ReasoningLevel) => void
  setActiveRunMode: (mode: RunMode) => void
  setStreamRunMode: (mode: RunMode | undefined) => void
  addPendingToolCall: (tc: ToolCallInfo) => void
  resolveToolCall: (toolCallId: string, toolName: string, output: string, metadata?: Record<string, unknown>) => void
  failToolCall: (toolCallId: string, toolName: string, error: string) => void
  failRunningToolCalls: (error: string) => void
  addApproval: (req: ApprovalRequest) => void
  removeApproval: (requestId: string) => void
  removeApprovalsForSession: (sessionId: string) => void
  selectApproval: (req: ApprovalRequest | null) => void
  setSessions: (sessions: SessionMeta[]) => void
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

export const useStore = create<AppState>((set, get) => ({
  messages: [],
  streamText: '',
  streamSegments: [],
  streaming: false,
  streamStartedAt: null,
  streamProviderName: null,
  streamModelName: null,
  contextUsage: null,
  latestUsage: null,
  reasoningLevel: 'auto',
  activeRunMode: 'chat',
  streamRunMode: null,
  pendingToolCalls: [],
  approvalQueue: [],
  selectedApproval: null,
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

  startStream: () => set({
    streaming: true,
    streamStartedAt: Date.now(),
    streamText: '',
    streamSegments: [],
    pendingToolCalls: [],
    contextUsage: null,
    latestUsage: null
  }),
  appendToken: (token) =>
    set((s) => {
      const streamSegments = appendTextSegment(s.streamSegments, token)
      return {
        streamSegments,
        streamText: flattenSegmentText(streamSegments)
      }
    }),

  commitStream: (messageId, usage) => {
    const state = get()
    const segments = state.streamSegments
    const toolCalls = flattenToolCalls(segments)
    const message: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content: flattenSegmentText(segments),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      segments: segments.length > 0 ? segments : undefined,
      usage,
      durationMs: state.streamStartedAt === null ? undefined : Math.max(0, Date.now() - state.streamStartedAt),
      runMode: state.streamRunMode ?? undefined,
      createdAt: Date.now()
    }
    set((s) => ({
      messages: [...s.messages, message],
      streamText: '',
      streamSegments: [],
      pendingToolCalls: [],
      streamStartedAt: null,
      streamRunMode: null
    }))
    return message
  },

  clearStream: () => set({ streamText: '', streamSegments: [], pendingToolCalls: [], streamStartedAt: null, streamRunMode: null }),
  resetTransientState: () =>
    set({
      streamText: '',
      streamSegments: [],
      pendingToolCalls: [],
      streaming: false,
      streamStartedAt: null,
      streamProviderName: null,
      streamModelName: null,
      streamRunMode: null,
      contextUsage: null,
      latestUsage: null
    }),
  setStreaming: (v) => set({ streaming: v }),
  setStreamModel: (providerName, modelName) =>
    set({ streamProviderName: providerName ?? null, streamModelName: modelName ?? null }),
  setContextUsage: (usage) => set({ contextUsage: usage }),
  setLatestUsage: (usage) => set({ latestUsage: usage }),
  setReasoningLevel: (reasoningLevel) => set({ reasoningLevel }),
  setActiveRunMode: (activeRunMode) => set({ activeRunMode }),
  setStreamRunMode: (streamRunMode) => set({ streamRunMode: streamRunMode ?? null }),

  addPendingToolCall: (tc) =>
    set((s) => {
      const streamSegments = appendToolSegment(s.streamSegments, tc)
      return {
        streamSegments,
        pendingToolCalls: flattenToolCalls(streamSegments),
        streamText: flattenSegmentText(streamSegments)
      }
    }),
  resolveToolCall: (toolCallId, toolName, output, metadata) =>
    set((s) => {
      const streamSegments = updateToolInSegments(
        s.streamSegments,
        (tc) => tc.status === 'running' && (tc.toolCallId === toolCallId || (!tc.toolCallId && tc.toolName === toolName)),
        (tc) => ({ ...tc, output, metadata, status: 'done' as const })
      )
      return {
        streamSegments,
        pendingToolCalls: flattenToolCalls(streamSegments),
        streamText: flattenSegmentText(streamSegments)
      }
    }),
  failToolCall: (toolCallId, toolName, error) =>
    set((s) => {
      const streamSegments = updateToolInSegments(
        s.streamSegments,
        (tc) => tc.status === 'running' && (tc.toolCallId === toolCallId || (!tc.toolCallId && tc.toolName === toolName)),
        (tc) => ({ ...tc, output: error, status: 'error' as const })
      )
      return {
        streamSegments,
        pendingToolCalls: flattenToolCalls(streamSegments),
        streamText: flattenSegmentText(streamSegments)
      }
    }),
  failRunningToolCalls: (error) =>
    set((s) => {
      const streamSegments = updateRunningToolsInSegments(s.streamSegments, (tc) => ({
        ...tc,
        output: error,
        status: 'error' as const
      }))
      return {
        streamSegments,
        pendingToolCalls: flattenToolCalls(streamSegments),
        streamText: flattenSegmentText(streamSegments)
      }
    }),

  addApproval: (req) =>
    set((s) => ({
      approvalQueue: s.approvalQueue.some((item) => item.requestId === req.requestId)
        ? s.approvalQueue
        : [...s.approvalQueue, req],
      selectedApproval: s.selectedApproval ?? req
    })),
  removeApproval: (requestId) =>
    set((s) => {
      const queue = s.approvalQueue.filter((a) => a.requestId !== requestId)
      return {
        approvalQueue: queue,
        selectedApproval:
          s.selectedApproval?.requestId === requestId ? (queue[0] ?? null) : s.selectedApproval
      }
    }),
  removeApprovalsForSession: (sessionId) =>
    set((s) => {
      const queue = s.approvalQueue.filter((approval) => approval.sessionId !== sessionId)
      const selected = s.selectedApproval?.sessionId === sessionId ? (queue[0] ?? null) : s.selectedApproval
      return { approvalQueue: queue, selectedApproval: selected }
    }),
  selectApproval: (req) => set({ selectedApproval: req }),

  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),
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

export type { AppState }
