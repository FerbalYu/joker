import { createHash, randomBytes, randomUUID } from 'node:crypto'
import * as electron from 'electron'
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, unlinkSync , writeSync } from 'node:fs'
import { join } from 'node:path'
import { getJokerHomeDir } from './paths'
import { withFileLock } from './atomic-json'
import type { ChatMessage, ToolCallInfo, ToolCallStatus } from '@shared/types'

/**
 * Causal operation journal: a per-session sidecar JSONL
 * (`<sessionId>.operations.jsonl`) that records what happened BEFORE each
 * side effect is allowed to start. Session JSON snapshots keep serving fast UI
 * reads; this journal owns causal recovery and audit.
 *
 * The write is synchronous on purpose: an operation may only begin after its
 * intent line is durable, mirroring the claim/commit protocol the Goal domain
 * already uses.
 */

export type OperationEvent =
  | { type: 'request-prepared'; at: number; runId: string; step?: number }
  | { type: 'request-dispatched'; at: number; runId: string; step?: number }
  | { type: 'tool-proposed'; at: number; runId: string; toolCallId: string; toolName: string; inputFingerprint?: string; fingerprintVersion?: 2; workspaceFingerprint?: string; toolSourceFingerprint?: string; retrySemantics?: import('../tools/registry').RetrySemantics; executionMode?: import('../tools/registry').ToolExecutionMode }
  | { type: 'approval-asked'; at: number; runId: string; toolCallId: string }
  | { type: 'approval-decided'; at: number; runId: string; toolCallId: string; outcome: 'allow' | 'deny' }
  | { type: 'tool-started'; at: number; runId: string; toolCallId: string; toolName: string }
  | { type: 'tool-result'; at: number; runId: string; toolCallId: string; status: 'done' | 'denied' | 'error' | 'timed-out' | 'cancelled' }
  | { type: 'step-committed'; at: number; runId: string; step: number }
  | { type: 'run-terminal'; at: number; runId: string; status: string }
  | { type: 'recovery-resolved'; at: number; runId: string; recoveryId: string; expectedRevision?: number; revision?: number; resolution: ToolRecoveryResolution; note?: string }

export interface OperationJournal {
  append(event: OperationEvent): void
}

let operationsDirOverride: string | null = null

/** Test-only storage override; production callers use the default app directory. */
export function setOperationsDirForTests(dir: string | null): void {
  operationsDirOverride = dir
}

function getOperationsDir(): string {
  if (operationsDirOverride) return operationsDirOverride
  const home = typeof electron.app?.getPath === 'function' ? electron.app.getPath('home') : getJokerHomeDir()
  return join(home, '.joker', 'sessions')
}

export function operationsPath(sessionId: string): string {
  return join(getOperationsDir(), `${sessionId}.operations.jsonl`)
}

export function appendOperation(sessionId: string, event: OperationEvent): void {
  const dir = getOperationsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(operationsPath(sessionId), `${JSON.stringify(event)}\n`, 'utf8')
}

export function readOperations(sessionId: string): OperationEvent[] {
  const path = operationsPath(sessionId)
  if (!existsSync(path)) return []
  const events: OperationEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as OperationEvent)
    } catch {
      // A torn tail line from a crash mid-write carries no causal meaning.
    }
  }
  return events
}

export interface OperationToolCallProjection {
  runId: string
  toolCall: ToolCallInfo
}

export interface ToolCallProjectionOptions {
  activeRunIds?: ReadonlySet<string>
  pendingApprovalToolCallIds?: ReadonlySet<string>
  assumeApprovalPending?: boolean
}

/**
 * Projects the causal journal into the renderer's ToolCallInfo state model.
 * The journal owns durable lifecycle facts; live approval activity decides
 * whether an approval request is still actually pending in this process.
 */
