import { cleanupSessionOperations } from './operations'
import { createHash } from 'node:crypto'
import * as electron from 'electron'
import { join } from 'node:path'
import {
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import type {
  ChatMessage,
  ContextReference,
  GoalCas,
  GoalClaimInput,
  GoalEvaluationCommitInput,
  GoalExecutionCommitInput,
  GoalPauseInput,
  GoalState,
  GoalTransitionResult,
  PendingUserMessage,
  PendingUserMessageEnqueueInput,
  PendingUserMessageListResult,
  PendingUserMessageResult,
  SessionContextCheckpoint,
  SessionGoalResult,
  SessionMeta,
  SessionRunActivityRecord,
  StreamUsage,
  ToolCallInfo
} from '@shared/types'
import { hashChatMessageRange, hashChatMessages } from '../session-context'
import {
  MAX_GOAL_EVALUATION_LENGTH,
  MAX_GOAL_FEEDBACK_LENGTH,
  MAX_GOAL_USAGE_OPERATIONS,
  addGoalUsage,
  boundedHistory,
  createGoalState,
  goalCasMatches,
  isValidGoalCas,
  isValidGoalIdentifier,
  isValidGoalState,
  isValidGoalText,
  isValidStreamUsage,
  LEGACY_DEFAULT_GOAL_TOKEN_LIMIT,
  migrateLegacyGoal,
  normalizeGoalCas,
  normalizeGoalCreateInput,
  normalizeRecoveredGoal,
  sameGoalUsage
} from '../goal/state'
import { getMessageText, validateChatParts } from '../../shared/messages'
import { cleanupGeneratedImages } from './generated-images'
import { withDirectoryLock } from './atomic-json'
import { resolveProjectPath } from './projects'
import { getJokerHomeDir } from './paths'

interface StoredSession extends SessionMeta {
  messages: ChatMessage[]
  pendingUserMessages: PendingUserMessage[]
  messageQueueRevision: number
  runActivity: SessionRunActivityRecord
  contextCheckpoint?: SessionContextCheckpoint
  /** Monotonic fence retained when a Goal is cleared. */
  goalGeneration?: number
}

interface SessionEnvelopeV1 {
  schemaVersion: 1
  data: Omit<StoredSession, 'contextCheckpoint' | 'pendingUserMessages' | 'messageQueueRevision'>
}

interface SessionEnvelopeV2 {
  schemaVersion: 2
  data: Omit<StoredSession, 'pendingUserMessages' | 'messageQueueRevision'>
}

interface SessionEnvelopeV3 {
  schemaVersion: 3
  data: Omit<StoredSession, 'pendingUserMessages' | 'messageQueueRevision'>
}

interface SessionEnvelopeV4 {
  schemaVersion: 4
  data: Omit<StoredSession, 'pendingUserMessages' | 'messageQueueRevision'>
}

interface SessionEnvelopeV5 {
  schemaVersion: 5
  data: Omit<StoredSession, 'runActivity'>
}

interface SessionEnvelopeV6 {
  schemaVersion: 6
  data: StoredSession
}

interface SessionEnvelopeV7 {
  schemaVersion: 7
  data: StoredSession
}

type SessionEnvelope = SessionEnvelopeV1 | SessionEnvelopeV2 | SessionEnvelopeV3 | SessionEnvelopeV4 | SessionEnvelopeV5 | SessionEnvelopeV6 | SessionEnvelopeV7

export { MAX_GOAL_OBJECTIVE_LENGTH as MAX_SESSION_GOAL_LENGTH } from '../goal/state'
const SESSION_SCHEMA_VERSION = 7
const SESSION_LOCK_TIMEOUT_MS = 30_000
let sessionsDataDirOverride: string | null = null
const recoveryCheckedSessionIds = new Set<string>()

/** Test-only storage override; production callers should use the default app directory. */
export function setSessionsDataDirForTests(dir: string | null): void {
  sessionsDataDirOverride = dir
  recoveryCheckedSessionIds.clear()
}

function getDataDir(): string {
  if (sessionsDataDirOverride) return sessionsDataDirOverride
  const home = typeof electron.app?.getPath === 'function' ? electron.app.getPath('home') : getJokerHomeDir()
  return join(home, '.joker', 'sessions')
}

function ensureDataDir(): void {
  const dir = getDataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id)
}

function getSessionPath(id: string): string {
  if (!isValidSessionId(id)) throw new Error('Invalid session id')
  return join(getDataDir(), `${id}.json`)
}

function isValidMessage(message: unknown): message is ChatMessage {
  if (!message || typeof message !== 'object') return false
  const candidate = message as Partial<ChatMessage>
  if (typeof candidate.id !== 'string' || !candidate.id || typeof candidate.role !== 'string') return false
  if (!['user', 'assistant', 'system'].includes(candidate.role)) return false
  if (typeof candidate.content !== 'string' || typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt)) return false
  if (candidate.runMode !== undefined && candidate.runMode !== 'chat' && candidate.runMode !== 'research') return false
  return candidate.parts === undefined || validateChatParts(candidate.parts)
}

function isValidPendingUserMessage(value: unknown): value is PendingUserMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PendingUserMessage>
  if (candidate.mode !== 'queue' && candidate.mode !== 'steer') return false
  if (candidate.status !== 'queued' && candidate.status !== 'claimed') return false
  if (!isValidMessage(candidate.message) || candidate.message.role !== 'user') return false
  if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence ?? 0) < 1) return false
  if (typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt)) return false
  if (candidate.targetRunId !== undefined && (typeof candidate.targetRunId !== 'string' || !candidate.targetRunId)) return false
  if (candidate.mode === 'steer' ? candidate.targetRunId === undefined : candidate.targetRunId !== undefined) return false
  if (candidate.claimedByRunId !== undefined && (typeof candidate.claimedByRunId !== 'string' || !candidate.claimedByRunId)) return false
  if (candidate.claimedAt !== undefined && (typeof candidate.claimedAt !== 'number' || !Number.isFinite(candidate.claimedAt))) return false
  return candidate.status === 'queued'
    ? candidate.claimedByRunId === undefined && candidate.claimedAt === undefined
    : candidate.claimedByRunId !== undefined && candidate.claimedAt !== undefined
}

