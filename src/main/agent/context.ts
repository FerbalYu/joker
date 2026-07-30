import { generateText, type LanguageModel, type LanguageModelUsage, type ModelMessage } from 'ai'
import { createLanguageModel } from '../providers'
import { loadConfig, resolveActiveModel } from '../store/config'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../shared/types'
import { formatSafeError } from './diagnostics'

const COMPRESSION_SAFETY_RESERVE = 4096
const COMPRESSION_TRIGGER_RATIO = 0.8
const SUMMARY_MAX_OUTPUT_TOKENS = 2048
const MAX_TOOL_RESULT_TOKENS = 16_384
const TOOL_RESULT_HEAD_RATIO = 0.7

export interface CompressContextOptions {
  maxContextTokens?: number
  outputTokenReserve?: number
  extraTokens?: number
  model?: LanguageModel
}

export interface CompressionResult {
  messages: ModelMessage[]
  attempted: boolean
  compressed: boolean
  beforeTokens: number
  afterTokens: number
  usage?: LanguageModelUsage
  error?: string
}

export function estimateTextTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4))
}

export function estimateMessageTokens(message: ModelMessage): number {
  if (typeof message.content === 'string') return Math.max(1, estimateTextTokens(message.content))
  return message.content.reduce((total, part) => total + estimatePartTokens(part), 0)
}

export function estimateContextTokens(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

export function compressionThreshold(options: CompressContextOptions = {}): number {
  const maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
  const outputTokenReserve = options.outputTokenReserve ?? 8192
  const ratioThreshold = Math.floor(maxContextTokens * COMPRESSION_TRIGGER_RATIO)
  const hardThreshold = maxContextTokens - outputTokenReserve - COMPRESSION_SAFETY_RESERVE
  return Math.max(1, Math.min(ratioThreshold, hardThreshold))
}

function estimatePartTokens(part: unknown): number {
  if (!part || typeof part !== 'object') return 1
  const value = part as Record<string, unknown>
  if (value['type'] === 'text' || value['type'] === 'reasoning') {
    return Math.max(1, estimateTextTokens(String(value['text'] ?? '')))
  }
  if (value['type'] === 'tool-call') {
    return Math.max(1, estimateTextTokens(String(value['toolName'] ?? '') + JSON.stringify(value['input'] ?? null)))
  }
  if (value['type'] === 'tool-result') {
    return Math.max(1, estimateTextTokens(String(value['toolName'] ?? '') + toolResultText(value['output'])))
  }
  if (value['type'] === 'file' || value['type'] === 'image' || value['type'] === 'reasoning-file') return 256
  return Math.max(1, estimateTextTokens(JSON.stringify(value)))
}

function toolResultText(output: unknown): string {
  if (!output || typeof output !== 'object') return String(output ?? '')
  const value = output as Record<string, unknown>
  if (typeof value['value'] === 'string') return value['value']
  return JSON.stringify(output)
}

function projectToolResultOutput(output: unknown, maxTokens: number): unknown {
  if (!output || typeof output !== 'object') return output
  const value = output as Record<string, unknown>
  if (value['type'] === 'text' && typeof value['value'] === 'string') {
    const projected = truncateToolResult(value['value'], maxTokens)
    return projected === value['value'] ? output : { ...value, value: projected }
  }
  if ((value['type'] === 'json' || value['type'] === 'error-json') && value['value'] !== undefined) {
    const serialized = JSON.stringify(value['value'])
    if (estimateTextTokens(serialized) <= maxTokens) return output
    return {
      type: value['type'] === 'error-json' ? 'error-text' : 'text',
      value: truncateToolResult(serialized, maxTokens)
    }
  }
  if (value['type'] === 'content' && Array.isArray(value['value'])) {
    const serialized = JSON.stringify(value['value'])
    if (estimateTextTokens(serialized) <= maxTokens) return output
    return { type: 'text', value: truncateToolResult(serialized, maxTokens) }
  }
  return output
}

function redactMessageForSummary(message: ModelMessage): ModelMessage {
  if (typeof message.content === 'string') return message
  const text = message.content.map((part) => {
    if (part.type === 'text') return part.text
    if (part.type === 'tool-call') return `[Tool call: ${part.toolName} ${JSON.stringify(part.input)}]`
    if (part.type === 'tool-result') return `[Tool result: ${part.toolName}]\n${toolResultText(part.output)}`
    return '[binary attachment]'
  }).join('\n')
  return message.role === 'tool'
    ? { role: 'user', content: text }
    : { role: message.role, content: text }
}

function findRecentStart(messages: ModelMessage[], targetTokens: number): number {
  let tokens = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    tokens += estimateMessageTokens(messages[index])
    if (tokens > targetTokens) return alignToolPairStart(messages, Math.min(messages.length - 1, index + 1))
  }
  return 0
}

function alignToolPairStart(messages: ModelMessage[], index: number): number {
  let aligned = index
  while (aligned > 0 && messages[aligned]?.role === 'tool') aligned -= 1
  return aligned
}

function textToolResultCount(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => {
    if (message.role !== 'tool') return total
    return total + message.content.filter((part) => part.type === 'tool-result' && isProjectableToolOutput(part.output)).length
  }, 0)
}

