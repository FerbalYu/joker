import { z } from 'zod'
import type { ToolSet } from 'ai'
import type { ResearchContext } from '../research/context'
import { writeToolAudit, type ToolAuditWriter } from './audit'
import { classifyToolRisk, type ToolRisk } from './risk'

// Tool definition shape compatible with AI SDK's tool()
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: z.ZodObject<z.ZodRawShape>
  source?: { type: 'builtin' | 'mcp'; id?: string; name?: string }
  risk?: ToolRisk
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

export interface ToolContext {
  workspacePath: string | null
  sessionId: string
  runId?: string
  approvalGate: ApprovalGate
  researchContext?: ResearchContext
  abortSignal?: AbortSignal
  onToolCall?: (info: ToolCallInfo) => void
  auditWriter?: ToolAuditWriter
}

export interface ApprovalDecision {
  outcome: 'allow' | 'deny'
  risk: ToolRisk
  reason: string
  approvedByUser?: boolean
}

export type ApprovalGate = (
  toolName: string,
  input: Record<string, unknown>,
  tool?: Pick<ToolDefinition, 'risk' | 'source'>
) => Promise<ApprovalDecision>

export interface ToolCallInfo {
  toolName: string
  input: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  result?: ToolResult
  durationMs?: number
}

export interface ToolResult {
  output: string
  metadata?: Record<string, unknown>
}

export function buildToolSet(
  definitions: ToolDefinition[],
  context: ToolContext
): ToolSet {
  const tools: Record<string, unknown> = {}
  const audit = context.auditWriter ?? writeToolAudit
  for (const def of definitions) {
    const risk = classifyToolRisk(def.name, def.risk, def.source)
    const source = def.source?.type ?? 'builtin'
    const auditBase = {
      sessionId: context.sessionId,
      runId: context.runId,
      tool: def.name,
      source,
      sourceId: def.source?.id,
      risk
    }
    tools[def.name] = {
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => {
        safeAudit(audit, { ...auditBase, stage: 'proposed', status: 'pending', arguments: input })
        const decision = await context.approvalGate(def.name, input, def)
        safeAudit(audit, {
          ...auditBase,
          stage: 'approval_resolved',
          status: decision.outcome === 'allow' ? 'allowed' : 'denied',
          reason: decision.reason,
          arguments: input
        })
        if (decision.outcome === 'deny') {
          safeAudit(audit, { ...auditBase, stage: 'finished', status: 'denied', reason: decision.reason })
          return { output: 'Tool call was denied.' }
        }

        const startedAt = Date.now()
        safeAudit(audit, { ...auditBase, stage: 'started', status: 'allowed', reason: decision.reason })
        try {
          const result = await def.execute(input, { ...context, abortSignal: options?.abortSignal ?? context.abortSignal })
          safeAudit(audit, {
            ...auditBase,
            stage: 'finished',
            status: 'success',
            durationMs: Date.now() - startedAt,
            resultPreview: result.output
          })
          return result
        } catch (error) {
          safeAudit(audit, {
            ...auditBase,
            stage: 'finished',
            status: 'error',
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error)
          })
          throw error
        }
      }
    }
  }
  return tools as ToolSet
}

function safeAudit(audit: ToolAuditWriter, event: Parameters<ToolAuditWriter>[0]): void {
  try {
    audit(event)
  } catch {
    // Audit failure must never change tool execution.
  }
}