function isValidContextCheckpoint(value: unknown): value is SessionContextCheckpoint {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SessionContextCheckpoint>
  const summary = candidate.summary as Partial<SessionContextCheckpoint['summary']> | undefined
  return candidate.version === 1 &&
    typeof candidate.policyVersion === 'string' && candidate.policyVersion.length > 0 &&
    typeof candidate.sourceFromMessageId === 'string' && candidate.sourceFromMessageId.length > 0 &&
    typeof candidate.sourceUntilMessageId === 'string' && candidate.sourceUntilMessageId.length > 0 &&
    typeof candidate.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(candidate.sourceHash) &&
    typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) &&
    typeof candidate.estimatedSourceTokens === 'number' && candidate.estimatedSourceTokens >= 0 &&
    typeof candidate.estimatedSummaryTokens === 'number' && candidate.estimatedSummaryTokens >= 0 &&
    Boolean(summary) && typeof summary?.goal === 'string' &&
    ['confirmedFacts', 'decisions', 'filesRead', 'changesMade', 'failedAttempts', 'openTasks', 'criticalIdentifiers']
      .every((key) => Array.isArray(summary?.[key as keyof typeof summary]) && (summary?.[key as keyof typeof summary] as unknown[]).every((item) => typeof item === 'string'))
}

function isValidRunActivity(value: unknown): value is SessionRunActivityRecord {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SessionRunActivityRecord>
  if (!['idle', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(candidate.state ?? '')) return false
  if (!Number.isSafeInteger(candidate.terminalRevision) || (candidate.terminalRevision ?? -1) < 0) return false
  if (!Number.isSafeInteger(candidate.seenTerminalRevision) || (candidate.seenTerminalRevision ?? -1) < 0) return false
  if ((candidate.seenTerminalRevision ?? 0) > (candidate.terminalRevision ?? 0)) return false
  if (candidate.runId !== undefined && (typeof candidate.runId !== 'string' || !candidate.runId)) return false
  if (candidate.kind !== undefined && candidate.kind !== 'chat' && candidate.kind !== 'goal') return false
  if (candidate.startedAt !== undefined && (typeof candidate.startedAt !== 'number' || !Number.isFinite(candidate.startedAt))) return false
  if (candidate.finishedAt !== undefined && (typeof candidate.finishedAt !== 'number' || !Number.isFinite(candidate.finishedAt))) return false
  if (candidate.error !== undefined && typeof candidate.error !== 'string') return false
  return candidate.state !== 'running' || Boolean(candidate.runId && candidate.kind && candidate.startedAt !== undefined)
}

function initialRunActivity(): SessionRunActivityRecord {
  return { state: 'idle', terminalRevision: 0, seenTerminalRevision: 0 }
}

function isValidStoredSession(value: unknown, expectedId?: string): value is StoredSession {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<StoredSession>
  if (!Array.isArray(candidate.messages) || !Array.isArray(candidate.pendingUserMessages)) return false
  if (!Number.isSafeInteger(candidate.messageQueueRevision) || (candidate.messageQueueRevision ?? -1) < 0) return false
  const messages = candidate.messages
  const pendingUserMessages = candidate.pendingUserMessages
  return typeof candidate.id === 'string' && isValidSessionId(candidate.id) && (!expectedId || candidate.id === expectedId) &&
    typeof candidate.title === 'string' && candidate.title.length <= 1000 &&
    typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) &&
    typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt) &&
    (candidate.goal === undefined || isValidGoalState(candidate.goal)) &&
    (candidate.goalGeneration === undefined || (Number.isSafeInteger(candidate.goalGeneration) && candidate.goalGeneration >= 0)) &&
    (candidate.projectId === undefined || typeof candidate.projectId === 'string') &&
    isValidRunActivity(candidate.runActivity) &&
    messages.every(isValidMessage) &&
    pendingUserMessages.every(isValidPendingUserMessage) &&
    new Set(pendingUserMessages.map((pending) => pending.message.id)).size === pendingUserMessages.length &&
    new Set(pendingUserMessages.map((pending) => pending.sequence)).size === pendingUserMessages.length &&
    pendingUserMessages.every((pending) => pending.status === 'claimed' || !messages.some((message) => message.id === pending.message.id)) &&
    pendingUserMessages.every((pending) => pending.status === 'queued' || messages.some((message) => message.id === pending.message.id && exactMessageMatch(message, pending.message))) &&
    (candidate.contextCheckpoint === undefined || isValidContextCheckpoint(candidate.contextCheckpoint))
}

function decodeStoredSession(raw: unknown, expectedId: string, recoverActiveGoal = false): StoredSession | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<SessionEnvelope> & Partial<StoredSession>
  const schemaVersion = candidate.schemaVersion
  const data = schemaVersion === 1 || schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6 || schemaVersion === SESSION_SCHEMA_VERSION
    ? candidate.data
    : raw
  if (!data || typeof data !== 'object') return null
  const decoded = { ...(data as Record<string, unknown>) }
  const preV7Data = schemaVersion === undefined || schemaVersion < SESSION_SCHEMA_VERSION
  if (preV7Data && decoded.goal && typeof decoded.goal === 'object' && !Array.isArray(decoded.goal)) {
    const goal = { ...(decoded.goal as Record<string, unknown>) }
    if (goal.tokenLimit === LEGACY_DEFAULT_GOAL_TOKEN_LIMIT) delete goal.tokenLimit
    decoded.goal = goal
  }
  if (decoded.pendingUserMessages === undefined) decoded.pendingUserMessages = []
  if (decoded.messageQueueRevision === undefined) decoded.messageQueueRevision = 0
  if (decoded.runActivity === undefined) decoded.runActivity = initialRunActivity()
  if (typeof decoded.goal === 'string') {
    const legacyGoalId = `legacy-${createHash('sha256').update(`${expectedId}\u0000${decoded.goal}`).digest('hex').slice(0, 32)}`
    const migrated = migrateLegacyGoal(decoded.goal, typeof decoded.updatedAt === 'number' && Number.isFinite(decoded.updatedAt) ? decoded.updatedAt : Date.now(), legacyGoalId)
    if (!migrated) return null
    decoded.goal = migrated
    decoded.goalGeneration = Math.max(typeof decoded.goalGeneration === 'number' ? decoded.goalGeneration : 0, migrated.generation)
  } else if (isValidGoalState(decoded.goal) && recoverActiveGoal) {
    const recoveredGoal = normalizeRecoveredGoal(decoded.goal, Date.now())
    decoded.goal = recoveredGoal
    decoded.goalGeneration = Math.max(typeof decoded.goalGeneration === 'number' ? decoded.goalGeneration : 0, recoveredGoal.generation)
  }
  if (recoverActiveGoal && isValidRunActivity(decoded.runActivity) && decoded.runActivity.state === 'running') {
    const now = Date.now()
    decoded.runActivity = {
      ...decoded.runActivity,
      state: 'interrupted',
      finishedAt: now,
      terminalRevision: decoded.runActivity.terminalRevision + 1,
      error: 'recovered-after-restart'
    }
  }
  return isValidStoredSession(decoded, expectedId) ? decoded : null
}

function readSessionFile(path: string, expectedId: string, recoverActiveGoal = false): StoredSession | null {
  try {
    return decodeStoredSession(JSON.parse(readFileSync(path, 'utf-8')), expectedId, recoverActiveGoal)
  } catch {
    return null
  }
}

