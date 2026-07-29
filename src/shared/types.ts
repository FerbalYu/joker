// Shared types between main process and renderer

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatTextPart {
  type: 'text'
  text: string
}

export interface ChatImagePart {
  type: 'image'
  data: string
  mediaType: string
  filename?: string
  sizeBytes?: number
}

export type ChatPart = ChatTextPart | ChatImagePart

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  parts?: ChatPart[]
  skillIds?: string[]
  toolCalls?: ToolCallInfo[]
  /** Chronological assistant blocks: text before tools, tool groups, text after tools. */
  segments?: AssistantSegment[]
  usage?: StreamUsage
  durationMs?: number
  createdAt: number
}

export interface ToolCallInfo {
  toolCallId?: string
  toolName: string
  input: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
  status: 'running' | 'done' | 'error'
}

export type AssistantSegment =
  | { type: 'text'; text: string }
  | { type: 'tools'; tools: ToolCallInfo[] }

export interface StreamUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
}

export type ReasoningLevel = 'auto' | 'none' | 'low' | 'medium' | 'high'

export const REASONING_LEVELS: ReasoningLevel[] = ['auto', 'none', 'low', 'medium', 'high']

export function toSdkReasoning(level: ReasoningLevel):
  | 'provider-default'
  | 'none'
  | 'low'
  | 'medium'
  | 'high' {
  return level === 'auto' ? 'provider-default' : level
}

export function normalizeReasoningLevel(value: unknown): ReasoningLevel {
  return typeof value === 'string' && REASONING_LEVELS.includes(value as ReasoningLevel)
    ? (value as ReasoningLevel)
    : 'auto'
}

export interface ContextUsage {
  inputTokens: number
  maxTokens: number
  percent: number
  messageTokens: number
  mcpTokens: number
  systemTokens: number
  toolTokens: number
  skillTokens: number
  systemPromptTokens: number
  otherTokens: number
  cacheHitRate?: number
}

