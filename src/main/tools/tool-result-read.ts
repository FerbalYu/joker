import { z } from 'zod'
import type { ToolDefinition } from './registry'
import { readSpilledToolResult } from '../store/operations'

export const toolResultReadTool: ToolDefinition = {
  name: 'ToolResultRead',
  description: 'Read one byte range from a large tool result spill owned by the current session. Continue with nextOffsetBytes until eof is true.',
  risk: 'read',
  retrySemantics: 'read-only',
  executionMode: 'parallel-read',
  spillResults: false,
  inputSchema: z.object({
    spillId: z.string().regex(/^[a-f0-9]{64}$/),
    offsetBytes: z.number().int().nonnegative().optional(),
    limitBytes: z.number().int().positive().max(256_000).optional()
  }),
  execute: async (input, context) => {
    const { spillId, offsetBytes, limitBytes } = input as { spillId: string; offsetBytes?: number; limitBytes?: number }
    const chunk = readSpilledToolResult(context.sessionId, spillId, offsetBytes, limitBytes)
    if (!chunk) throw new Error('Tool result spill was not found for this session.')
    return { output: JSON.stringify({ spillId, ...chunk }) }
  }
}

export const toolResultTools: ToolDefinition[] = [toolResultReadTool]
