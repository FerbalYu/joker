import { z } from 'zod'
import type { ToolDefinition, ToolResult } from './registry'
import { retrieveContextReference } from '../store/sessions'

export const contextRetrieveTool: ToolDefinition = {
  name: 'ContextRetrieve',
  description: 'Retrieve omitted original output from the current session by contextId or toolCallId. This tool cannot read files, URLs, or other sessions.',
  risk: 'read',
  inputSchema: z.object({
    contextId: z.string().regex(/^ctx_[a-f0-9]{32}$/).optional(),
    toolCallId: z.string().min(1).max(240).optional(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    query: z.string().max(500).optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    maxChars: z.number().int().min(256).max(64_000).optional()
  }).refine((value) => Boolean(value.contextId || value.toolCallId), { message: 'contextId or toolCallId is required' }),
  execute: async (input, context): Promise<ToolResult> => {
    const result = retrieveContextReference({
      sessionId: context.sessionId,
      contextId: typeof input.contextId === 'string' ? input.contextId : undefined,
      toolCallId: typeof input.toolCallId === 'string' ? input.toolCallId : undefined,
      contentHash: typeof input.contentHash === 'string' ? input.contentHash : undefined,
      query: typeof input.query === 'string' ? input.query : undefined,
      lineStart: typeof input.lineStart === 'number' ? input.lineStart : undefined,
      lineEnd: typeof input.lineEnd === 'number' ? input.lineEnd : undefined,
      maxChars: typeof input.maxChars === 'number' ? input.maxChars : undefined
    })
    if (!result) throw new Error('Context reference not found, expired, or changed in the current session.')
    return {
      output: result.content,
      metadata: {
        contextId: result.reference.contextId,
        contentHash: result.reference.contentHash,
        sourceName: result.reference.sourceName,
        totalLines: result.totalLines,
        returnedLines: result.returnedLines
      }
    }
  }
}

export const contextTools: ToolDefinition[] = [contextRetrieveTool]
