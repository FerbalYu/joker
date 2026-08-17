// Shared types between main process and renderer

export type {
  ContextOptimizationMetrics,
  ContextOptimizationMode,
  ContextReference,
  ContextTransformMetric as ContextOptimizationTransform,
  SessionContextCheckpoint,
  SessionContextSummary
} from './context'
import type { ContextOptimizationMetrics, ContextOptimizationMode } from './context'

export type {
  CapabilityRevisionReason,
  CapabilityRevisionState,
  ForgeJob,
  ForgeJobMode,
  ForgeJobStatus,
  GeneratedToolActivePointer,
  GeneratedToolAvailability,
  GeneratedToolDescriptor,
  GeneratedToolCandidate,
  GeneratedToolForgeAttempt,
  GeneratedToolInvocation,
  GeneratedToolInvocationOutcome,
  GeneratedToolInvocationState,
  GeneratedToolInvocationStatus,
  GeneratedToolManifest,
  GeneratedToolNetworkMethod,
  GeneratedToolPermissionManifest,
  GeneratedToolRegistryEntry,
  GeneratedToolRegistryState,
  GeneratedToolRuntimeId,
  GeneratedToolScope,
  GeneratedToolSpec,
  GeneratedToolValidationCheck,
  GeneratedToolValidationCheckCategory,
  GeneratedToolValidationCheckStatus,
  GeneratedToolValidationReport,
  GeneratedToolValidationReportStatus,
  GeneratedToolVersion,
  GeneratedToolVersionTrustState,
  GeneratedToolValidationProfileId,
  GeneratedToolPolicyInput,
  GeneratedToolPolicyDecision,
  GeneratedToolPolicyOperation,
  GeneratedToolPolicyAction,
  GeneratedToolPolicyReasonCode,
  GeneratedToolPromotionApprovalReceipt,
  GeneratedToolPromotionJournal,
  GeneratedToolPromotionJournalPhase,
  ToolForgeContinuationV2,
  ToolForgeContinuationV2Status,
  ToolForgeContinuationClaim,
  ToolForgeContinuationState,
  ToolForgeContinuationStatus,
  ToolForgeOperationRecord,
  RuntimeQualificationCandidateId,
  RuntimeQualificationCandidateResult,
  RuntimeQualificationCaseId,
  RuntimeQualificationCaseResult,
  RuntimeQualificationCaseStatus,
  RuntimeQualificationEnvironment,
  RuntimeQualificationEnvironmentResult,
  RuntimeQualificationLevel,
  RuntimeQualificationReport
} from './generated-tools'
export type {
  GeneratedToolCandidateSummary,
  GeneratedToolDetail,
  GeneratedToolDetailResult,
  GeneratedToolEffectiveAvailability,
  GeneratedToolGetInput,
  GeneratedToolIntegrityState,
  GeneratedToolInventoryItem,
  GeneratedToolInvocationView,
  GeneratedToolJobStatusInput,
  GeneratedToolJobStatusResult,
  GeneratedToolJobStatusView,
  GeneratedToolJobView,
  GeneratedToolReadIssue,
  GeneratedToolsInventorySnapshot,
  GeneratedToolsListResult,
  GeneratedToolsQualificationCaseSummary,
  GeneratedToolsQualificationOperationView,
  GeneratedToolsQualificationOperationResult,
  GeneratedToolsReadError,
  GeneratedToolsReadErrorCode,
  GeneratedToolsReadResult,
  GeneratedToolValidationCheckView,
  GeneratedToolValidationReportView,
  GeneratedToolEnableInput,
  GeneratedToolEnableResult,
  GeneratedToolEditRequest,
  GeneratedToolEditResult,
  GeneratedToolContinuationView,
  GeneratedToolContinuationListResult,
  GeneratedToolLifecycleMutationResult,
  GeneratedToolRevalidateInput,
  GeneratedToolRevalidateResult,
  GeneratedToolRemoveResult,
  GeneratedToolExportResult
} from './generated-tools-management'
export {
  GeneratedToolEditRequestSchema,
  GeneratedToolJobStatusInputSchema,
  GeneratedToolEnableInputSchema,
  GeneratedToolLifecycleMutationRequestSchema,
  GeneratedToolRemoveInputSchema,
  GeneratedToolExportInputSchema,
  GeneratedToolRevalidateInputSchema,
  parseGeneratedToolEditRequest,
  parseGeneratedToolJobStatusInput,
  parseGeneratedToolEnableInput,
  parseGeneratedToolRemoveInput,
  parseGeneratedToolExportInput,
  parseGeneratedToolRevalidateInput
} from './generated-tools-management'
export {
  CapabilityRevisionReasonSchema,
  CapabilityRevisionStateSchema,
  ForgeJobModeSchema,
  ForgeJobSchema,
  ForgeJobStatusSchema,
  GeneratedToolActivePointerSchema,
  GeneratedToolAvailabilitySchema,
  GeneratedToolDescriptorSchema,
  GeneratedToolCandidateSchema,
  GeneratedToolForgeAttemptSchema,
  GeneratedToolInvocationOutcomeSchema,
  GeneratedToolInvocationSchema,
  GeneratedToolInvocationStateSchema,
  GeneratedToolInvocationStatusSchema,
  GeneratedToolManifestSchema,
  GeneratedToolNetworkMethodSchema,
  GeneratedToolPermissionManifestSchema,
  GeneratedToolRegistryEntrySchema,
  GeneratedToolRegistryStateSchema,
  GeneratedToolRuntimeIdSchema,
  GeneratedToolScopeSchema,
  GeneratedToolSpecSchema,
  GeneratedToolValidationCheckCategorySchema,
  GeneratedToolValidationCheckSchema,
  GeneratedToolValidationCheckStatusSchema,
  GeneratedToolValidationReportSchema,
  GeneratedToolValidationReportStatusSchema,
  GeneratedToolVersionSchema,
  GeneratedToolVersionTrustStateSchema,
  GeneratedToolValidationProfileIdSchema,
  GeneratedToolPolicyInputSchema,
  GeneratedToolPolicyDecisionSchema,
  GeneratedToolPolicyOperationSchema,
  GeneratedToolPolicyActionSchema,
  GeneratedToolPolicyReasonCodeSchema,
  GeneratedToolPromotionApprovalReceiptSchema,
  GeneratedToolPromotionJournalSchema,
  GeneratedToolPromotionJournalPhaseSchema,
  ToolForgeContinuationV2Schema,
  ToolForgeContinuationV2StatusSchema,
  ToolForgeContinuationClaimSchema,
  ToolForgeContinuationStateSchema,
  ToolForgeContinuationStatusSchema,
  ToolForgeOperationRecordSchema,
  RuntimeQualificationCandidateIdSchema,
  RuntimeQualificationCandidateResultSchema,
  RuntimeQualificationCaseIdSchema,
  RuntimeQualificationCaseResultSchema,
  RuntimeQualificationCaseStatusSchema,
  RuntimeQualificationEnvironmentResultSchema,
  RuntimeQualificationEnvironmentSchema,
  RuntimeQualificationLevelSchema,
  RuntimeQualificationReportSchema,
  canonicalGeneratedToolJson,
  parseCapabilityRevisionState,
  parseForgeJob,
  parseGeneratedToolActivePointer,
  parseGeneratedToolDescriptor,
  parseGeneratedToolCandidate,
  parseGeneratedToolForgeAttempt,
  parseGeneratedToolInvocationState,
  parseGeneratedToolManifest,
  parseGeneratedToolRegistryState,
  parseGeneratedToolSpec,
  parseGeneratedToolValidationReport,
  parseGeneratedToolVersion,
  parseRuntimeQualificationReport,
  parseToolForgeContinuationState
} from './generated-tools-schema'

