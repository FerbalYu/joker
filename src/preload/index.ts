import { contextBridge, ipcRenderer } from 'electron'
import { STREAM_HIGH_WATER_MARK } from '../shared/types'
import { StreamBridge, type StreamPortLike } from './stream-bridge'
import type {
  StreamEvent,
  StreamFlowState,
  ApprovalRequest,
  AppConfig,
  ChatMessage,
  ChatIntent,
  FetchModelsResult,
  ProviderEntry,
  ProviderTestResult,
  SessionMeta,
  SessionSummary,
  SessionSummaryChangedEvent,
  SessionCompactResult,
  McpServerConfig,
  McpServerRuntime,
  ReasoningLevel,
  SkillDescriptor,
  SkillActionResult,
  ImageProviderConfig,
  ImageProviderEntry,
  ImageFetchModelsResult,
  ImageProviderTestResult,
  GeneratedImageRef,
  GeneratedImageReadResult,
  ProjectState,
  GitStatus,
  UserQuestionRequest,
  UserQuestionAnswerPayload,
  GoalCas,
  GoalCreateInput,
  GoalTransitionResult,
  RunMode,
  GeneratedToolDetailResult,
  GeneratedToolJobStatusResult,
  GeneratedToolEditRequest,
  GeneratedToolEditResult,
  GeneratedToolEnableInput,
  GeneratedToolEnableResult,
  GeneratedToolsListResult,
  GeneratedToolsQualificationOperationResult,
  GeneratedToolContinuationListResult,
  GeneratedToolLifecycleMutationResult,
  GeneratedToolRevalidateInput,
  GeneratedToolRevalidateResult,
  GeneratedToolRemoveResult,
  GeneratedToolExportResult,
  ToolForgeFullTrustResult
} from '@shared/types'
interface SessionRecord extends SessionMeta {
  messages: ChatMessage[]
}

const streamBridge = new StreamBridge(STREAM_HIGH_WATER_MARK)
ipcRenderer.on('stream:port', (event) => {
  const port = event.ports[0]
  if (port) streamBridge.acceptPort(port)
})