function reconcileRecoveredPendingMessages(session: StoredSession): boolean {
  let changed = false
  for (const pending of session.pendingUserMessages) {
    if (pending.status !== 'claimed') continue
    const messageIndex = session.messages.findIndex((message) => message.id === pending.message.id && exactMessageMatch(message, pending.message))
    if (messageIndex >= 0) session.messages.splice(messageIndex, 1)
    pending.status = 'queued'
    if (pending.mode === 'steer') {
      pending.mode = 'queue'
      delete pending.targetRunId
    }
    delete pending.claimedByRunId
    delete pending.claimedAt
    changed = true
  }
  for (const pending of session.pendingUserMessages) {
    if (pending.status !== 'queued' || pending.mode !== 'steer') continue
    pending.mode = 'queue'
    delete pending.targetRunId
    changed = true
  }
  if (changed) {
    session.messageQueueRevision += 1
    session.updatedAt = Date.now()
  }
  return changed
}

function readSessionWithBackupUnlocked(id: string): StoredSession | null {
  const path = getSessionPath(id)
  const recoverActiveGoal = !recoveryCheckedSessionIds.has(id)
  const session = !existsSync(path)
    ? readSessionFile(`${path}.bak`, id, recoverActiveGoal)
    : readSessionFile(path, id, recoverActiveGoal) ?? readSessionFile(`${path}.bak`, id, recoverActiveGoal)
  if (recoverActiveGoal && session) {
    const recoveredLifecycle = (session.goal?.status === 'interrupted' &&
      (session.goal.stopReason === 'recovered-after-restart' || session.goal.stopReason === 'legacy-migration')) ||
      (session.runActivity.state === 'interrupted' && session.runActivity.error === 'recovered-after-restart')
    const reconciledPending = reconcileRecoveredPendingMessages(session)
    if (recoveredLifecycle || reconciledPending) writeSessionUnlocked(session)
    recoveryCheckedSessionIds.add(id)
  }
  return session
}

function withSessionLock<T>(id: string, operation: () => T): T {
  ensureDataDir()
  const path = getSessionPath(id)
  return withDirectoryLock(path, operation, { timeoutMs: SESSION_LOCK_TIMEOUT_MS })
}

function readSessionWithBackup(id: string): StoredSession | null {
  return withSessionLock(id, () => readSessionWithBackupUnlocked(id))
}

function writeSessionUnlocked(session: StoredSession): void {
  ensureDataDir()
  const path = getSessionPath(session.id)
  const tempPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const envelope: SessionEnvelope = { schemaVersion: SESSION_SCHEMA_VERSION, data: session }
    writeFileSync(tempPath, JSON.stringify(envelope, null, 2), 'utf-8')
    const fd = openSync(tempPath, 'r')
    try {
      fsyncSync(fd)
    } catch {
      // Some Windows filesystems do not allow fsync on a newly-created file.
    } finally {
      closeSync(fd)
    }

    const backupPath = `${path}.bak`
    if (existsSync(path) && readSessionFile(path, session.id)) {
      copyFileSync(path, backupPath)
      try {
        const backupFd = openSync(backupPath, 'r')
        try {
          fsyncSync(backupFd)
        } catch {
          // Best-effort directory/file durability on platforms that reject fsync.
        } finally {
          closeSync(backupFd)
        }
      } catch {
        // The primary write remains valid even if backup durability cannot be synced.
      }
    }
    try {
      renameSync(tempPath, path)
    } catch (error) {
      // Windows cannot replace an existing destination with renameSync; the backup above keeps recovery possible.
      if (process.platform !== 'win32' || !existsSync(path)) throw error
      unlinkSync(path)
      renameSync(tempPath, path)
    }
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath)
  }
}

export function hashSessionMessageRange(messages: ChatMessage[], fromMessageId: string, untilMessageId: string): string | null {
  return hashChatMessageRange(messages, fromMessageId, untilMessageId)
}

export function isContextCheckpointValid(session: StoredSession, policyVersion?: string): boolean {
  const checkpoint = session.contextCheckpoint
  if (!checkpoint || (policyVersion && checkpoint.policyVersion !== policyVersion)) return false
  return hashSessionMessageRange(session.messages, checkpoint.sourceFromMessageId, checkpoint.sourceUntilMessageId) === checkpoint.sourceHash
}

export function setContextCheckpoint(
  sessionId: string,
  checkpoint: SessionContextCheckpoint | null,
  expectedMessagesHash?: string
): boolean {
  if (checkpoint !== null && !isValidContextCheckpoint(checkpoint)) return false
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return false
    if (expectedMessagesHash !== undefined && hashChatMessages(session.messages) !== expectedMessagesHash) return false
    if (checkpoint === null) delete session.contextCheckpoint
    else {
      const sourceHash = hashSessionMessageRange(session.messages, checkpoint.sourceFromMessageId, checkpoint.sourceUntilMessageId)
      if (sourceHash !== checkpoint.sourceHash) return false
      session.contextCheckpoint = checkpoint
    }
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return true
  })
}

export function getValidContextCheckpoint(sessionId: string, policyVersion?: string): SessionContextCheckpoint | null {
  const session = readSessionWithBackup(sessionId)
  return session && isContextCheckpointValid(session, policyVersion) ? session.contextCheckpoint ?? null : null
}

function messageTools(message: ChatMessage): ToolCallInfo[] {
  if (message.segments?.length) return message.segments.flatMap((segment) => segment.type === 'tools' ? segment.tools : [])
  return message.toolCalls ?? []
}

function contextIdFor(reference: Omit<ContextReference, 'contextId'>): string {
  return `ctx_${createHash('sha256').update([
    reference.sessionId,
    reference.messageId,
    reference.toolCallId ?? '',
    reference.sourceType,
    reference.contentHash
  ].join('\u0000')).digest('hex').slice(0, 32)}`
}

export function createToolResultReference(sessionId: string, toolCallId: string, projectedTokens: number): ContextReference | null {
  const found = findToolResult(sessionId, toolCallId)
  if (!found) return null
  const reference = {
    sessionId,
    messageId: found.messageId,
    toolCallId,
    sourceType: 'tool-result' as const,
    sourceName: found.toolName,
    contentHash: createHash('sha256').update(found.output).digest('hex'),
    originalTokens: Math.ceil(found.output.length / 4),
    projectedTokens: Math.max(0, projectedTokens),
    createdAt: Date.now()
  }
  return { ...reference, contextId: contextIdFor(reference) }
}

export function findToolResult(sessionId: string, toolCallId: string): { messageId: string; toolName: string; output: string } | null {
  const session = readSessionWithBackup(sessionId)
  if (!session) return null
  for (const message of session.messages) {
    const tool = messageTools(message).find((candidate) => candidate.toolCallId === toolCallId)
    if (tool?.output !== undefined) return { messageId: message.id, toolName: tool.toolName, output: tool.output }
  }
  return null
}