export type StreamEvent =
  | { type: 'token'; sessionId: string; runId?: string; text: string }
  | { type: 'message-start'; sessionId: string; runId?: string; messageId: string; providerName?: string; modelName?: string }
  | { type: 'message-end'; sessionId: string; runId?: string; messageId: string; usage?: StreamUsage }
  | { type: 'context-usage'; sessionId: string; runId?: string; usage: ContextUsage }
  | { type: 'tool-call'; sessionId: string; runId?: string; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool-result'; sessionId: string; runId?: string; toolCallId: string; toolName: string; output: string; metadata?: Record<string, unknown> }
  | { type: 'tool-error'; sessionId: string; runId?: string; toolCallId: string; toolName: string; error: string }
  | { type: 'error'; sessionId: string; runId?: string; error: string }
  | { type: 'abort'; sessionId: string; runId?: string }
  | { type: 'done'; sessionId: string; runId?: string }

export const STREAM_TRANSPORT_VERSION = 'stream-flow-v1'
export const STREAM_HIGH_WATER_MARK = 32
export const STREAM_TERMINAL_RESERVE = 3

export interface StreamFlowState {
  contractVersion: typeof STREAM_TRANSPORT_VERSION
  event: 'ready' | 'queued' | 'blocked' | 'ack' | 'resumed' | 'drain' | 'cancelled' | 'closed'
  ready: boolean
  closed: boolean
  queueDepth: number
  pending: number
  inFlight: number
  availableCredit: number
  maxQueueDepth: number
  maxInFlight: number
  sentCount: number
  ackCount: number
  blockedSends: number
  resumedCount: number
  drainCount: number
  highWaterMark: number
  terminalReserve: number
  runId?: string
  runs: Record<string, {
    sentCount: number
    ackCount: number
    maxQueueDepth: number
    maxInFlight: number
    blockedSends: number
    resumedCount: number
    drainCount: number
  }>
}

export interface StreamEventEnvelope {
  type: 'stream:event'
  seq: number
  runId: string
  event: StreamEvent
}

export interface StreamAckMessage {
  type: 'stream:ack'
  seq: number
  runId: string
}

export interface StreamReadyMessage {
  type: 'stream:ready'
  credit: number
}

export type StreamControlMessage = StreamAckMessage | StreamReadyMessage

// Approval events (over IPC, not MessagePort)
export interface ApprovalRequest {
  requestId: string
  windowId: number
  runId: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
}

export type ProviderType = 'openai' | 'anthropic' | 'ollama' | 'openai-compatible'

export type ApiFormat = 'chat-completions' | 'responses' | 'anthropic-messages'

export interface ProviderConfig {
  provider: ProviderType
  apiFormat: ApiFormat
  model: string
  apiKey?: string
  baseUrl?: string
  modelsPath?: string
}

export const DEFAULT_MAX_CONTEXT_TOKENS = 262_144

export interface ModelConfig {
  id: string
  name: string
  enabled: boolean
  maxContextTokens?: number
}

export interface ProviderEntry {
  id: string
  name: string
  type: ProviderType
  apiFormat: ApiFormat
  modelsPath?: string
  enabled: boolean
  apiKey?: string
  baseUrl?: string
  models: ModelConfig[]
  currentModelId: string
}

export type McpTrustState = 'untrusted' | 'trusted' | 'changed'
export type McpPermission = 'deny' | 'allow'
export type McpRecoveryState = 'idle' | 'recovering' | 'crashed' | 'cutoff'

export interface McpRecoveryConfig {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

export interface McpAuditEvent {
  timestamp: string
  serverId: string
  serverName: string
  transport: McpServerConfig['transport']
  fingerprint: string
  generation: number
  event: string
  status?: string
  error?: string
  pid?: number
  retry?: number
}

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  autoConnect?: boolean
  trustState?: McpTrustState
  trustedFingerprint?: string
  permission?: McpPermission
  initializeTimeoutMs?: number
  callTimeoutMs?: number
  recovery?: McpRecoveryConfig
}

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface McpServerRuntime {
  id: string
  name: string
  enabled: boolean
  transport: McpServerConfig['transport']
  connected: boolean
  status: McpServerStatus
  error?: string
  toolCount: number
  trustState: McpTrustState
  trustedFingerprint?: string
  fingerprint: string
  permission: McpPermission
  recoveryState: McpRecoveryState
  retryCount: number
  pid?: number
}

export interface SkillDescriptor {
  id: string
  name: string
  description: string
  version?: string
  source: 'builtin' | 'user' | 'external'
  instructions: string
  allowedMcpTools: string[]
  enabled: boolean
  trusted: boolean
  error?: string
}

export interface AppConfig {
  providers: ProviderEntry[]
  activeProviderId: string
  mcpServers?: McpServerConfig[]
  disabledSkills?: string[]
}


export interface FetchModelsResult {
  success: boolean
  models: ModelConfig[]
  latencyMs?: number
  error?: string
}

export interface ProviderTestResult {
  success: boolean
  status: 'available' | 'unavailable' | 'unconfigured'
  modelId: string
  latencyMs?: number
  message: string
}

export type ImageProviderProtocol = 'openai-images' | 'grok-images'

export interface ImageProviderEntry {
  id: string
  enabled: boolean
  name: string
  protocol: ImageProviderProtocol
  baseUrl: string
  apiKey: string
  model: string
  modelsPath: string
  defaultSize: string
  defaultAspectRatio: string
  defaultResolution: string
  responseFormat: 'url' | 'b64_json'
}

export interface ImageProviderConfig {
  providers: ImageProviderEntry[]
  activeProviderId: string
}

export interface ImageFetchModelsResult {
  success: boolean
  models: string[]
  latencyMs?: number
  error?: string
}

export interface ImageProviderTestResult {
  success: boolean
  status: 'available' | 'unavailable' | 'unconfigured'
  modelId: string
  latencyMs?: number
  message: string
}

export interface GeneratedImageRef {
  id: string
  sessionId: string
  filename: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  sizeBytes: number
  createdAt: number
}

export interface GeneratedImageReadResult {
  success: boolean
  data?: string
  mediaType?: GeneratedImageRef['mediaType']
  error?: string
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Project bound to this conversation; absent means no working folder. */
  projectId?: string
}

export interface ProjectEntry {
  id: string
  name: string
  path: string
  lastUsedAt: number
}

export interface ProjectState {
  projects: ProjectEntry[]
  activeProjectId: string | null
}

export interface GitStatus {
  isRepository: boolean
  branch: string | null
  detached: boolean
  ahead: number
  behind: number
  changed: number
  untracked: number
  conflicted: number
  clean: boolean
  available: boolean
  error?: string
}
