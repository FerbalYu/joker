import { contextBridge, ipcRenderer } from 'electron'
import { STREAM_HIGH_WATER_MARK } from '../shared/types'
import { StreamBridge, type StreamPortLike } from './stream-bridge'
import type {
  StreamEvent,
  StreamFlowState,
  ApprovalRequest,
  AppConfig,
  ChatMessage,
  FetchModelsResult,
  ProviderEntry,
  ProviderTestResult,
  SessionMeta,
  McpServerConfig,
  McpServerRuntime,
  ReasoningLevel,
  SkillDescriptor,
  ImageProviderConfig,
  ImageProviderEntry,
  ImageFetchModelsResult,
  ImageProviderTestResult,
  GeneratedImageRef,
  GeneratedImageReadResult,
  ProjectState,
  GitStatus,
  RunMode
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
    send: (_port: MessagePort, sessionId: string, messages: unknown[], reasoningLevel: ReasoningLevel, skillIds?: string[], projectId?: string, runId = crypto.randomUUID(), runMode: RunMode = 'chat'): boolean =>
      streamBridge.send({ type: 'chat:send', sessionId, runId, messages, reasoningLevel, skillIds, projectId, runMode }),
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
    pendingCount: (): Promise<number> => ipcRenderer.invoke('approval:pending-count'),
    setMode: (mode: 'suggest' | 'auto-edit' | 'full-auto'): void => {
      ipcRenderer.invoke('approval:set-mode', mode)
    }
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
    enable: (id: string): Promise<boolean> => ipcRenderer.invoke('skill:enable', id),
    disable: (id: string): Promise<boolean> => ipcRenderer.invoke('skill:disable', id),
    reload: (): Promise<SkillDescriptor[]> => ipcRenderer.invoke('skill:reload')
  },
  web: {
    preview: (url: string): Promise<{ url: string; finalUrl?: string; title?: string; hostname?: string; source: 'http' | 'browser' | 'none'; status?: number; error?: string }> => ipcRenderer.invoke('web:preview', url)
  },
  file: {
    reveal: (url: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('file:reveal', url),
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
    append: (sessionId: string, message: ChatMessage): Promise<boolean> =>
      ipcRenderer.invoke('session:append', sessionId, message),
    replaceMessages: (sessionId: string, messages: ChatMessage[]): Promise<boolean> => ipcRenderer.invoke('session:replace-messages', sessionId, messages),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('session:delete', id),
    rename: (id: string, title: string): Promise<boolean> =>
      ipcRenderer.invoke('session:rename', id, title),
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