export function retrieveContextReference(options: {
  sessionId: string
  contextId?: string
  toolCallId?: string
  contentHash?: string
  query?: string
  lineStart?: number
  lineEnd?: number
  maxChars?: number
}): { reference: ContextReference; content: string; totalLines: number; returnedLines: [number, number] } | null {
  if (!options.contextId && !options.toolCallId) return null
  const session = readSessionWithBackup(options.sessionId)
  if (!session) return null
  for (const message of session.messages) {
    for (const tool of messageTools(message)) {
      if (tool.output === undefined || !tool.toolCallId) continue
      const contentHash = createHash('sha256').update(tool.output).digest('hex')
      const base = {
        sessionId: options.sessionId,
        messageId: message.id,
        toolCallId: tool.toolCallId,
        sourceType: 'tool-result' as const,
        sourceName: tool.toolName,
        contentHash,
        originalTokens: Math.ceil(tool.output.length / 4),
        projectedTokens: 0,
        createdAt: message.createdAt
      }
      const contextId = contextIdFor(base)
      if (options.toolCallId && tool.toolCallId !== options.toolCallId) continue
      if (options.contextId && contextId !== options.contextId) continue
      if (options.contentHash && contentHash !== options.contentHash) return null

      const lines = tool.output.split(/\r?\n/)
      const query = options.query?.trim().toLocaleLowerCase()
      const matching = query ? lines.map((line, index) => line.toLocaleLowerCase().includes(query) ? index : -1).filter((index) => index >= 0) : []
      const requestedStart = Math.max(1, options.lineStart ?? (matching[0] === undefined ? 1 : matching[0] + 1))
      const defaultEnd = options.lineStart === undefined && matching[0] !== undefined ? requestedStart + 40 : lines.length
      const requestedEnd = Math.max(requestedStart, Math.min(lines.length, options.lineEnd ?? defaultEnd))
      const maxChars = Math.min(64_000, Math.max(256, options.maxChars ?? 16_000))
      let content = lines.slice(requestedStart - 1, requestedEnd).join('\n')
      if (content.length > maxChars) content = `${content.slice(0, maxChars)}\n[ContextRetrieve output limited]`
      return {
        reference: { ...base, contextId },
        content,
        totalLines: lines.length,
        returnedLines: [requestedStart, requestedEnd]
      }
    }
  }
  return null
}

export function createSession(title = 'New conversation'): SessionMeta {
  ensureDataDir()
  const now = Date.now()
  const session: StoredSession = {
    id: crypto.randomUUID(),
    title: title.slice(0, 1000),
    createdAt: now,
    updatedAt: now,
    messages: [],
    pendingUserMessages: [],
    messageQueueRevision: 0,
    runActivity: initialRunActivity()
  }
  withSessionLock(session.id, () => writeSessionUnlocked(session))
  return { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }
}

export function getSession(id: string): StoredSession | null {
  return readSessionWithBackup(id)
}

export function getSessionRunActivity(sessionId: string): SessionRunActivityRecord | null {
  const session = readSessionWithBackup(sessionId)
  return session ? structuredClone(session.runActivity) : null
}

export function startSessionRunActivity(sessionId: string, runId: string, kind: 'chat' | 'goal', startedAt = Date.now()): SessionRunActivityRecord | null {
  if (!runId) return null
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return null
    session.runActivity = {
      state: 'running',
      runId,
      kind,
      startedAt,
      terminalRevision: session.runActivity.terminalRevision,
      seenTerminalRevision: session.runActivity.seenTerminalRevision
    }
    writeSessionUnlocked(session)
    return structuredClone(session.runActivity)
  })
}

export function finishSessionRunActivity(
  sessionId: string,
  runId: string,
  state: Extract<SessionRunActivityRecord['state'], 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'needs-user-action'>,
  error?: string,
  finishedAt = Date.now()
): SessionRunActivityRecord | null {
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session || session.runActivity.state !== 'running' || session.runActivity.runId !== runId) return null
    session.runActivity = {
      ...session.runActivity,
      state,
      finishedAt,
      terminalRevision: session.runActivity.terminalRevision + 1
    }
    if (error) session.runActivity.error = error
    else delete session.runActivity.error
    writeSessionUnlocked(session)
    return structuredClone(session.runActivity)
  })
}

export function markSessionRunActivitySeen(sessionId: string, observedTerminalRevision: number): SessionRunActivityRecord | null {
  if (!Number.isSafeInteger(observedTerminalRevision) || observedTerminalRevision < 0) return null
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return null
    const seen = Math.min(session.runActivity.terminalRevision, observedTerminalRevision)
    if (seen > session.runActivity.seenTerminalRevision) {
      session.runActivity.seenTerminalRevision = seen
      writeSessionUnlocked(session)
    }
    return structuredClone(session.runActivity)
  })
}

function clonePendingUserMessage(pending: PendingUserMessage): PendingUserMessage {
  return structuredClone(pending)
}

function pendingResult(pending: PendingUserMessage, messageQueueRevision: number, changed = true): PendingUserMessageResult {
  return { success: true, changed, pendingMessage: clonePendingUserMessage(pending), messageQueueRevision }
}

function invalidPendingInput(): PendingUserMessageResult {
  return { success: false, error: 'invalid-input' }
}

function normalizePendingEnqueueInput(value: unknown): PendingUserMessageEnqueueInput | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PendingUserMessageEnqueueInput>
  if ((candidate.mode !== 'queue' && candidate.mode !== 'steer') || !isValidMessage(candidate.message) || candidate.message.role !== 'user') return null
  if (candidate.mode === 'steer') {
    if (typeof candidate.targetRunId !== 'string' || !candidate.targetRunId) return null
  } else if (candidate.targetRunId !== undefined) return null
  return { mode: candidate.mode, message: candidate.message, ...(candidate.targetRunId ? { targetRunId: candidate.targetRunId } : {}) }
}

export function listPendingUserMessages(sessionId: string): PendingUserMessageListResult {
  const session = readSessionWithBackup(sessionId)
  if (!session) return { success: false, pending: [], messageQueueRevision: 0, error: 'invalid-session' }
  return {
    success: true,
    pending: session.pendingUserMessages
      .filter((pending) => pending.status === 'queued')
      .sort((left, right) => left.sequence - right.sequence)
      .map(clonePendingUserMessage),
    messageQueueRevision: session.messageQueueRevision
  }
}