export type {
  GeneratedToolCompatibilityContract,
  GeneratedToolCompatibilityReason,
  GeneratedToolCompatibilityReasonCode,
  GeneratedToolCompatibilityResult,
  SupportedGeneratedToolRuntimeId,
  SupportedGeneratedToolRuntimeVersion,
  SupportedGeneratedToolSchemaVersion,
  SupportedGeneratedToolSdkVersion
} from './generated-tools-compatibility'
export {
  GENERATED_TOOL_COMPATIBILITY_CONTRACT,
  SUPPORTED_GENERATED_TOOL_RUNTIME_IDS,
  SUPPORTED_GENERATED_TOOL_RUNTIME_VERSIONS,
  SUPPORTED_GENERATED_TOOL_SCHEMA_VERSIONS,
  SUPPORTED_GENERATED_TOOL_SDK_VERSIONS,
  checkGeneratedToolCompatibility
} from './generated-tools-compatibility'

export type MessageRole = 'user' | 'assistant' | 'system'
export type RunMode = 'chat' | 'research'
export type ChatIntent = 'plan'

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
  runMode?: RunMode
  toolCalls?: ToolCallInfo[]
  /** Chronological assistant blocks: text before tools, tool groups, text after tools. */
  segments?: AssistantSegment[]
  usage?: StreamUsage
  durationMs?: number
  createdAt: number
}