export function projectToolCallsFromOperations(
  events: readonly OperationEvent[],
  options: ToolCallProjectionOptions = {}
): OperationToolCallProjection[] {
  const activeRunIds = options.activeRunIds ?? new Set<string>()
  const pendingApprovalToolCallIds = options.pendingApprovalToolCallIds ?? new Set<string>()
  const assumeApprovalPending = options.assumeApprovalPending ?? true
  const calls = new Map<string, { runId: string; toolCall: ToolCallInfo }>()

  const ensure = (runId: string, toolCallId: string, toolName = ''): ToolCallInfo => {
    const key = `${runId}\0${toolCallId}`
    const existing = calls.get(key)
    if (existing) {
      if (toolName && !existing.toolCall.toolName) existing.toolCall.toolName = toolName
      return existing.toolCall
    }
    const toolCall: ToolCallInfo = { toolCallId, toolName, input: {}, status: 'proposed' }
    calls.set(key, { runId, toolCall })
    return toolCall
  }

  for (const event of events) {
    if (event.type === 'tool-proposed') {
      const toolCall = ensure(event.runId, event.toolCallId, event.toolName)
      toolCall.toolName = event.toolName
      toolCall.status = 'proposed'
      toolCall.proposedAt = event.at
      toolCall.updatedAt = event.at
    } else if (event.type === 'approval-asked') {
      const toolCall = ensure(event.runId, event.toolCallId)
      toolCall.approvalAskedAt = event.at
      toolCall.updatedAt = event.at
      if (assumeApprovalPending || pendingApprovalToolCallIds.has(event.toolCallId)) toolCall.status = 'awaiting-approval'
    } else if (event.type === 'approval-decided') {
      const toolCall = ensure(event.runId, event.toolCallId)
      toolCall.approvalDecidedAt = event.at
      toolCall.approvalOutcome = event.outcome
      toolCall.updatedAt = event.at
      toolCall.status = event.outcome === 'deny' ? 'denied' : 'proposed'
      if (event.outcome === 'deny') toolCall.completedAt = event.at
    } else if (event.type === 'tool-started') {
      const toolCall = ensure(event.runId, event.toolCallId, event.toolName)
      toolCall.toolName = event.toolName
      toolCall.status = 'running'
      toolCall.startedAt = event.at
      toolCall.updatedAt = event.at
      toolCall.lastProgressAt = event.at
    } else if (event.type === 'tool-result') {
      const toolCall = ensure(event.runId, event.toolCallId)
      toolCall.status = event.status
      toolCall.completedAt = event.at
      toolCall.updatedAt = event.at
      toolCall.lastProgressAt = event.at
      if (toolCall.startedAt !== undefined) toolCall.durationMs = Math.max(0, event.at - toolCall.startedAt)
    }
  }

  for (const { runId, toolCall } of calls.values()) {
    if (toolCall.status === 'running' && !activeRunIds.has(runId)) {
      toolCall.status = 'outcome-unknown'
      toolCall.error = 'TOOL_OUTCOME_UNKNOWN'
      toolCall.errorCode = 'TOOL_OUTCOME_UNKNOWN'
    }
    if (toolCall.status === 'awaiting-approval' && !pendingApprovalToolCallIds.has(toolCall.toolCallId ?? '') && !assumeApprovalPending) {
      toolCall.status = toolCall.approvalOutcome === 'deny' ? 'denied' : 'proposed'
    }
  }

  return [...calls.values()]
    .sort((left, right) => (left.toolCall.proposedAt ?? left.toolCall.updatedAt ?? 0) - (right.toolCall.proposedAt ?? right.toolCall.updatedAt ?? 0))
    .map(({ runId, toolCall }) => ({ runId, toolCall: { ...toolCall } }))
}