export function enqueuePendingUserMessage(sessionId: string, value: unknown): PendingUserMessageResult {
  const input = normalizePendingEnqueueInput(value)
  if (!input) return invalidPendingInput()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const existing = session.pendingUserMessages.find((pending) => pending.message.id === input.message.id)
    if (existing) {
      const identical = existing.mode === input.mode && existing.targetRunId === input.targetRunId && exactMessageMatch(existing.message, input.message)
      return identical ? pendingResult(existing, session.messageQueueRevision, false) : { success: false, error: 'conflict' }
    }
    if (session.messages.some((message) => message.id === input.message.id)) return { success: false, error: 'conflict' }
    const now = Date.now()
    const pending: PendingUserMessage = {
      mode: input.mode,
      status: 'queued',
      message: input.message,
      sequence: Math.max(
        session.messageQueueRevision,
        session.pendingUserMessages.reduce((maximum, item) => Math.max(maximum, item.sequence), 0)
      ) + 1,
      ...(input.targetRunId ? { targetRunId: input.targetRunId } : {}),
      createdAt: now
    }
    session.pendingUserMessages.push(pending)
    session.messageQueueRevision += 1
    session.updatedAt = now
    writeSessionUnlocked(session)
    return pendingResult(pending, session.messageQueueRevision)
  })
}

export function cancelPendingUserMessage(sessionId: string, pendingMessageId: string): PendingUserMessageResult {
  if (typeof pendingMessageId !== 'string' || !pendingMessageId) return invalidPendingInput()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const index = session.pendingUserMessages.findIndex((pending) => pending.message.id === pendingMessageId)
    if (index < 0) return { success: false, error: 'not-found' }
    const pending = session.pendingUserMessages[index]
    if (pending.status !== 'queued') return { success: false, error: 'not-queued' }
    session.pendingUserMessages.splice(index, 1)
    session.messageQueueRevision += 1
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return pendingResult(pending, session.messageQueueRevision)
  })
}

export function steerPendingUserMessage(sessionId: string, pendingMessageId: string, targetRunId: string): PendingUserMessageResult {
  if (typeof pendingMessageId !== 'string' || !pendingMessageId || typeof targetRunId !== 'string' || !targetRunId) return invalidPendingInput()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const pending = session.pendingUserMessages.find((item) => item.message.id === pendingMessageId)
    if (!pending) return { success: false, error: 'not-found' }
    if (pending.status !== 'queued') return { success: false, error: 'not-queued' }
    if (pending.mode === 'steer') {
      return pending.targetRunId === targetRunId
        ? pendingResult(pending, session.messageQueueRevision, false)
        : { success: false, error: 'conflict' }
    }
    pending.mode = 'steer'
    pending.targetRunId = targetRunId
    session.messageQueueRevision += 1
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return pendingResult(pending, session.messageQueueRevision)
  })
}

export function downgradePendingSteer(sessionId: string, pendingMessageId: string): PendingUserMessageResult {
  if (typeof pendingMessageId !== 'string' || !pendingMessageId) return invalidPendingInput()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const pending = session.pendingUserMessages.find((item) => item.message.id === pendingMessageId)
    if (!pending) return { success: false, error: 'not-found' }
    if (pending.status !== 'queued') return { success: false, error: 'not-queued' }
    if (pending.mode === 'queue') return pendingResult(pending, session.messageQueueRevision, false)
    pending.mode = 'queue'
    delete pending.targetRunId
    session.messageQueueRevision += 1
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return pendingResult(pending, session.messageQueueRevision)
  })
}

function claimPendingUserMessageUnlocked(session: StoredSession, pending: PendingUserMessage, runId: string): PendingUserMessageResult {
  if (pending.status === 'claimed') {
    return pending.claimedByRunId === runId
      ? pendingResult(pending, session.messageQueueRevision, false)
      : { success: false, error: 'not-queued' }
  }
  if (pending.mode === 'queue') {
    const nextQueued = session.pendingUserMessages
      .filter((item) => item.status === 'queued' && item.mode === 'queue')
      .sort((left, right) => left.sequence - right.sequence)[0]
    if (nextQueued?.message.id !== pending.message.id) return { success: false, error: 'invalid-order' }
  }
  if (pending.mode === 'steer' && pending.targetRunId !== runId) return { success: false, error: 'conflict' }
  const existingMessage = session.messages.find((message) => message.id === pending.message.id)
  if (existingMessage) return { success: false, error: 'conflict' }
  const now = Date.now()
  session.messages.push(pending.message)
  pending.status = 'claimed'
  pending.claimedByRunId = runId
  pending.claimedAt = now
  session.messageQueueRevision += 1
  session.updatedAt = now
  if (session.title === 'New conversation') {
    const text = getMessageText(pending.message)
    session.title = text ? text.slice(0, 50).replace(/\n/g, ' ') : 'Image message'
  }
  writeSessionUnlocked(session)
  return pendingResult(pending, session.messageQueueRevision)
}

export function claimPendingUserMessage(sessionId: string, pendingMessageId: string, runId: string): PendingUserMessageResult {
  if (typeof pendingMessageId !== 'string' || !pendingMessageId || typeof runId !== 'string' || !runId) return invalidPendingInput()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const pending = session.pendingUserMessages.find((item) => item.message.id === pendingMessageId)
    if (!pending) return { success: false, error: 'not-found' }
    return claimPendingUserMessageUnlocked(session, pending, runId)
  })
}

export function claimNextPendingUserMessage(sessionId: string, runId: string): PendingUserMessageResult {
  if (typeof runId !== 'string' || !runId) return invalidPendingInput()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const pending = session.pendingUserMessages
      .filter((item) => item.status === 'queued' && item.mode === 'queue')
      .sort((left, right) => left.sequence - right.sequence)[0]
    if (!pending) return { success: false, error: 'not-found' }
    return claimPendingUserMessageUnlocked(session, pending, runId)
  })
}

export function completePendingUserMessage(sessionId: string, pendingMessageId: string, runId: string): PendingUserMessageResult {
  if (typeof pendingMessageId !== 'string' || !pendingMessageId || typeof runId !== 'string' || !runId) return invalidPendingInput()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const index = session.pendingUserMessages.findIndex((item) => item.message.id === pendingMessageId)
    if (index < 0) return { success: false, error: 'not-found' }
    const pending = session.pendingUserMessages[index]
    if (pending.status !== 'claimed') return { success: false, error: 'not-queued' }
    if (pending.claimedByRunId !== runId) return { success: false, error: 'conflict' }
    session.pendingUserMessages.splice(index, 1)
    session.messageQueueRevision += 1
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return pendingResult(pending, session.messageQueueRevision)
  })
}

export function restorePendingUserMessageClaim(sessionId: string, pendingMessageId: string, runId: string): PendingUserMessageResult {
  if (typeof pendingMessageId !== 'string' || !pendingMessageId || typeof runId !== 'string' || !runId) return invalidPendingInput()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const pending = session.pendingUserMessages.find((item) => item.message.id === pendingMessageId)
    if (!pending) return { success: false, error: 'not-found' }
    if (pending.status !== 'claimed' || pending.claimedByRunId !== runId) return { success: false, error: 'not-queued' }
    const messageIndex = session.messages.findIndex((message) => message.id === pending.message.id)
    if (messageIndex < 0 || !exactMessageMatch(session.messages[messageIndex], pending.message)) return { success: false, error: 'conflict' }
    if (messageIndex !== session.messages.length - 1) return { success: false, error: 'invalid-order' }
    session.messages.splice(messageIndex, 1)
    pending.status = 'queued'
    delete pending.claimedByRunId
    delete pending.claimedAt
    session.messageQueueRevision += 1
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return pendingResult(pending, session.messageQueueRevision)
  })
}