export type PendingUserMessageMode = 'queue' | 'steer'
export type PendingUserMessageStatus = 'queued' | 'claimed'

export interface PendingUserMessage {
  mode: PendingUserMessageMode
  status: PendingUserMessageStatus
  message: ChatMessage
  sequence: number
  targetRunId?: string
  createdAt: number
  claimedByRunId?: string
  claimedAt?: number
}

export interface PendingUserMessageEnqueueInput {
  mode: PendingUserMessageMode
  message: ChatMessage
  targetRunId?: string
}

export interface PendingUserMessageResult {
  success: boolean
  changed?: boolean
  pendingMessage?: PendingUserMessage
  messageQueueRevision?: number
  error?:
    | 'invalid-session'
    | 'invalid-input'
    | 'not-found'
    | 'not-queued'
    | 'conflict'
    | 'invalid-order'
}

export interface PendingUserMessageListResult {
  success: boolean
  pending: PendingUserMessage[]
  messageQueueRevision: number
  error?: 'invalid-session'
}

export type ToolCallStatus = 'running' | 'done' | 'error' | 'denied' | 'cancelled' | 'timed-out'

export interface ToolCallInfo {
  toolCallId?: string
  toolName: string
  input: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
  status: ToolCallStatus
  startedAt?: number
  updatedAt?: number
  lastProgressAt?: number
  deadlineAt?: number
  durationMs?: number
  error?: string
}

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type SubagentPhase = 'queued' | 'starting' | 'working' | 'using-tool' | 'finalizing' | 'completed' | 'failed' | 'cancelled'

export interface SubagentToolActivity {
  id: string
  toolName: string
  summary?: string
  status: ToolCallStatus
  startedAt: number
  completedAt?: number
  durationMs?: number
  error?: string
}

/** Observable execution facts only. Hidden model reasoning is intentionally excluded. */
export interface SubagentActivity {
  id: string
  parentToolCallId?: string
  task: string
  status: SubagentStatus
  phase: SubagentPhase
  createdAt: number
  startedAt?: number
  updatedAt: number
  completedAt?: number
  currentStep: number
  maxSteps: number
  tools: SubagentToolActivity[]
  outputPreview?: string
  usage?: StreamUsage
  error?: string
}

export type AssistantSegment =
  | { type: 'text'; text: string }
  | { type: 'tools'; tools: ToolCallInfo[] }

export interface StreamUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  noCacheTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  stepCount?: number
  /** Wall-clock ms from run start to first streamed token across all steps. */
  firstTokenMs?: number
  /** Wall-clock ms spent decoding between first token and run completion. */
  generationMs?: number
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
  source?: 'provider' | 'estimate'
  stepNumber?: number
  compressionCount?: number
  compressionBeforeTokens?: number
  compressionAfterTokens?: number
  compressionError?: string
  optimization?: ContextOptimizationMetrics
}

