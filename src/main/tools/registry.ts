import { z } from 'zod'
import type { ToolSet } from 'ai'

// Tool definition shape compatible with AI SDK's tool()
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: z.ZodObject<z.ZodRawShape>
  source?: { type: 'builtin' | 'mcp'; id?: string; name?: string }
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

export interface ToolContext {
  workspacePath: string | null
  sessionId: string
  runId?: string
  approvalGate: ApprovalGate
  abortSignal?: AbortSignal
  onToolCall?: (info: ToolCallInfo) => void
}

export type ApprovalGate = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<boolean>

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
  for (const def of definitions) {
    tools[def.name] = {
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => {
        const approved = await context.approvalGate(def.name, input)
        if (!approved) {
          return { output: 'Tool call was denied by user.' }
        }
        return def.execute(input, { ...context, abortSignal: options?.abortSignal ?? context.abortSignal })
      }
    }
  }
  return tools as ToolSet
}