export function listSessions(): SessionMeta[] {
  ensureDataDir()
  const files = readdirSync(getDataDir())
  const ids = new Set(
    files
      .filter((file) => file.endsWith('.json') || file.endsWith('.json.bak'))
      .map((file) => file.endsWith('.json.bak') ? file.slice(0, -'.json.bak'.length) : file.slice(0, -'.json'.length))
      .filter(isValidSessionId)
  )
  const sessions: SessionMeta[] = []
  for (const id of ids) {
    const data = readSessionWithBackup(id)
    if (!data) continue
    sessions.push({
      id: data.id,
      title: data.title,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      ...(isValidGoalState(data.goal) ? { goal: data.goal } : {}),
      ...(typeof data.projectId === 'string' ? { projectId: data.projectId } : {})
    })
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function appendMessage(sessionId: string, message: ChatMessage): boolean {
  if (!isValidMessage(message)) return false
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return false

    session.messages.push(message)
    session.updatedAt = Date.now()
    if (session.title === 'New conversation') {
      const firstUser = session.messages.find((m) => m.role === 'user')
      if (firstUser) {
        const text = getMessageText(firstUser)
        session.title = text ? text.slice(0, 50).replace(/\n/g, ' ') : 'Image message'
      }
    }

    writeSessionUnlocked(session)
    return true
  })
}

/** Merge final run usage (including timing) into the last assistant message. */
export function mergeFinalUsageIntoLastAssistant(sessionId: string, usage: StreamUsage): boolean {
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return false
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index]
      if (message.role !== 'assistant') continue
      const merged: StreamUsage = { ...message.usage, ...usage }
      const durationKnown = merged.firstTokenMs !== undefined || merged.generationMs !== undefined
      if (!message.usage && !durationKnown) return false
      session.messages[index] = { ...message, usage: merged }
      session.updatedAt = Date.now()
      writeSessionUnlocked(session)
      return true
    }
    return false
  })
}

export function replaceMessages(sessionId: string, messages: ChatMessage[]): boolean {
  if (!messages.every(isValidMessage)) return false
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return false
    session.messages = messages
    delete session.contextCheckpoint
    session.updatedAt = Date.now()
    if (session.title === 'New conversation') {
      const firstUser = session.messages.find((message) => message.role === 'user')
      if (firstUser) {
        const text = getMessageText(firstUser)
        session.title = text ? text.slice(0, 50).replace(/\n/g, ' ') : 'Image message'
      }
    }
    writeSessionUnlocked(session)
    return true
  })
}

function cloneGoal(goal: GoalState): GoalState {
  return structuredClone(goal)
}

function transitionResult(goal: GoalState, changed = true): GoalTransitionResult {
  return { success: true, changed, goal: cloneGoal(goal) }
}

function invalidGoalResult(): GoalTransitionResult {
  return { success: false, error: 'invalid-goal' }
}

function exactMessageMatch(left: ChatMessage, right: ChatMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function usageTotal(usage: StreamUsage): number {
  return Math.max(usage.totalTokens ?? 0, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
}

function goalTokenLimitReached(goal: GoalState): boolean {
  return goal.tokenLimit !== undefined && usageTotal(goal.cumulativeUsage) >= goal.tokenLimit
}

export function inspectGoal(sessionId: string): GoalTransitionResult {
  const session = readSessionWithBackup(sessionId)
  if (!session) return { success: false, error: 'invalid-session' }
  if (!session.goal) return { success: false, error: 'no-goal' }
  return transitionResult(session.goal, false)
}

export function createOrReplaceGoal(sessionId: string, value: unknown): GoalTransitionResult {
  const input = normalizeGoalCreateInput(value)
  if (!input) return invalidGoalResult()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const now = Date.now()
    session.goal = createGoalState(input, Math.max(session.goalGeneration ?? 0, session.goal?.generation ?? 0) + 1, now)
    session.goalGeneration = session.goal.generation
    session.updatedAt = now
    writeSessionUnlocked(session)
    return transitionResult(session.goal)
  })
}

export function claimGoalPhase(sessionId: string, value: unknown): GoalTransitionResult {
  if (!value || typeof value !== 'object') return invalidGoalResult()
  const candidate = value as Partial<GoalClaimInput>
  const phase = candidate.phase
  const invocationId = candidate.invocationId
  if (!isValidGoalCas(candidate) || (phase !== 'execution' && phase !== 'validation') || !isValidGoalIdentifier(invocationId)) return invalidGoalResult()
  const input = { ...candidate, phase, invocationId } as GoalClaimInput
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const goal = session.goal
    if (!goal) return { success: false, error: 'no-goal' }
    if (!goalCasMatches(goal, input as GoalClaimInput)) return { success: false, error: 'stale-goal' }
    if (phase === 'execution' ? goal.status !== 'queued' : goal.status !== 'validating' || goal.currentInvocationIds.validation !== undefined) {
      return { success: false, error: 'invalid-transition' }
    }
    if (phase === 'execution' && goalTokenLimitReached(goal)) {
      return { success: false, error: 'invalid-transition' }
    }
    const now = Date.now()
    goal.revision += 1
    goal.status = phase === 'execution' ? 'executing' : 'validating'
    goal.currentInvocationIds = phase === 'execution'
      ? { execution: invocationId }
      : { validation: invocationId }
    goal.startedAt ??= now
    goal.updatedAt = now
    goal.history = boundedHistory(goal.history, {
      phase,
      status: goal.status,
      round: goal.currentRound,
      revision: goal.revision,
      createdAt: now,
      invocationId
    })
    session.updatedAt = now
    writeSessionUnlocked(session)
    return { ...transitionResult(goal), invocationId }
  })
}

