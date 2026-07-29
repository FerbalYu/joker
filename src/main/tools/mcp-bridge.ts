import { z } from 'zod'
import { mcpManager } from '../mcp/client'
import type { ToolDefinition } from './registry'

function sanitizeToolName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return sanitized || 'tool'
}

export interface McpToolEntry {
  serverId: string
  serverName: string
  tool: { name: string; description?: string; inputSchema: unknown }
}

export function generatedMcpToolName(serverId: string, toolName: string): string {
  return `mcp_${sanitizeToolName(serverId)}_${sanitizeToolName(toolName)}`
}

/**
 * Skill MCP allowlists are exact capabilities, never patterns. Supporting both
 * the stable generated name and serverId/tool.name keeps the persisted format
 * useful without allowing fuzzy or server-name matches.
 */
export function mcpToolKeys(entry: Pick<McpToolEntry, 'serverId' | 'tool'>): string[] {
  return [
    `${entry.serverId}/${entry.tool.name}`,
    generatedMcpToolName(entry.serverId, entry.tool.name)
  ]
}

export function filterMcpToolEntries(entries: readonly McpToolEntry[], allowedMcpTools?: readonly string[]): McpToolEntry[] {
  if (allowedMcpTools === undefined) return [...entries]
  const allowed = new Set(allowedMcpTools)
  return entries.filter((entry) => mcpToolKeys(entry).some((key) => allowed.has(key)))
}

function schemaToZod(schema: unknown): z.ZodObject<z.ZodRawShape> {
  if (!schema || typeof schema !== 'object') return z.object({}).passthrough()
  const value = schema as { type?: unknown; properties?: Record<string, unknown>; required?: unknown }
  if (value.type !== 'object' || !value.properties || typeof value.properties !== 'object') return z.object({}).passthrough()
  const required = new Set(Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === 'string') : [])
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, property] of Object.entries(value.properties)) {
    const item = property && typeof property === 'object' ? property as { type?: unknown; description?: unknown; enum?: unknown[] } : {}
    let field: z.ZodTypeAny = item.type === 'string' ? z.string() : item.type === 'number' || item.type === 'integer' ? z.number() : item.type === 'boolean' ? z.boolean() : z.unknown()
    if (Array.isArray(item.enum) && item.enum.length > 0 && item.enum.every((entry) => typeof entry === 'string')) field = z.enum(item.enum as [string, ...string[]])
    if (typeof item.description === 'string') field = field.describe(item.description)
    shape[key] = required.has(key) ? field : field.optional()
  }
  return z.object(shape).passthrough()
}

function formatMcpResult(result: unknown): { output: string; metadata?: Record<string, unknown> } {
  const value = result && typeof result === 'object' ? result as { content?: unknown; isError?: boolean; structuredContent?: unknown } : {}
  const blocks = Array.isArray(value.content) ? value.content : []
  const output = blocks.map((block) => {
    if (!block || typeof block !== 'object') return String(block)
    const item = block as { type?: unknown; text?: unknown; uri?: unknown }
    if (item.type === 'text') return typeof item.text === 'string' ? item.text : ''
    if (item.type === 'image') return '[MCP image content]'
    if (item.type === 'resource') return `[MCP resource: ${String(item.uri ?? 'unknown')}]`
    return `[MCP ${String(item.type ?? 'content')}]`
  }).filter(Boolean).join('\n') || ('structuredContent' in value && value.structuredContent ? JSON.stringify(value.structuredContent) : JSON.stringify(result))
  const truncated = output.length > 100_000 ? `${output.slice(0, 100_000)}\n[truncated]` : output
  return { output: truncated, metadata: { isError: value.isError === true } }
}

export function getMcpTools(allowedMcpTools?: readonly string[]): ToolDefinition[] {
  const entries = filterMcpToolEntries(mcpManager.getAllTools(), allowedMcpTools)
  return entries.map(({ serverId, serverName, tool }) => ({
    name: generatedMcpToolName(serverId, tool.name),
    description: `[MCP:${serverName}] ${tool.description ?? tool.name}`,
    source: { type: 'mcp', id: serverId, name: serverName },
    inputSchema: schemaToZod(tool.inputSchema),
    execute: async (input, context) => formatMcpResult(await mcpManager.callTool(serverId, tool.name, input, context.abortSignal))
  }))
}

export { sanitizeToolName, schemaToZod, formatMcpResult }