export function projectToolCallsIntoMessages(
  messages: readonly ChatMessage[],
  projections: readonly OperationToolCallProjection[]
): ChatMessage[] {
  if (projections.length === 0) return messages.map((message) => ({ ...message }))
  const byId = new Map(projections.flatMap((projection) => projection.toolCall.toolCallId ? [[projection.toolCall.toolCallId, projection]] : []))
  const used = new Set<string>()
  const mergeToolCall = (toolCall: ToolCallInfo): ToolCallInfo => {
    const toolCallId = toolCall.toolCallId
    const projection = toolCallId ? byId.get(toolCallId) : undefined
    if (!projection || !toolCallId) return toolCall
    used.add(toolCallId)
    return mergeToolCallProjection(toolCall, projection.toolCall)
  }
  const projectedMessages = messages.map((message) => {
    if (message.role !== 'assistant') return { ...message }
    const toolCalls = message.toolCalls?.map(mergeToolCall)
    const segments = message.segments?.map((segment) => segment.type === 'tools'
      ? { ...segment, tools: segment.tools.map(mergeToolCall) }
      : { ...segment })
    return {
      ...message,
      ...(toolCalls ? { toolCalls } : {}),
      ...(segments ? { segments } : {})
    }
  })

  const unmatched = projections.filter((projection) => {
    const toolCallId = projection.toolCall.toolCallId
    return toolCallId && !used.has(toolCallId)
  })
  const grouped = new Map<string, OperationToolCallProjection[]>()
  for (const projection of unmatched) {
    const group = grouped.get(projection.runId) ?? []
    group.push(projection)
    grouped.set(projection.runId, group)
  }
  for (const [runId, group] of grouped) {
    const tools = group.map((projection) => ({ ...projection.toolCall }))
    const createdAt = Math.min(...tools.map((toolCall) => toolCall.proposedAt ?? toolCall.updatedAt ?? Date.now()))
    projectedMessages.push({
      id: `operation-journal-${runId}`,
      role: 'assistant',
      content: '',
      toolCalls: tools,
      segments: [{ type: 'tools', tools }],
      createdAt
    })
  }
  return projectedMessages
}

function mergeToolCallProjection(current: ToolCallInfo, projection: ToolCallInfo): ToolCallInfo {
  const status = strongerToolCallStatus(current.status, projection.status)
  return {
    ...projection,
    ...current,
    status,
    input: Object.keys(current.input).length > 0 ? current.input : projection.input,
    ...(current.output !== undefined ? { output: current.output } : {}),
    ...(current.metadata !== undefined ? { metadata: current.metadata } : {}),
    proposedAt: projection.proposedAt ?? current.proposedAt,
    approvalAskedAt: projection.approvalAskedAt ?? current.approvalAskedAt,
    approvalDecidedAt: projection.approvalDecidedAt ?? current.approvalDecidedAt,
    approvalOutcome: projection.approvalOutcome ?? current.approvalOutcome,
    startedAt: projection.startedAt ?? current.startedAt,
    completedAt: projection.completedAt ?? current.completedAt,
    updatedAt: Math.max(current.updatedAt ?? 0, projection.updatedAt ?? 0) || undefined,
    lastProgressAt: Math.max(current.lastProgressAt ?? 0, projection.lastProgressAt ?? 0) || undefined,
    durationMs: Math.max(current.durationMs ?? 0, projection.durationMs ?? 0) || undefined,
    error: status === 'outcome-unknown' ? 'TOOL_OUTCOME_UNKNOWN' : current.error ?? projection.error,
    errorCode: status === 'outcome-unknown' ? 'TOOL_OUTCOME_UNKNOWN' : current.errorCode ?? projection.errorCode
  }
}

function strongerToolCallStatus(current: ToolCallStatus, projected: ToolCallStatus): ToolCallStatus {
  if (projected === 'outcome-unknown') return projected
  if (['done', 'error', 'denied', 'cancelled', 'timed-out'].includes(projected)) return projected
  if (['done', 'error', 'denied', 'cancelled', 'timed-out', 'outcome-unknown'].includes(current)) return current
  return projected
}

export interface ToolResultSpillRef {
  id: string
  bytes: number
  sha256: string
  preview: string
  truncated: true
}

export interface SpilledToolResultChunk { content: string; totalBytes: number; offsetBytes: number; contentBytes: number; nextOffsetBytes?: number; eof: boolean }

const TOOL_RESULT_SPILL_THRESHOLD = 128 * 1024
const TOOL_RESULT_PREVIEW_BYTES = 24_000
const MAX_TOOL_RESULT_BYTES = 64 * 1024 * 1024
const MAX_SESSION_SPILL_BYTES = 256 * 1024 * 1024
const MAX_SESSION_SPILL_FILES = 128
const MAX_READ_CHUNK_BYTES = 256 * 1024