export function commitGoalExecution(sessionId: string, value: unknown): GoalTransitionResult {
  if (!value || typeof value !== 'object') return invalidGoalResult()
  const candidate = value as Partial<GoalExecutionCommitInput>
  const invocationId = candidate.invocationId
  const usageOperationId = candidate.usageOperationId
  const message = candidate.message
  const suppliedUsage = candidate.usage
  const goalCas = normalizeGoalCas(candidate)
  if (!goalCas || !isValidGoalIdentifier(invocationId) || !isValidGoalIdentifier(usageOperationId)) return invalidGoalResult()
  if (!message || !isValidMessage(message) || message.role !== 'assistant') return { success: false, error: 'invalid-message' }
  const usage = suppliedUsage ?? message.usage ?? {}
  if (!isValidStreamUsage(usage)) return { success: false, error: 'invalid-usage' }
  const input = { ...candidate, invocationId, usageOperationId, message, usage } as GoalExecutionCommitInput
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const goal = session.goal
    if (!goal) return { success: false, error: 'no-goal' }
    if (goal.id !== input.goalId || goal.generation !== input.generation) return { success: false, error: 'stale-goal' }
    const priorOperation = goal.appliedUsageOperations.find((operation) => operation.id === usageOperationId)
    if (priorOperation) {
      const storedMessage = session.messages.find((candidate) => candidate.id === message.id)
      const identical = priorOperation.invocationId === invocationId &&
        (priorOperation.phase === undefined || priorOperation.phase === 'execution') &&
        priorOperation.messageId === message.id && sameGoalUsage(priorOperation.usage, usage) &&
        Boolean(storedMessage && exactMessageMatch(storedMessage, message))
      return identical ? transitionResult(goal, false) : { success: false, error: 'conflict' }
    }
    if (!goalCasMatches(goal, input as GoalExecutionCommitInput)) return { success: false, error: 'stale-goal' }
    if (goal.status !== 'executing' || goal.currentInvocationIds.execution !== invocationId) return { success: false, error: 'invalid-transition' }
    const existingMessage = session.messages.find((candidate) => candidate.id === message.id)
    if (existingMessage) return { success: false, error: 'conflict' }
    const now = Date.now()
    session.messages.push(message)
    goal.cumulativeUsage = addGoalUsage(goal.cumulativeUsage, usage)
    goal.appliedUsageOperations = [...goal.appliedUsageOperations, {
      id: usageOperationId,
      invocationId,
      phase: 'execution' as const,
      messageId: message.id,
      usage,
      appliedAt: now
    }].slice(-MAX_GOAL_USAGE_OPERATIONS)
    goal.revision += 1
    const tokenLimitReached = goalTokenLimitReached(goal)
    goal.status = tokenLimitReached ? 'blocked' : 'validating'
    goal.currentInvocationIds = {}
    delete goal.resumePhase
    goal.updatedAt = now
    if (tokenLimitReached) goal.stopReason = 'token-limit'
    else delete goal.stopReason
    goal.history = boundedHistory(goal.history, {
      phase: 'execution',
      status: goal.status,
      round: goal.currentRound,
      revision: goal.revision,
      createdAt: now,
      invocationId,
      messageId: message.id,
      usageOperationId,
      usage
    })
    session.updatedAt = now
    writeSessionUnlocked(session)
    return transitionResult(goal)
  })
}

export function commitGoalEvaluation(sessionId: string, value: unknown): GoalTransitionResult {
  if (!value || typeof value !== 'object') return invalidGoalResult()
  const candidate = value as Partial<GoalEvaluationCommitInput>
  const invocationId = candidate.invocationId
  const usageOperationId = candidate.usageOperationId ?? `evaluation:${invocationId ?? ''}`
  const suppliedUsage = candidate.usage
  const outcome = candidate.outcome
  const evaluation = candidate.evaluation
  const feedback = candidate.feedback
  const requestedStopReason = candidate.stopReason
  const goalCas = normalizeGoalCas(candidate)
  if (!goalCas || !isValidGoalIdentifier(invocationId) || !isValidGoalIdentifier(usageOperationId) || (outcome !== 'complete' && outcome !== 'continue' && outcome !== 'blocked')) return invalidGoalResult()
  if (!isValidGoalText(evaluation, MAX_GOAL_EVALUATION_LENGTH)) return invalidGoalResult()
  if (feedback !== undefined && !isValidGoalText(feedback, MAX_GOAL_FEEDBACK_LENGTH)) return invalidGoalResult()
  if (requestedStopReason !== undefined && !['completed', 'evaluator-blocked', 'max-rounds', 'token-limit'].includes(requestedStopReason)) return invalidGoalResult()
  const usage = suppliedUsage ?? {}
  if (!isValidStreamUsage(usage)) return { success: false, error: 'invalid-usage' }
  const input = {
    ...candidate,
    invocationId,
    usageOperationId,
    usage,
    outcome,
    evaluation,
    ...(feedback === undefined ? {} : { feedback }),
    ...(requestedStopReason === undefined ? {} : { stopReason: requestedStopReason })
  } as GoalEvaluationCommitInput & { usageOperationId: string; usage: StreamUsage }
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const goal = session.goal
    if (!goal) return { success: false, error: 'no-goal' }
    if (goal.id !== input.goalId || goal.generation !== input.generation) return { success: false, error: 'stale-goal' }
    const priorOperation = goal.appliedUsageOperations.find((operation) => operation.id === input.usageOperationId)
    if (priorOperation) {
      const identical = priorOperation.invocationId === input.invocationId &&
        priorOperation.phase === 'validation' && priorOperation.messageId === undefined &&
        sameGoalUsage(priorOperation.usage, input.usage)
      if (!identical) return { success: false, error: 'conflict' }
      return { success: false, error: 'invalid-transition' }
    }
    if (!goalCasMatches(goal, input as GoalEvaluationCommitInput)) return { success: false, error: 'stale-goal' }
    if (goal.status !== 'validating' || goal.currentInvocationIds.validation !== input.invocationId) return { success: false, error: 'invalid-transition' }
    const now = Date.now()
    goal.cumulativeUsage = addGoalUsage(goal.cumulativeUsage, input.usage)
    goal.appliedUsageOperations = [...goal.appliedUsageOperations, {
      id: input.usageOperationId,
      invocationId: input.invocationId,
      phase: 'validation' as const,
      usage: input.usage,
      appliedAt: now
    }].slice(-MAX_GOAL_USAGE_OPERATIONS)
    let status: GoalState['status']
    let stopReason: GoalState['stopReason']
    let currentRound = goal.currentRound
    if (input.outcome === 'complete') {
      status = 'completed'
      stopReason = 'completed'
      goal.completedAt = now
    } else if (input.outcome === 'blocked') {
      status = 'blocked'
      stopReason = input.stopReason && input.stopReason !== 'completed' ? input.stopReason : 'evaluator-blocked'
    } else if (goal.currentRound >= goal.maxRounds) {
      status = 'blocked'
      stopReason = 'max-rounds'
    } else if (goalTokenLimitReached(goal)) {
      status = 'blocked'
      stopReason = 'token-limit'
    } else {
      status = 'queued'
      currentRound += 1
      stopReason = undefined
    }
    goal.revision += 1
    goal.status = status
    goal.currentRound = currentRound
    goal.currentInvocationIds = {}
    delete goal.resumePhase
    goal.updatedAt = now
    goal.evaluation = input.evaluation
    if (input.feedback !== undefined) goal.feedback = input.feedback
    else delete goal.feedback
    if (stopReason) goal.stopReason = stopReason
    else delete goal.stopReason
    goal.history = boundedHistory(goal.history, {
      phase: 'validation',
      status,
      round: input.outcome === 'continue' && status === 'queued' ? currentRound - 1 : currentRound,
      revision: goal.revision,
      createdAt: now,
      invocationId: input.invocationId,
      usageOperationId: input.usageOperationId,
      usage: input.usage,
      evaluation: input.evaluation,
      ...(input.feedback ? { feedback: input.feedback } : {}),
      ...(stopReason ? { stopReason } : {})
    })
    session.updatedAt = now
    writeSessionUnlocked(session)
    return transitionResult(goal)
  })
}