const api = {
  chat: {
    onPort: (callback: (port: MessagePort) => void): (() => void) =>
      streamBridge.onPort(callback as (port: StreamPortLike) => void),
    send: (_port: MessagePort, sessionId: string, messages: unknown[], reasoningLevel: ReasoningLevel, skillIds?: string[], projectId?: string, runId = crypto.randomUUID(), runMode: RunMode = 'chat', intent?: ChatIntent): boolean =>
      streamBridge.send({ type: 'chat:send', sessionId, runId, messages, reasoningLevel, skillIds, projectId, runMode, intent }),
    enqueue: (_port: MessagePort, sessionId: string, message: ChatMessage, mode: 'queue' | 'steer', expectedRunId: string | undefined, request: { reasoningLevel: ReasoningLevel; skillIds?: string[]; projectId?: string; runMode: RunMode; intent?: ChatIntent }): boolean =>
      streamBridge.send({ type: 'chat:enqueue', sessionId, message, mode, expectedRunId, request }),
    cancelPending: (_port: MessagePort, sessionId: string, pendingMessageId: string): boolean =>
      streamBridge.send({ type: 'chat:cancel-pending', sessionId, pendingMessageId }),
    steerPending: (_port: MessagePort, sessionId: string, pendingMessageId: string, expectedRunId: string): boolean =>
      streamBridge.send({ type: 'chat:steer-pending', sessionId, pendingMessageId, expectedRunId }),
    startGoal: (_port: MessagePort, sessionId: string, runId = crypto.randomUUID()): boolean =>
      streamBridge.send({ type: 'goal:start', sessionId, runId }),
    abort: (_port: MessagePort | null, runId?: string): boolean =>
      streamBridge.send({ type: 'chat:abort', runId }),
    onEvent: (_port: MessagePort, callback: (event: StreamEvent) => void): (() => void) =>
      streamBridge.onEvent(callback),
    onFlow: (callback: (flow: StreamFlowState) => void): (() => void) =>
      streamBridge.onFlow(callback),
  },
  approval: {
    onRequest: (callback: (req: ApprovalRequest) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: ApprovalRequest) => callback(req)
      ipcRenderer.on('approval:request', listener)
      return () => ipcRenderer.removeListener('approval:request', listener)
    },
    respond: (requestId: string, approved: boolean, sessionId?: string, runId?: string): Promise<boolean> =>
      ipcRenderer.invoke('approval:response', { requestId, approved, sessionId, runId }),
    listPending: (): Promise<ApprovalRequest[]> => ipcRenderer.invoke('approval:list-pending'),
    onResolved: (callback: (event: Pick<ApprovalRequest, 'requestId' | 'sessionId' | 'runId'>) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: Pick<ApprovalRequest, 'requestId' | 'sessionId' | 'runId'>) => callback(event)
      ipcRenderer.on('approval:resolved', listener)
      return () => ipcRenderer.removeListener('approval:resolved', listener)
    },
    pendingCount: (): Promise<number> => ipcRenderer.invoke('approval:pending-count'),
    setMode: (mode: 'suggest' | 'auto-edit' | 'full-auto'): void => {
      ipcRenderer.invoke('approval:set-mode', mode)
    }
  },
  userQuestion: {
    onRequest: (callback: (request: UserQuestionRequest) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, request: UserQuestionRequest) => callback(request)
      ipcRenderer.on('user-question:request', listener)
      return () => ipcRenderer.removeListener('user-question:request', listener)
    },
    answer: (payload: UserQuestionAnswerPayload): Promise<boolean> =>
      ipcRenderer.invoke('user-question:answer', payload),
    listPending: (sessionId?: string): Promise<UserQuestionRequest[]> =>
      ipcRenderer.invoke('user-question:list-pending', sessionId)
  },
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
    save: (config: AppConfig): Promise<boolean> => ipcRenderer.invoke('config:save', config),
    fetchModels: (provider: ProviderEntry): Promise<FetchModelsResult> =>
      ipcRenderer.invoke('config:fetch-models', provider),
    testProvider: (provider: ProviderEntry, modelId?: string): Promise<ProviderTestResult> =>
      ipcRenderer.invoke('config:test-provider', { provider, modelId })
  },
  imageConfig: {
    get: (): Promise<ImageProviderConfig> => ipcRenderer.invoke('image-config:get'),
    save: (config: ImageProviderConfig): Promise<boolean> => ipcRenderer.invoke('image-config:save', config),
    fetchModels: (provider: ImageProviderEntry): Promise<ImageFetchModelsResult> => ipcRenderer.invoke('image-config:fetch-models', provider),
    test: (provider: ImageProviderEntry): Promise<ImageProviderTestResult> => ipcRenderer.invoke('image-config:test', provider)
  },
  generatedImage: {
    read: (ref: GeneratedImageRef): Promise<GeneratedImageReadResult> => ipcRenderer.invoke('generated-image:read', ref),
    reveal: (ref: GeneratedImageRef): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('generated-image:reveal', ref)
  },
  generatedTools: {
    list: (): Promise<GeneratedToolsListResult> => ipcRenderer.invoke('generated-tools:list'),
    get: (toolId: string): Promise<GeneratedToolDetailResult> => ipcRenderer.invoke('generated-tools:get', { toolId }),
    jobStatus: (jobId: string): Promise<GeneratedToolJobStatusResult> => ipcRenderer.invoke('generated-tools:job-status', { jobId }),
    enable: (input: GeneratedToolEnableInput): Promise<GeneratedToolEnableResult> => ipcRenderer.invoke('generated-tools:enable', input),
    edit: (input: GeneratedToolEditRequest): Promise<GeneratedToolEditResult> => ipcRenderer.invoke('generated-tools:edit', input),
    remove: (input: { toolId: string; expectedRevision: number; operationId: string }): Promise<GeneratedToolRemoveResult> => ipcRenderer.invoke('generated-tools:remove', input),
    export: (input: { toolId: string; versionId: string }): Promise<GeneratedToolExportResult> => ipcRenderer.invoke('generated-tools:export', input),
    disable: (input: { toolId: string; expectedRevision: number; operationId: string }): Promise<GeneratedToolLifecycleMutationResult> => ipcRenderer.invoke('generated-tools:disable', input),
    reenable: (input: { toolId: string; expectedRevision: number; operationId: string; versionId: string }): Promise<GeneratedToolLifecycleMutationResult> => ipcRenderer.invoke('generated-tools:reenable', input),
    revalidate: (input: GeneratedToolRevalidateInput): Promise<GeneratedToolRevalidateResult> => ipcRenderer.invoke('generated-tools:revalidate', input),
    rollback: (input: { toolId: string; expectedRevision: number; operationId: string; versionId: string }): Promise<GeneratedToolLifecycleMutationResult> => ipcRenderer.invoke('generated-tools:rollback', input),
    continuations: (): Promise<GeneratedToolContinuationListResult> => ipcRenderer.invoke('generated-tools:continuations'),
    startQualification: (): Promise<GeneratedToolsQualificationOperationResult> => ipcRenderer.invoke('generated-tools:qualification-start'),
    cancelQualification: (): Promise<GeneratedToolsQualificationOperationResult> => ipcRenderer.invoke('generated-tools:qualification-cancel')
  },
  toolForgeTrust: {
    get: (): Promise<ToolForgeFullTrustResult> => ipcRenderer.invoke('toolforge-trust:get'),
    grant: (): Promise<ToolForgeFullTrustResult> => ipcRenderer.invoke('toolforge-trust:grant'),
    revoke: (): Promise<ToolForgeFullTrustResult> => ipcRenderer.invoke('toolforge-trust:revoke')
  },
  mcp: {
    list: (): Promise<McpServerRuntime[]> => ipcRenderer.invoke('mcp:list'),
    add: (config: McpServerConfig): Promise<{ success: boolean; error?: string; runtime?: McpServerRuntime }> => ipcRenderer.invoke('mcp:add', config),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('mcp:remove', id),
    reconnect: (id: string): Promise<{ success: boolean; error?: string; runtime?: McpServerRuntime }> => ipcRenderer.invoke('mcp:reconnect', id),
    trust: (id: string): Promise<{ success: boolean; error?: string; runtime?: McpServerRuntime }> => ipcRenderer.invoke('mcp:trust', id),
    revokeTrust: (id: string): Promise<{ success: boolean; error?: string; runtime?: McpServerRuntime }> => ipcRenderer.invoke('mcp:revoke-trust', id),
    setPermission: (id: string, permission: 'allow' | 'deny'): Promise<{ success: boolean; error?: string; runtime?: McpServerRuntime }> => ipcRenderer.invoke('mcp:set-permission', id, permission),
    tools: (): Promise<Array<{ serverId: string; serverName: string; tool: { name: string; description?: string; inputSchema: unknown } }>> => ipcRenderer.invoke('mcp:tools')
  },
  skill: {
    list: (): Promise<SkillDescriptor[]> => ipcRenderer.invoke('skill:list'),
    enable: (id: string): Promise<SkillActionResult> => ipcRenderer.invoke('skill:enable', id),
    disable: (id: string): Promise<SkillActionResult> => ipcRenderer.invoke('skill:disable', id),
    reload: (): Promise<SkillDescriptor[]> => ipcRenderer.invoke('skill:reload')
  },
  web: {
    preview: (url: string): Promise<{ url: string; finalUrl?: string; title?: string; hostname?: string; source: 'http' | 'browser' | 'none'; status?: number; error?: string }> => ipcRenderer.invoke('web:preview', url)
  },
  file: {
    reveal: (url: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('file:reveal', url),
    showContextMenu: (url: string, language: 'zh' | 'en'): Promise<{ success: boolean; canceled?: boolean; action?: 'open' | 'reveal' | 'open-with' | 'copy-path' | 'copy-contents'; path?: string; error?: string }> =>
      ipcRenderer.invoke('file:show-context-menu', url, language),
    readMarkdown: (url: string): Promise<{ success: boolean; title?: string; path?: string; content?: string; error?: string }> => ipcRenderer.invoke('file:read-markdown', url),
    saveMarkdown: (value: { title: string; content: string }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> => ipcRenderer.invoke('file:save-markdown', value)
  },
  markdown: {
    openFile: (url: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('markdown:open-file', url)
  },
  project: {
    get: (): Promise<{ success: boolean; state?: ProjectState; error?: string }> => ipcRenderer.invoke('project:get'),
    pick: (): Promise<{ success: boolean; canceled?: boolean; state?: ProjectState; error?: string }> => ipcRenderer.invoke('project:pick'),
    select: (projectId: string): Promise<{ success: boolean; state?: ProjectState; error?: string }> => ipcRenderer.invoke('project:select', projectId),
    gitStatus: (projectId: string): Promise<{ success: boolean; status?: GitStatus; error?: string }> => ipcRenderer.invoke('project:git-status', projectId)
  },
  session: {
    create: (title?: string): Promise<SessionMeta> => ipcRenderer.invoke('session:create', title),
    get: (id: string): Promise<SessionRecord | null> => ipcRenderer.invoke('session:get', id),
    list: (): Promise<SessionMeta[]> => ipcRenderer.invoke('session:list'),
    listSummaries: (): Promise<SessionSummary[]> => ipcRenderer.invoke('session:list-summaries'),
    markSeen: (sessionId: string, observedTerminalRevision: number): Promise<SessionSummary | null> =>
      ipcRenderer.invoke('session:mark-seen', sessionId, observedTerminalRevision),
    onSummaryChanged: (callback: (event: SessionSummaryChangedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, changed: SessionSummaryChangedEvent) => callback(changed)
      ipcRenderer.on('session:summary-changed', listener)
      return () => ipcRenderer.removeListener('session:summary-changed', listener)
    },
    append: (sessionId: string, message: ChatMessage): Promise<boolean> =>
      ipcRenderer.invoke('session:append', sessionId, message),
    replaceMessages: (sessionId: string, messages: ChatMessage[]): Promise<boolean> => ipcRenderer.invoke('session:replace-messages', sessionId, messages),
    pending: (sessionId: string): Promise<import('@shared/types').PendingUserMessageListResult> => ipcRenderer.invoke('session:pending', sessionId),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('session:delete', id),
    rename: (id: string, title: string): Promise<boolean> =>
      ipcRenderer.invoke('session:rename', id, title),
    goalInspect: (sessionId: string): Promise<GoalTransitionResult> =>
      ipcRenderer.invoke('session:goal-inspect', sessionId),
    goalCreate: (sessionId: string, input: GoalCreateInput): Promise<GoalTransitionResult> =>
      ipcRenderer.invoke('session:goal-create', sessionId, input),
    goalReplace: (sessionId: string, input: GoalCreateInput): Promise<GoalTransitionResult> =>
      ipcRenderer.invoke('session:goal-replace', sessionId, input),
    goalPause: (sessionId: string, input: GoalCas & { stopReason?: 'user-paused' }): Promise<GoalTransitionResult> =>
      ipcRenderer.invoke('session:goal-pause', sessionId, input),
    goalResume: (sessionId: string, input: GoalCas): Promise<GoalTransitionResult> =>
      ipcRenderer.invoke('session:goal-resume', sessionId, input),
    goalClear: (sessionId: string, input?: GoalCas): Promise<GoalTransitionResult> =>
      ipcRenderer.invoke('session:goal-clear', sessionId, input),
    compact: (sessionId: string): Promise<SessionCompactResult> =>
      ipcRenderer.invoke('session:compact', sessionId),
    readToolResult: (sessionId: string, spillId: string, offsetBytes?: number, limitBytes?: number): Promise<import('@shared/types').SpilledToolResultChunk | null> => ipcRenderer.invoke('session:read-tool-result', sessionId, spillId, offsetBytes, limitBytes),
    listRecoveries: (sessionId: string): Promise<import('@shared/types').ToolRecoveryRecord[]> => ipcRenderer.invoke('session:list-recoveries', sessionId),
    resolveRecovery: (sessionId: string, input: import('@shared/types').ToolRecoveryResolutionInput): Promise<import('@shared/types').ToolRecoveryResolutionResult> => ipcRenderer.invoke('session:resolve-recovery', sessionId, input),
    setProject: (sessionId: string, projectId: string | null): Promise<boolean> =>
      ipcRenderer.invoke('session:set-project', sessionId, projectId)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('joker', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as unknown as { joker: typeof api }).joker = api
}

export type JokerApi = typeof api