export type StreamEvent =
  | { type: 'token'; sessionId: string; runId?: string; text: string }
  | { type: 'message-start'; sessionId: string; runId?: string; messageId: string; runMode?: RunMode; providerName?: string; modelName?: string }
  | { type: 'message-end'; sessionId: string; runId?: string; messageId: string; usage?: StreamUsage }
  | { type: 'step-start'; sessionId: string; runId?: string; stepNumber: number }
  | { type: 'queue-updated'; sessionId: string; runId?: string; pending: PendingUserMessage[] }
  | { type: 'message-queued'; sessionId: string; runId?: string; pending: PendingUserMessage }
  | { type: 'message-applied'; sessionId: string; runId: string; pendingMessageId: string; disposition: PendingUserMessageMode; stepNumber?: number }
  | { type: 'message-deferred'; sessionId: string; runId?: string; pendingMessageId: string; reason: string }
  | { type: 'goal-update'; sessionId: string; runId?: string; goal?: GoalState }
  | { type: 'context-usage'; sessionId: string; runId?: string; usage: ContextUsage }
  | { type: 'tool-call'; sessionId: string; runId?: string; toolCallId: string; toolName: string; input: Record<string, unknown>; startedAt?: number; updatedAt?: number; lastProgressAt?: number; deadlineAt?: number }
  | { type: 'tool-status'; sessionId: string; runId?: string; toolCallId: string; toolName: string; status: ToolCallStatus; startedAt?: number; updatedAt: number; lastProgressAt?: number; deadlineAt?: number; durationMs?: number; error?: string; heartbeat?: boolean }
  | { type: 'tool-result'; sessionId: string; runId?: string; toolCallId: string; toolName: string; output: string; metadata?: Record<string, unknown>; startedAt?: number; updatedAt?: number; lastProgressAt?: number; deadlineAt?: number; durationMs?: number }
  | { type: 'tool-error'; sessionId: string; runId?: string; toolCallId: string; toolName: string; error: string; status?: Extract<ToolCallStatus, 'error' | 'cancelled' | 'timed-out'>; startedAt?: number; updatedAt?: number; lastProgressAt?: number; deadlineAt?: number; durationMs?: number }
  | { type: 'subagent-update'; sessionId: string; runId?: string; activity: SubagentActivity }
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
  blockedPending: number
  inFlight: number
  availableCredit: number
  lastAckAt?: number
  blockedSince?: number
  maxBlockedDurationMs: number
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

// Structured user questions raised by the model via AskUserQuestion
export interface UserQuestionOption {
  id: string
  label: string
  description?: string
}

export interface UserQuestionRequest {
  requestId: string
  sessionId: string
  runId: string
  header?: string
  question: string
  multiSelect: boolean
  options: UserQuestionOption[]
  allowFreeText: boolean
}