function spillDir(sessionId: string): string { return join(getOperationsDir(), 'tool-results', sessionId) }
function spillPath(sessionId: string, id: string): string { return join(spillDir(sessionId), `${id}.txt`) }
function utf8Preview(output: string, budget: number): string {
  const encoded = Buffer.from(output, 'utf8')
  if (encoded.length <= budget) return output
  const half = Math.floor(budget / 2)
  return Buffer.concat([encoded.subarray(0, half), Buffer.from('\n…\n'), encoded.subarray(encoded.length - half)]).toString('utf8').replace(/�/g, '')
}

export function spillToolResult(sessionId: string, _toolCallId: string, output: string): ToolResultSpillRef | undefined {
  return withFileLock(join(spillDir(sessionId), '.quota'), () => {
  const encoded = Buffer.from(output, 'utf8')
  const bytes = encoded.length
  if (bytes <= TOOL_RESULT_SPILL_THRESHOLD) return undefined
  if (bytes > MAX_TOOL_RESULT_BYTES) throw new Error(`Tool result exceeds spill limit of ${MAX_TOOL_RESULT_BYTES} bytes`)
  const id = randomBytes(32).toString('hex')
  const dir = spillDir(sessionId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const existing = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.txt$/.test(entry.name))
  const existingBytes = existing.reduce((total, entry) => total + statSync(join(dir, entry.name)).size, 0)
  if (existing.length >= MAX_SESSION_SPILL_FILES || existingBytes + bytes > MAX_SESSION_SPILL_BYTES) throw new Error('Session tool-result spill quota exceeded')
  const finalPath = spillPath(sessionId, id)
  const tempPath = join(dir, `.${id}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tempPath, 'wx')
    writeSync(fd, encoded)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tempPath, finalPath)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(tempPath)) unlinkSync(tempPath)
  }
  const preview = utf8Preview(output, TOOL_RESULT_PREVIEW_BYTES)
  return { id, bytes, sha256: createHash('sha256').update(encoded).digest('hex'), preview: `${preview}\n[Full tool result stored as spill ${id} (${bytes} bytes). Use ToolResultRead with offsetBytes=0.]`, truncated: true }
  })
}
export function readSpilledToolResult(sessionId: string, id: string, offsetBytes = 0, limitBytes = 64_000): SpilledToolResultChunk | null {
  if (!/^[a-f0-9]{64}$/.test(id)) return null
  const path = spillPath(sessionId, id)
  if (!existsSync(path)) return null
  const safeOffset = Math.max(0, Math.floor(offsetBytes))
  const safeLimit = Math.max(1, Math.min(MAX_READ_CHUNK_BYTES, Math.floor(limitBytes)))
  const fd = openSync(path, 'r')
  try {
    const totalBytes = fstatSync(fd).size
    if (safeOffset >= totalBytes) return { content: '', totalBytes, offsetBytes: safeOffset, contentBytes: 0, eof: true }
    const requested = Math.min(safeLimit, totalBytes - safeOffset)
    const buffer = Buffer.alloc(Math.min(requested + 4, totalBytes - safeOffset))
    const read = readSync(fd, buffer, 0, buffer.length, safeOffset)
    let contentBytes = Math.min(requested, read)
    let content = buffer.subarray(0, contentBytes).toString('utf8')
    while (content.endsWith('�') && contentBytes < read) { contentBytes += 1; content = buffer.subarray(0, contentBytes).toString('utf8') }
    while (content.endsWith('�') && contentBytes > 0 && contentBytes >= read) { contentBytes -= 1; content = buffer.subarray(0, contentBytes).toString('utf8') }
    if (contentBytes === 0 && read > 0) { contentBytes = Math.min(read, 4); content = buffer.subarray(0, contentBytes).toString('utf8') }
    const nextOffsetBytes = safeOffset + contentBytes
    return { content, totalBytes, offsetBytes: safeOffset, contentBytes, ...(nextOffsetBytes < totalBytes ? { nextOffsetBytes } : {}), eof: nextOffsetBytes >= totalBytes }
  } finally { closeSync(fd) }
}

export function cleanupSessionOperations(sessionId: string): void {
  rmSync(spillDir(sessionId), { recursive: true, force: true })
  rmSync(operationsPath(sessionId), { force: true })
}

export function cleanupSpilledToolResults(sessionId: string): void { rmSync(spillDir(sessionId), { recursive: true, force: true }) }

export type ToolRecoveryResolution = 'verified-not-applied' | 'verified-applied' | 'user-authorized-retry' | 'superseded'

export type ToolRecoveryAction = 'automatic-retry-allowed' | 'retry-requires-verification' | 'retry-requires-user-authorization' | 'retry-forbidden'

export interface ToolRecoveryRecord {
  recoveryId: string
  sourceRunId: string
  sourceToolCallId: string
  toolName: string
  inputFingerprint?: string
  fingerprintVersion: 'legacy-v1' | 'v2'
  workspaceFingerprint?: string
  toolSourceFingerprint?: string
  retrySemantics: import('../tools/registry').RetrySemantics
  recommendedAction: ToolRecoveryAction
  revision: number
  createdAt: number
  status: 'unresolved' | 'resolved'
  resolution?: ToolRecoveryResolution
  resolvedAt?: number
  note?: string
}

export function recoveryIdFor(sourceRunId: string, sourceToolCallId: string): string {
  return createHash('sha256').update(`${sourceRunId}\0${sourceToolCallId}`).digest('hex').slice(0, 32)
}

export function recoveryActionFor(retrySemantics: import('../tools/registry').RetrySemantics): ToolRecoveryAction {
  if (retrySemantics === 'read-only' || retrySemantics === 'idempotent' || retrySemantics === 'idempotent-with-key') return 'automatic-retry-allowed'
  return retrySemantics === 'verify-before-retry' ? 'retry-requires-verification' : 'retry-requires-user-authorization'
}

export function readToolRecoveries(sessionId: string): ToolRecoveryRecord[] {
  const events = readOperations(sessionId)
  const calls = new Map<string, { runId: string; toolCallId: string; toolName: string; inputFingerprint?: string; fingerprintVersion: 'legacy-v1' | 'v2'; workspaceFingerprint?: string; toolSourceFingerprint?: string; retrySemantics: import('../tools/registry').RetrySemantics; startedAt?: number; result: boolean }>()
  const resolutions = new Map<string, Extract<OperationEvent, { type: 'recovery-resolved' }>>()
  const terminalRuns = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool-proposed') calls.set(`${event.runId}\0${event.toolCallId}`, { runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, inputFingerprint: event.inputFingerprint, fingerprintVersion: event.fingerprintVersion === 2 ? 'v2' : 'legacy-v1', workspaceFingerprint: event.workspaceFingerprint, toolSourceFingerprint: event.toolSourceFingerprint, retrySemantics: event.retrySemantics ?? 'never-automatic', result: false })
    else if (event.type === 'tool-started') {
      const key = `${event.runId}\0${event.toolCallId}`
      const call = calls.get(key) ?? { runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, fingerprintVersion: 'legacy-v1', retrySemantics: 'never-automatic', result: false }
      call.startedAt = event.at
      call.toolName = event.toolName
      calls.set(key, call)
    } else if (event.type === 'tool-result') {
      const call = calls.get(`${event.runId}\0${event.toolCallId}`)
      if (call) call.result = true
    } else if (event.type === 'run-terminal') terminalRuns.add(event.runId)
    else if (event.type === 'recovery-resolved' && !resolutions.has(event.recoveryId)) resolutions.set(event.recoveryId, event)
  }
  const records: ToolRecoveryRecord[] = []
  for (const call of calls.values()) {
    if (call.startedAt === undefined || call.result || !terminalRuns.has(call.runId)) continue
    const recoveryId = recoveryIdFor(call.runId, call.toolCallId)
    const resolution = resolutions.get(recoveryId)
    const revision = resolution ? (resolution.revision ?? 1) : 0
    records.push({ recoveryId, sourceRunId: call.runId, sourceToolCallId: call.toolCallId, toolName: call.toolName, ...(call.inputFingerprint ? { inputFingerprint: call.inputFingerprint } : {}), fingerprintVersion: call.fingerprintVersion, ...(call.workspaceFingerprint ? { workspaceFingerprint: call.workspaceFingerprint } : {}), ...(call.toolSourceFingerprint ? { toolSourceFingerprint: call.toolSourceFingerprint } : {}), retrySemantics: call.retrySemantics, recommendedAction: recoveryActionFor(call.retrySemantics), revision, createdAt: call.startedAt, status: resolution ? 'resolved' : 'unresolved', ...(resolution ? { resolution: resolution.resolution, resolvedAt: resolution.at, note: resolution.note } : {}) })
  }
  return records.sort((left, right) => left.createdAt - right.createdAt)
}

export interface ResolveToolRecoveryInput { recoveryId: string; expectedRevision: number; resolution: ToolRecoveryResolution; note?: string }

export function resolveToolRecovery(sessionId: string, input: ResolveToolRecoveryInput): { success: boolean; changed: boolean; recovery?: ToolRecoveryRecord; error?: 'not-found' | 'already-resolved' | 'conflict' } {
  return withFileLock(operationsPath(sessionId), () => {
    const recovery = readToolRecoveries(sessionId).find((item) => item.recoveryId === input.recoveryId)
    if (!recovery) return { success: false, changed: false, error: 'not-found' as const }
    if (recovery.revision !== input.expectedRevision) return { success: false, changed: false, recovery, error: 'conflict' as const }
    if (recovery.status === 'resolved') return { success: false, changed: false, recovery, error: 'already-resolved' as const }
    const event: OperationEvent = { type: 'recovery-resolved', at: Date.now(), runId: recovery.sourceRunId, recoveryId: input.recoveryId, expectedRevision: recovery.revision, revision: recovery.revision + 1, resolution: input.resolution, ...(input.note?.trim() ? { note: input.note.trim().slice(0, 1000) } : {}) }
    const dir = getOperationsDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(operationsPath(sessionId), `${JSON.stringify(event)}\n`, 'utf8')
    return { success: true, changed: true, recovery: readToolRecoveries(sessionId).find((item) => item.recoveryId === input.recoveryId) }
  })
}

export interface MissingToolOutcome {
  toolCallId: string
  toolName: string
  inputFingerprint?: string
  kind: 'TOOL_NOT_STARTED' | 'TOOL_OUTCOME_UNKNOWN'
}

/**
 * Classify tools without a durably recorded result:
 * - TOOL_NOT_STARTED: a durable intent exists but no `tool-started` line, so
 *   the tool body never ran and the call can be safely re-issued;
 * - TOOL_OUTCOME_UNKNOWN: `tool-started` is durable but no result is, so the
 *   side effect may have happened and the call MUST NOT be auto-retried.
 */
export function classifyInterruptedRun(events: OperationEvent[]): MissingToolOutcome[] {
  const tools = new Map<string, { toolName: string; inputFingerprint?: string; started: boolean; result: boolean }>()
  for (const event of events) {
    if (event.type === 'tool-proposed') {
      const entry = tools.get(event.toolCallId) ?? { toolName: event.toolName, inputFingerprint: event.inputFingerprint, started: false, result: false }
      entry.inputFingerprint = event.inputFingerprint
      tools.set(event.toolCallId, entry)
    } else if (event.type === 'tool-started') {
      const entry = tools.get(event.toolCallId) ?? { toolName: event.toolName, inputFingerprint: undefined, started: false, result: false }
      entry.started = true
      entry.toolName = event.toolName
      tools.set(event.toolCallId, entry)
    } else if (event.type === 'tool-result') {
      const entry = tools.get(event.toolCallId) ?? { toolName: '', inputFingerprint: undefined, started: true, result: false }
      entry.result = true
      tools.set(event.toolCallId, entry)
    }
  }
  const missing: MissingToolOutcome[] = []
  for (const [toolCallId, entry] of tools) {
    if (entry.result) continue
    missing.push({
      toolCallId,
      toolName: entry.toolName,
      ...(entry.inputFingerprint ? { inputFingerprint: entry.inputFingerprint } : {}),
      kind: entry.started ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED'
    })
  }
  return missing
}

export interface ToolFingerprintContext { workspacePath: string | null; definition: { name: string; source?: import('../tools/registry').ToolSource } }
export interface ComputedToolFingerprint { fingerprintVersion: 2; inputFingerprint: string; workspaceFingerprint: string; toolSourceFingerprint: string }

function normalizeWorkspaceIdentity(workspacePath: string | null): string {
  return workspacePath === null ? 'none' : workspacePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function sourceIdentity(definition: ToolFingerprintContext['definition']): unknown {
  const source = definition.source
  if (!source || source.type === 'builtin') return { type: 'builtin', id: source?.id ?? definition.name, version: source?.name }
  if (source.type === 'mcp') return { type: 'mcp', id: source.id ?? definition.name, version: source.name }
  return { type: 'generated', id: source.toolId, version: `${source.versionId}:${source.fingerprint}` }
}

export function toolInputFingerprint(context: ToolFingerprintContext, input: Record<string, unknown>): ComputedToolFingerprint
export function toolInputFingerprint(toolName: string, input: Record<string, unknown>): string
export function toolInputFingerprint(contextOrName: ToolFingerprintContext | string, input: Record<string, unknown>): ComputedToolFingerprint | string {
  if (typeof contextOrName === 'string') return createHash('sha256').update(`${contextOrName}\0${canonicalizeJson(input)}`).digest('hex')
  const workspaceFingerprint = createHash('sha256').update(`workspace:v2:${normalizeWorkspaceIdentity(contextOrName.workspacePath)}`).digest('hex')
  const toolSourceFingerprint = createHash('sha256').update(`source:v2:${canonicalizeJson(sourceIdentity(contextOrName.definition))}`).digest('hex')
  const inputFingerprint = createHash('sha256').update(canonicalizeJson({ version: 2, workspaceFingerprint, toolSourceFingerprint, toolName: contextOrName.definition.name, input })).digest('hex')
  return { fingerprintVersion: 2, inputFingerprint, workspaceFingerprint, toolSourceFingerprint }
}

function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) sorted[key] = sortJsonValue((value as Record<string, unknown>)[key])
    return sorted
  }
  return value
}

export function unknownOutcomeGuard(recoveries: readonly ToolRecoveryRecord[]): import('../tools/registry').ToolGuard {
  const blocked = recoveries.filter((item) => item.fingerprintVersion === 'v2' && item.inputFingerprint && (item.status === 'unresolved' || item.resolution === 'verified-applied'))
  if (blocked.length === 0) return () => undefined
  return ({ input, definition, context }) => {
    const fingerprint = toolInputFingerprint({ workspacePath: context.workspacePath ?? null, definition }, input)
    const recovery = blocked.find((item) => item.inputFingerprint === fingerprint.inputFingerprint)
    if (!recovery) return undefined
    if (recovery.status === 'resolved') return { reason: 'this identical tool call was confirmed already applied after an earlier interruption; do not repeat it', code: 'TOOL_ALREADY_APPLIED', recoveryId: recovery.recoveryId }
    if (recovery.recommendedAction === 'automatic-retry-allowed') return undefined
    return { reason: recovery.retrySemantics === 'never-automatic' ? 'an interrupted previous run started this non-automatically-retryable tool call; explicit user authorization is required' : 'an interrupted previous run started this tool call but did not durably record its outcome; verify current state before retrying', code: 'TOOL_OUTCOME_UNKNOWN', recoveryId: recovery.recoveryId, requiresUserAction: true }
  }
}

export interface InterruptedRunView {
  runId?: string
  missing: MissingToolOutcome[]
}

/**
 * Causal view of the latest run that never recorded `run-terminal`: its events
 * plus the missing-tool classification. An empty `missing` list means either no
 * interruption or an interrupted run with no pending tool side effects.
 */
export function readInterruptedRun(sessionId: string): InterruptedRunView {
  const events = readOperations(sessionId)
  let start = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'run-terminal') {
      start = index + 1
      break
    }
  }
  const tail = events.slice(start)
  const runId = tail.length > 0 ? tail[0].runId : undefined
  return { runId, missing: classifyInterruptedRun(tail) }
}