export function pauseGoal(sessionId: string, value: unknown): GoalTransitionResult {
  if (!value || typeof value !== 'object') return invalidGoalResult()
  const candidate = value as Partial<GoalPauseInput>
  const stopReason = candidate.stopReason
  const feedback = candidate.feedback
  const goalCas = normalizeGoalCas(candidate)
  if (!goalCas) return invalidGoalResult()
  if (stopReason !== undefined && !['user-paused', 'execution-error', 'evaluation-error'].includes(stopReason)) return invalidGoalResult()
  if (feedback !== undefined && !isValidGoalText(feedback, MAX_GOAL_FEEDBACK_LENGTH)) return invalidGoalResult()
  const input = {
    ...candidate,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(feedback === undefined ? {} : { feedback })
  } as GoalPauseInput
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const goal = session.goal
    if (!goal) return { success: false, error: 'no-goal' }
    if (!goalCasMatches(goal, input as GoalPauseInput)) return { success: false, error: 'stale-goal' }
    if (goal.status === 'completed') return { success: false, error: 'invalid-transition' }
    const now = Date.now()
    const resumePhase = goal.status === 'validating' ? 'validation' : goal.status === 'executing' ? 'execution' : goal.resumePhase
    goal.revision += 1
    goal.status = 'paused'
    goal.currentInvocationIds = {}
    goal.updatedAt = now
    goal.pausedAt = now
    goal.stopReason = input.stopReason ?? 'user-paused'
    if (resumePhase) goal.resumePhase = resumePhase
    else delete goal.resumePhase
    if (input.feedback !== undefined) goal.feedback = input.feedback
    goal.history = boundedHistory(goal.history, {
      phase: 'system',
      status: 'paused',
      round: goal.currentRound,
      revision: goal.revision,
      createdAt: now,
      ...(input.feedback ? { feedback: input.feedback } : {}),
      stopReason: goal.stopReason
    })
    session.updatedAt = now
    writeSessionUnlocked(session)
    return transitionResult(goal)
  })
}

export function resumeGoal(sessionId: string, value: unknown): GoalTransitionResult {
  if (!value || typeof value !== 'object') return invalidGoalResult()
  const input = value as Partial<GoalCas>
  if (!isValidGoalCas(input)) return invalidGoalResult()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    const goal = session.goal
    if (!goal) return { success: false, error: 'no-goal' }
    if (!goalCasMatches(goal, input as GoalCas)) return { success: false, error: 'stale-goal' }
    if (!['paused', 'blocked', 'interrupted'].includes(goal.status)) return { success: false, error: 'invalid-transition' }
    if (goal.status === 'blocked' && (goal.stopReason === 'max-rounds' || goal.stopReason === 'token-limit')) return { success: false, error: 'invalid-transition' }
    const resumePhase = goal.resumePhase
    const now = Date.now()
    goal.revision += 1
    goal.status = resumePhase === 'validation' ? 'validating' : 'queued'
    goal.currentInvocationIds = {}
    goal.updatedAt = now
    delete goal.pausedAt
    delete goal.stopReason
    delete goal.resumePhase
    goal.history = boundedHistory(goal.history, {
      phase: 'system',
      status: goal.status,
      round: goal.currentRound,
      revision: goal.revision,
      createdAt: now
    })
    session.updatedAt = now
    writeSessionUnlocked(session)
    return transitionResult(goal)
  })
}

export function clearGoal(sessionId: string, value?: unknown): GoalTransitionResult {
  if (value !== undefined && !isValidGoalCas(value)) return invalidGoalResult()
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    if (!session.goal) return { success: true, changed: false }
    if (value !== undefined && !goalCasMatches(session.goal, value as GoalCas)) return { success: false, error: 'stale-goal' }
    session.goalGeneration = Math.max(session.goalGeneration ?? 0, session.goal.generation)
    delete session.goal
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return { success: true, changed: true }
  })
}

export function normalizeGoalRecovery(sessionId: string): GoalTransitionResult {
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    if (!session.goal) return { success: false, error: 'no-goal' }
    const recovered = normalizeRecoveredGoal(session.goal, Date.now())
    if (recovered === session.goal) return transitionResult(session.goal, false)
    session.goal = recovered
    session.updatedAt = recovered.updatedAt
    writeSessionUnlocked(session)
    return transitionResult(recovered)
  })
}

export function setSessionGoal(sessionId: string, value: unknown): SessionGoalResult {
  if (typeof value !== 'string') return { success: false, error: 'invalid-goal' }
  const objective = value.trim()
  if (!objective) {
    const result = clearGoal(sessionId)
    return result.success ? { success: true } : { success: false, error: result.error === 'invalid-session' ? 'invalid-session' : 'invalid-goal' }
  }
  const result = createOrReplaceGoal(sessionId, objective)
  if (!result.success || !result.goal) {
    return { success: false, error: result.error === 'invalid-session' ? 'invalid-session' : 'invalid-goal' }
  }
  return { success: true, goal: result.goal.objective }
}

export function setSessionProject(sessionId: string, projectId: string | null): boolean {
  return withSessionLock(sessionId, () => {
    const session = readSessionWithBackupUnlocked(sessionId)
    if (!session) return false
    if (projectId !== null && (!/^[A-Za-z0-9_-]{8,100}$/.test(projectId) || !resolveProjectPath(projectId))) return false

    if (projectId === null) delete session.projectId
    else session.projectId = projectId
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return true
  })
}

export function deleteSession(id: string): boolean {
  return withSessionLock(id, () => {
    const path = getSessionPath(id)
    if (!existsSync(path) && !existsSync(`${path}.bak`)) return false
    if (existsSync(path)) unlinkSync(path)
    if (existsSync(`${path}.bak`)) unlinkSync(`${path}.bak`)
    cleanupGeneratedImages(id)
    cleanupSessionOperations(id)
    return true
  })
}

export function renameSession(id: string, title: string): boolean {
  return withSessionLock(id, () => {
    const session = readSessionWithBackupUnlocked(id)
    if (!session) return false
    session.title = title.slice(0, 1000)
    session.updatedAt = Date.now()
    writeSessionUnlocked(session)
    return true
  })
}