export interface UserQuestionAnswerPayload {
  requestId: string
  sessionId: string
  runId: string
  selectedIds: string[]
  freeText: string | null
  cancelled?: boolean
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
  includeUsage?: boolean
  promptCache?: boolean
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
  includeUsage?: boolean
  promptCache?: boolean
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

export type SkillTrustState = 'trusted' | 'untrusted' | 'changed'

export interface TrustedSkillRecord {
  id: string
  fingerprint: string
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
  fingerprint?: string
  trustState?: SkillTrustState
  error?: string
}

export interface SkillActionResult {
  success: boolean
  error?: string
  skill?: SkillDescriptor
}

export interface ToolForgeFullTrustConfig {
  /** Canonical workspace paths for explicit, user-owned ToolForge full-trust grants. */
  workspacePaths: string[]
}

export interface ToolForgeFullTrustState {
  projectId: string
  projectName: string
  workspacePath: string
  granted: boolean
}

export interface ToolForgeFullTrustResult {
  success: boolean
  data?: ToolForgeFullTrustState
  error?: string
}

export interface AppConfig {
  providers: ProviderEntry[]
  activeProviderId: string
  contextOptimizationMode?: ContextOptimizationMode
  mcpServers?: McpServerConfig[]
  /** Legacy migration input. Current Skill availability is fingerprint-record based. */
  disabledSkills?: string[]
  /** Current content fingerprints that the user enabled. */
  trustedSkills?: TrustedSkillRecord[]
  skillStateVersion?: 1
  /** Explicit, user-owned ToolForge full-trust grants, bound to canonical workspaces. */
  toolForgeFullTrust?: ToolForgeFullTrustConfig
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

export type ImageProviderProtocol = 'openai-images' | 'grok-images' | 'agnes-images'

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

export type GoalStatus =
  | 'queued'
  | 'executing'
  | 'validating'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'interrupted'

export type GoalPhase = 'execution' | 'validation'

export type GoalStopReason =
  | 'user-paused'
  | 'legacy-migration'
  | 'recovered-after-restart'
  | 'max-rounds'
  | 'token-limit'
  | 'evaluator-blocked'
  | 'completed'
  | 'execution-error'
  | 'evaluation-error'

export interface GoalExecutionContext {
  projectId?: string
  skillIds: string[]
  reasoningLevel: ReasoningLevel
}

export interface GoalInvocationIds {
  execution?: string
  validation?: string
}

export interface GoalHistoryEntry {
  phase: GoalPhase | 'system'
  status: GoalStatus
  round: number
  revision: number
  createdAt: number
  invocationId?: string
  messageId?: string
  usageOperationId?: string
  usage?: StreamUsage
  feedback?: string
  evaluation?: string
  stopReason?: GoalStopReason
}

export interface GoalUsageOperation {
  id: string
  invocationId: string
  /** Omitted by schema-v4 execution operations written before evaluator accounting. */
  phase?: GoalPhase
  messageId?: string
  usage: StreamUsage
  appliedAt: number
}

export interface GoalState {
  id: string
  /** User-visible objective. */
  objective: string
  status: GoalStatus
  generation: number
  revision: number
  currentRound: number
  history: GoalHistoryEntry[]
  currentInvocationIds: GoalInvocationIds
  executionContext: GoalExecutionContext
  cumulativeUsage: StreamUsage
  appliedUsageOperations: GoalUsageOperation[]
  maxRounds: number
  tokenLimit?: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  pausedAt?: number
  /** Phase to continue after a pause or restart interruption. */
  resumePhase?: GoalPhase
  feedback?: string
  evaluation?: string
  stopReason?: GoalStopReason
}

export interface GoalCas {
  goalId: string
  generation: number
  revision: number
}

export interface GoalCreateInput {
  objective: string
  executionContext?: Partial<GoalExecutionContext>
  maxRounds?: number
  tokenLimit?: number
}

export interface GoalClaimInput extends GoalCas {
  phase: GoalPhase
  invocationId: string
}

export interface GoalExecutionCommitInput extends GoalCas {
  invocationId: string
  usageOperationId: string
  message: ChatMessage
  usage?: StreamUsage
}

export interface GoalEvaluationCommitInput extends GoalCas {
  invocationId: string
  usageOperationId?: string
  usage?: StreamUsage
  outcome: 'complete' | 'continue' | 'blocked'
  evaluation: string
  feedback?: string
  stopReason?: Extract<GoalStopReason, 'completed' | 'evaluator-blocked' | 'max-rounds' | 'token-limit'>
}

export interface GoalPauseInput extends GoalCas {
  stopReason?: 'user-paused' | 'execution-error' | 'evaluation-error'
  feedback?: string
}

export interface GoalTransitionResult {
  success: boolean
  changed?: boolean
  goal?: GoalState
  invocationId?: string
  error?:
    | 'invalid-session'
    | 'invalid-goal'
    | 'no-goal'
    | 'stale-goal'
    | 'invalid-transition'
    | 'invalid-message'
    | 'invalid-usage'
    | 'conflict'
}

export interface SessionRunActivityRecord {
  state: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  terminalRevision: number
  seenTerminalRevision: number
  runId?: string
  kind?: 'chat' | 'goal'
  startedAt?: number
  finishedAt?: number
  error?: string
}

export type SessionLivePhase =
  | 'starting'
  | 'waiting-model'
  | 'streaming-text'
  | 'running-tools'
  | 'awaiting-approval'
  | 'finalizing'

export type SessionDisplayStatus =
  | 'idle'
  | 'running'
  | 'awaiting-user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface SessionActivitySummary {
  status: SessionDisplayStatus
  unread: boolean
  terminalRevision: number
  seenTerminalRevision: number
  pendingApprovalCount: number
  livePhase?: SessionLivePhase
  runId?: string
  kind?: 'chat' | 'goal'
  startedAt?: number
  finishedAt?: number
  error?: string
}

export interface SessionSummary extends SessionMeta {
  activity: SessionActivitySummary
}

export interface SessionSummaryChangedEvent {
  type: 'upsert' | 'delete'
  sessionId: string
  summary?: SessionSummary
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Persistent Goal state; objective remains the user-visible text. */
  goal?: GoalState
  /** Project bound to this conversation; absent means no working folder. */
  projectId?: string
}

export interface SessionGoalResult {
  success: boolean
  /** User-visible objective retained for existing command/UI callers. */
  goal?: string
  state?: GoalState
  error?: 'invalid-session' | 'invalid-goal'
}

export interface SessionCompactResult {
  success: boolean
  changed: boolean
  beforeTokens: number
  afterTokens: number
  retainedMessageCount: number
  sourceMessageCount: number
  error?: 'invalid-session' | 'not-enough-history' | 'stale-session' | 'model-error' | 'invalid-summary' | 'save-failed'
  message?: string
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
