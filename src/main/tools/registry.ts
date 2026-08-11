import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ToolSet } from 'ai'
import type { ResearchContext } from '../research/context'
import type { SubagentActivity } from '../../shared/types'
import { writeToolAudit, type ToolAuditWriter } from './audit'
import { classifyToolRisk, type ToolRisk } from './risk'

const DEFAULT_TOOL_TIMEOUT_MS = 3 * 60_000
const DEFAULT_TOOL_HEARTBEAT_MS = 2_000
const LIFECYCLE_CALLBACK_TIMEOUT_MS = 5_000

class ToolDeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Tool execution timed out after ${timeoutMs}ms`)
    this.name = 'ToolDeadlineError'
  }
}

class ToolCancelledError extends Error {
  constructor(reason?: unknown) {
    super(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Tool execution cancelled')
    this.name = 'ToolCancelledError'
  }
}

export type ToolSource =
  | { type: 'builtin'; id?: string; name?: string }
  | { type: 'mcp'; id?: string; name?: string }
  | {
      type: 'generated'
      toolId: string
      name: string
      versionId: string
      fingerprint: string
      validationReportId: string
      pointerRevision: number
      capabilityRevision: number
      runtimeQualificationLevel: 'L2' | 'L1'
      validationProfile: 'gate2-project-read-v1' | 'user-owned-full-trust-v1'
    }

export interface ToolLifecycleEvent {
  input: Record<string, unknown>
  context: ToolContext
  toolCallId: string
  occurredAt: number
}

export interface ToolExecutionLifecycle {
  proposed: (event: ToolLifecycleEvent) => Promise<unknown> | unknown
  policyResolved: (
    state: unknown,
    event: ToolLifecycleEvent & { decision: ApprovalDecision }
  ) => Promise<unknown> | unknown
  started: (state: unknown, event: ToolLifecycleEvent) => Promise<unknown> | unknown
  finished: (
    state: unknown,
    event: ToolLifecycleEvent & {
      result?: ToolResult
      error?: unknown
      denied?: boolean
    }
  ) => Promise<void> | void
}

// Tool definition shape compatible with AI SDK's tool()
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: z.ZodObject<z.ZodRawShape>
  source?: ToolSource
  risk?: ToolRisk
  lifecycle?: ToolExecutionLifecycle
  /** Host-owned upper bound. Tool-specific internal deadlines may be shorter. */
  timeoutMs?: number
  /** Frequency for observable wrapper heartbeats while execute() is pending. */
  heartbeatMs?: number
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

export interface HostApprovalGrant {
  requestId: string
  webContentsId: number
  sessionId: string
  runId: string
  toolName: string
  requestHash: string
  approvedAt: number
}

export interface HostApprovalRequest {
  toolName: string
  input: Record<string, unknown>
  sessionId: string
  runId: string
}

export interface ToolContext {
  workspacePath: string | null
  sessionId: string
  runId?: string
  approvalGate: ApprovalGate
  requestHostApproval?: (request: HostApprovalRequest) => Promise<HostApprovalGrant | null>
  hostApprovalGrant?: HostApprovalGrant
  researchContext?: ResearchContext
  abortSignal?: AbortSignal
  toolCallId?: string
  onToolCall?: (info: ToolCallInfo) => void | Promise<void>
  onSubagentActivity?: (activity: SubagentActivity) => void | Promise<void>
  auditWriter?: ToolAuditWriter
}

export interface ApprovalDecision {
  outcome: 'allow' | 'deny'
  risk: ToolRisk
  reason: string
  approvedByUser?: boolean
  hostGrant?: HostApprovalGrant
}

export interface ApprovalGate {
  (
    toolName: string,
    input: Record<string, unknown>,
    tool?: Pick<ToolDefinition, 'risk' | 'source'>
  ): Promise<ApprovalDecision>
  requestExplicitApproval?: (request: HostApprovalRequest) => Promise<HostApprovalGrant | null>
}

export interface ToolCallInfo {
  toolCallId?: string
  toolName: string
  input: Record<string, unknown>
  status: 'running' | 'done' | 'error' | 'denied' | 'cancelled' | 'timed-out'
  result?: ToolResult
  startedAt?: number
  updatedAt?: number
  lastProgressAt?: number
  deadlineAt?: number
  durationMs?: number
  heartbeat?: boolean
  error?: string
}

export interface ToolResult {
  output: string
  metadata?: Record<string, unknown>
}

export async function executeToolDefinition(
  definition: ToolDefinition,
  input: Record<string, unknown>,
  context: ToolContext,
  abortSignal?: AbortSignal,
  toolCallId?: string
): Promise<ToolResult> {
  const audit = context.auditWriter ?? writeToolAudit
  const risk = classifyToolRisk(definition.name, definition.risk, definition.source)
  const source = definition.source?.type ?? 'builtin'
  const resolvedToolCallId = toolCallId ?? context.toolCallId ?? createHash('sha256')
    .update(`${context.sessionId}\0${context.runId ?? ''}\0${definition.name}\0${JSON.stringify(input)}`)
    .digest('hex')
    .slice(0, 32)
  const parentSignal = abortSignal ?? context.abortSignal
  const executionController = new AbortController()
  const forwardAbort = (): void => executionController.abort(parentSignal?.reason)
  if (parentSignal?.aborted) forwardAbort()
  else parentSignal?.addEventListener('abort', forwardAbort, { once: true })
  const lifecycleContext = { ...context, abortSignal: executionController.signal, toolCallId: resolvedToolCallId }
  if (!lifecycleContext.requestHostApproval && context.approvalGate.requestExplicitApproval) {
    lifecycleContext.requestHostApproval = context.approvalGate.requestExplicitApproval
  }
  const lifecycleEvent = (occurredAt: number): ToolLifecycleEvent => ({
    input,
    context: lifecycleContext,
    toolCallId: resolvedToolCallId,
    occurredAt
  })
  const generatedSource = definition.source?.type === 'generated' ? definition.source : undefined
  const auditBase = {
    sessionId: context.sessionId,
    runId: context.runId,
    tool: definition.name,
    source,
    sourceId: definition.source?.type === 'generated' ? definition.source.toolId : definition.source?.id,
    ...(generatedSource ? {
      toolId: generatedSource.toolId,
      versionId: generatedSource.versionId,
      fingerprint: generatedSource.fingerprint,
      validationReportId: generatedSource.validationReportId,
      pointerRevision: generatedSource.pointerRevision,
      capabilityRevision: generatedSource.capabilityRevision
    } : {}),
    risk
  }
  let lifecycleState: unknown
  try {
    lifecycleState = definition.lifecycle
      ? await boundedLifecycle('proposed', () => definition.lifecycle!.proposed(lifecycleEvent(Date.now())))
      : undefined
    safeAudit(audit, { ...auditBase, stage: 'proposed', status: 'pending', arguments: input })
    let decision: ApprovalDecision
    try {
      decision = generatedSource?.validationProfile === 'user-owned-full-trust-v1'
        ? { outcome: 'allow', risk, reason: 'Generated Tool automatic execution' }
        : await context.approvalGate(definition.name, input, definition)
    } catch (error) {
      if (definition.lifecycle && lifecycleState !== undefined) {
        const deniedDecision: ApprovalDecision = {
          outcome: 'deny',
          risk,
          reason: 'approval gate failed'
        }
        lifecycleState = await boundedLifecycle('policyResolved', () => definition.lifecycle!.policyResolved(lifecycleState, {
          ...lifecycleEvent(Date.now()),
          decision: deniedDecision
        }))
        await finishLifecycleBounded(definition.lifecycle, lifecycleState, {
          ...lifecycleEvent(Date.now()),
          result: { output: 'Tool approval failed.' },
          denied: true
        })
      }
      throw error
    }
    lifecycleState = definition.lifecycle
      ? await boundedLifecycle('policyResolved', () => definition.lifecycle!.policyResolved(lifecycleState, {
          ...lifecycleEvent(Date.now()),
          decision
        }))
      : lifecycleState
    if (decision.hostGrant) lifecycleContext.hostApprovalGrant = decision.hostGrant
    safeAudit(audit, {
      ...auditBase,
      stage: 'approval_resolved',
      status: decision.outcome === 'allow' ? 'allowed' : 'denied',
      reason: decision.reason,
      arguments: input
    })
    if (decision.outcome === 'deny') {
      const now = Date.now()
      const result = { output: 'Tool call was denied.' }
      if (definition.lifecycle) {
        await finishLifecycleBounded(definition.lifecycle, lifecycleState, {
          ...lifecycleEvent(now),
          result,
          denied: true
        })
      }
      safeAudit(audit, { ...auditBase, stage: 'finished', status: 'denied', reason: decision.reason })
      safeNotify(context.onToolCall, {
        toolCallId: resolvedToolCallId,
        toolName: definition.name,
        input,
        status: 'denied',
        result,
        updatedAt: now,
        durationMs: 0
      })
      return result
    }

    const startedAt = Date.now()
    const timeoutMs = resolveToolTimeoutMs(definition, input)
    const deadlineAt = startedAt + timeoutMs
    const heartbeatMs = Math.max(250, definition.heartbeatMs ?? DEFAULT_TOOL_HEARTBEAT_MS)
    lifecycleState = definition.lifecycle
      ? await boundedLifecycle('started', () => definition.lifecycle!.started(lifecycleState, lifecycleEvent(startedAt)))
      : lifecycleState
    safeAudit(audit, { ...auditBase, stage: 'started', status: 'allowed', reason: decision.reason })
    safeNotify(context.onToolCall, {
      toolCallId: resolvedToolCallId,
      toolName: definition.name,
      input,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      lastProgressAt: startedAt,
      deadlineAt
    })

    let heartbeat: NodeJS.Timeout | undefined
    let deadline: NodeJS.Timeout | undefined
    let abortListener: (() => void) | undefined
    try {
      heartbeat = setInterval(() => {
        safeNotify(context.onToolCall, {
          toolCallId: resolvedToolCallId,
          toolName: definition.name,
          input,
          status: 'running',
          startedAt,
          updatedAt: Date.now(),
          lastProgressAt: startedAt,
          deadlineAt,
          heartbeat: true
        })
      }, heartbeatMs)
      heartbeat.unref?.()

      const executionPromise = Promise.resolve().then(() => definition.execute(input, lifecycleContext))
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          const error = new ToolDeadlineError(timeoutMs)
          reject(error)
          executionController.abort(error)
        }, timeoutMs)
        deadline.unref?.()
      })
      const cancellationPromise = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new ToolCancelledError(executionController.signal.reason))
        if (executionController.signal.aborted) abortListener()
        else executionController.signal.addEventListener('abort', abortListener, { once: true })
      })
      const result = await Promise.race([executionPromise, timeoutPromise, cancellationPromise])
      const completedAt = Date.now()
      const durationMs = completedAt - startedAt
      if (definition.lifecycle) {
        await finishLifecycleBounded(definition.lifecycle, lifecycleState, {
          ...lifecycleEvent(completedAt),
          result
        })
      }
      safeAudit(audit, {
        ...auditBase,
        stage: 'finished',
        status: 'success',
        durationMs,
        resultPreview: result.output
      })
      safeNotify(context.onToolCall, {
        toolCallId: resolvedToolCallId,
        toolName: definition.name,
        input,
        status: 'done',
        result,
        startedAt,
        updatedAt: completedAt,
        lastProgressAt: completedAt,
        deadlineAt,
        durationMs
      })
      return result
    } catch (error) {
      const completedAt = Date.now()
      const durationMs = completedAt - startedAt
      const status = error instanceof ToolDeadlineError
        ? 'timed-out'
        : error instanceof ToolCancelledError || parentSignal?.aborted
          ? 'cancelled'
          : 'error'
      const message = error instanceof Error ? error.message : String(error)
      if (definition.lifecycle) {
        await finishLifecycleBounded(definition.lifecycle, lifecycleState, {
          ...lifecycleEvent(completedAt),
          error
        })
      }
      safeAudit(audit, {
        ...auditBase,
        stage: 'finished',
        status,
        durationMs,
        error: message
      })
      safeNotify(context.onToolCall, {
        toolCallId: resolvedToolCallId,
        toolName: definition.name,
        input,
        status,
        startedAt,
        updatedAt: completedAt,
        lastProgressAt: startedAt,
        deadlineAt,
        durationMs,
        error: message
      })
      throw error
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      if (deadline) clearTimeout(deadline)
      if (abortListener) executionController.signal.removeEventListener('abort', abortListener)
    }
  } finally {
    parentSignal?.removeEventListener('abort', forwardAbort)
  }
}

export function buildToolSet(
  definitions: ToolDefinition[],
  context: ToolContext
): ToolSet {
  const tools: Record<string, unknown> = {}
  for (const def of definitions) {
    if (Object.hasOwn(tools, def.name)) throw new Error(`Duplicate ToolDefinition name: ${def.name}`)
    tools[def.name] = {
      description: def.description,
      inputSchema: def.inputSchema,
      execute: (input: Record<string, unknown>, options?: { abortSignal?: AbortSignal; toolCallId?: string }) =>
        executeToolDefinition(def, input, context, options?.abortSignal, options?.toolCallId)
    }
  }
  return tools as ToolSet
}

async function finishLifecycleBounded(
  lifecycle: ToolExecutionLifecycle | undefined,
  state: unknown,
  event: ToolLifecycleEvent & { result?: ToolResult; error?: unknown; denied?: boolean }
): Promise<void> {
  if (!lifecycle) return
  try {
    await boundedLifecycle('finished', () => lifecycle.finished(state, event))
  } catch (error) {
    console.error('Tool lifecycle callback failed', error)
  }
}

function resolveToolTimeoutMs(definition: ToolDefinition, input: Record<string, unknown>): number {
  const requested = definition.name === 'Bash' && typeof input.timeout === 'number'
    ? input.timeout + 2_000
    : definition.timeoutMs
  return Math.max(1, Math.floor(requested ?? DEFAULT_TOOL_TIMEOUT_MS))
}

async function boundedLifecycle<T>(stage: string, callback: () => Promise<T> | T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool lifecycle ${stage} timed out after ${LIFECYCLE_CALLBACK_TIMEOUT_MS}ms`)), LIFECYCLE_CALLBACK_TIMEOUT_MS)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function safeNotify(callback: ToolContext['onToolCall'], info: ToolCallInfo): void {
  try {
    void Promise.resolve(callback?.(info)).catch(() => undefined)
  } catch {
    // Observability must never change tool execution.
  }
}

function safeAudit(audit: ToolAuditWriter, event: Parameters<ToolAuditWriter>[0]): void {
  try {
    audit(event)
  } catch {
    // Audit failure must never change tool execution.
  }
}
