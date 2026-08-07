import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ToolSet } from 'ai'
import type { ResearchContext } from '../research/context'
import type { SubagentActivity } from '../../shared/types'
import { writeToolAudit, type ToolAuditWriter } from './audit'
import { classifyToolRisk, type ToolRisk } from './risk'

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
  status: 'running' | 'done' | 'error' | 'denied'
  result?: ToolResult
  durationMs?: number
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
  const lifecycleContext = { ...context, abortSignal: abortSignal ?? context.abortSignal, toolCallId: resolvedToolCallId }
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
  let lifecycleState: unknown = definition.lifecycle
    ? await definition.lifecycle.proposed(lifecycleEvent(Date.now()))
    : undefined
  safeAudit(audit, { ...auditBase, stage: 'proposed', status: 'pending', arguments: input })
  let decision: ApprovalDecision
  try {
    decision = await context.approvalGate(definition.name, input, definition)
  } catch (error) {
    if (definition.lifecycle && lifecycleState !== undefined) {
      const deniedDecision: ApprovalDecision = {
        outcome: 'deny',
        risk,
        reason: 'approval gate failed'
      }
      lifecycleState = await definition.lifecycle.policyResolved(lifecycleState, {
        ...lifecycleEvent(Date.now()),
        decision: deniedDecision
      })
      await finishLifecycle(definition.lifecycle, lifecycleState, {
        ...lifecycleEvent(Date.now()),
        result: { output: 'Tool approval failed.' },
        denied: true
      })
    }
    throw error
  }
  lifecycleState = await definition.lifecycle?.policyResolved(lifecycleState, {
    ...lifecycleEvent(Date.now()),
    decision
  })
  if (decision.hostGrant) lifecycleContext.hostApprovalGrant = decision.hostGrant
  safeAudit(audit, {
    ...auditBase,
    stage: 'approval_resolved',
    status: decision.outcome === 'allow' ? 'allowed' : 'denied',
    reason: decision.reason,
    arguments: input
  })
  if (decision.outcome === 'deny') {
    const result = { output: 'Tool call was denied.' }
    if (definition.lifecycle) {
      await finishLifecycle(definition.lifecycle, lifecycleState, {
        ...lifecycleEvent(Date.now()),
        result,
        denied: true
      })
    }
    safeAudit(audit, { ...auditBase, stage: 'finished', status: 'denied', reason: decision.reason })
    await safeNotify(context.onToolCall, { toolCallId: resolvedToolCallId, toolName: definition.name, input, status: 'denied', result })
    return result
  }

  const startedAt = Date.now()
  lifecycleState = await definition.lifecycle?.started(lifecycleState, lifecycleEvent(startedAt))
  safeAudit(audit, { ...auditBase, stage: 'started', status: 'allowed', reason: decision.reason })
  await safeNotify(context.onToolCall, { toolCallId: resolvedToolCallId, toolName: definition.name, input, status: 'running' })
  try {
    const result = await definition.execute(input, lifecycleContext)
    const durationMs = Date.now() - startedAt
    if (definition.lifecycle) {
      await finishLifecycle(definition.lifecycle, lifecycleState, {
        ...lifecycleEvent(Date.now()),
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
    await safeNotify(context.onToolCall, { toolCallId: resolvedToolCallId, toolName: definition.name, input, status: 'done', result, durationMs })
    return result
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const message = error instanceof Error ? error.message : String(error)
    if (definition.lifecycle) {
      await finishLifecycle(definition.lifecycle, lifecycleState, {
        ...lifecycleEvent(Date.now()),
        error
      })
    }
    safeAudit(audit, {
      ...auditBase,
      stage: 'finished',
      status: 'error',
      durationMs,
      error: message
    })
    await safeNotify(context.onToolCall, { toolCallId: resolvedToolCallId, toolName: definition.name, input, status: 'error', durationMs, error: message })
    throw error
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

async function finishLifecycle(
  lifecycle: ToolExecutionLifecycle | undefined,
  state: unknown,
  event: ToolLifecycleEvent & { result?: ToolResult; error?: unknown; denied?: boolean }
): Promise<void> {
  await lifecycle?.finished(state, event)
}

async function safeNotify(callback: ToolContext['onToolCall'], info: ToolCallInfo): Promise<void> {
  try {
    await callback?.(info)
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