function textToolResultTokens(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => {
    if (message.role !== 'tool') return total
    return total + message.content.reduce((messageTotal, part) => {
      if (part.type !== 'tool-result' || !isProjectableToolOutput(part.output)) return messageTotal
      return messageTotal + estimateTextTokens(toolResultText(part.output))
    }, 0)
  }, 0)
}

function isProjectableToolOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false
  const type = (output as Record<string, unknown>)['type']
  return type === 'text' || type === 'json' || type === 'error-json' || type === 'content'
}

function truncateToolResult(value: string, maxTokens: number): string {
  if (estimateTextTokens(value) <= maxTokens) return value
  const maxChars = Math.max(0, maxTokens * 4)
  const marker = '\n[tool output truncated for context]\n'
  if (maxChars <= marker.length) return marker.slice(0, maxChars)
  const retainedChars = maxChars - marker.length
  const headChars = Math.floor(retainedChars * TOOL_RESULT_HEAD_RATIO)
  const tailChars = retainedChars - headChars
  return `${value.slice(0, headChars)}${marker}${tailChars > 0 ? value.slice(-tailChars) : ''}`
}

export function truncateLargeToolResults(
  messages: ModelMessage[],
  maxTokensPerResult = MAX_TOOL_RESULT_TOKENS
): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-result') return part
        const output = projectToolResultOutput(part.output, maxTokensPerResult) as typeof part.output
        return output === part.output ? part : { ...part, output }
      })
    }
  })
}

function truncateToolResultsToBudget(messages: ModelMessage[], messageBudget: number): ModelMessage[] {
  const count = textToolResultCount(messages)
  if (count === 0) return messages
  const resultTokens = textToolResultTokens(messages)
  const fixedTokens = Math.max(0, estimateContextTokens(messages) - resultTokens)
  const perResultBudget = Math.max(1, Math.min(MAX_TOOL_RESULT_TOKENS, Math.floor((messageBudget - fixedTokens) / count)))
  return truncateLargeToolResults(messages, perResultBudget)
}

function latestUserIndex(messages: ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return index
  }
  return -1
}

function dropOlderTurns(messages: ModelMessage[], threshold: number, extraTokens: number): ModelMessage[] {
  let projected = messages
  while (estimateContextTokens(projected) + extraTokens >= threshold && projected.length > 1) {
    const currentTurnStart = latestUserIndex(projected)
    const summaryOffset = projected[0]?.role === 'system' && String(projected[0].content).startsWith('Previous conversation summary:') ? 1 : 0
    if (currentTurnStart > summaryOffset) {
      projected = [...projected.slice(0, summaryOffset), ...projected.slice(currentTurnStart)]
      continue
    }
    if (summaryOffset === 1) {
      projected = projected.slice(1)
      continue
    }
    break
  }
  return projected
}

function projectWithinBudget(messages: ModelMessage[], threshold: number, extraTokens: number): ModelMessage[] {
  const messageBudget = Math.max(1, threshold - extraTokens - 1)
  let projected = truncateToolResultsToBudget(messages, messageBudget)
  projected = dropOlderTurns(projected, threshold, extraTokens)
  if (estimateContextTokens(projected) + extraTokens >= threshold) {
    projected = truncateToolResultsToBudget(projected, messageBudget)
  }
  return projected
}

export async function compressContext(
  messages: ModelMessage[],
  options: CompressContextOptions = {}
): Promise<CompressionResult> {
  const extraTokens = options.extraTokens ?? 0
  const threshold = compressionThreshold(options)
  const beforeTokens = estimateContextTokens(messages) + extraTokens
  if (beforeTokens < threshold) {
    return { messages, attempted: false, compressed: false, beforeTokens, afterTokens: beforeTokens }
  }

  const recentBudget = Math.max(1, Math.floor((threshold - extraTokens) * 0.55))
  const recentStart = findRecentStart(messages, recentBudget)
  const toSummarize = messages.slice(0, recentStart)
  const recent = messages.slice(recentStart)

  try {
    let summaryMessage: ModelMessage | null = null
    let usage: LanguageModelUsage | undefined
    if (toSummarize.length > 0) {
      const model = options.model ?? createLanguageModel(resolveActiveModel(loadConfig()))
      const summaryInput = truncateLargeToolResults(toSummarize)
      const result = await generateText({
        model,
        system: 'Summarize the conversation concisely. Preserve decisions, file paths, commands, code changes, tool findings, errors, and unresolved work required to continue. Do not add facts.',
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        messages: summaryInput.map(redactMessageForSummary),
        allowSystemInMessages: true
      })
      summaryMessage = { role: 'system', content: `Previous conversation summary:\n${result.text}` }
      usage = result.usage
    }

    const projected = projectWithinBudget(summaryMessage ? [summaryMessage, ...recent] : recent, threshold, extraTokens)
    const afterTokens = estimateContextTokens(projected) + extraTokens
    return {
      messages: projected,
      attempted: true,
      compressed: afterTokens < beforeTokens,
      beforeTokens,
      afterTokens,
      usage,
      error: afterTokens >= threshold ? 'Context remains above the automatic compression threshold' : undefined
    }
  } catch (error) {
    const fallback = projectWithinBudget(messages, threshold, extraTokens)
    return {
      messages: fallback,
      attempted: true,
      compressed: estimateContextTokens(fallback) < estimateContextTokens(messages),
      beforeTokens,
      afterTokens: estimateContextTokens(fallback) + extraTokens,
      error: formatSafeError(error)
    }
  }
}
