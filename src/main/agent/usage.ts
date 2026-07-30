import type { LanguageModelUsage, ModelMessage } from 'ai'
import type { ContextUsage, StreamUsage } from '../../shared/types'
import type { CapabilitySnapshot } from './capabilities'
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from './context'

export function streamUsageFromModelUsage(
  usage: LanguageModelUsage,
  stepCount = 1
): StreamUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    noCacheTokens: usage.inputTokenDetails.noCacheTokens,
    cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
    stepCount
  }
}

export function addStreamUsage(...usages: Array<StreamUsage | undefined>): StreamUsage {
  return usages.reduce<StreamUsage>((total, usage) => {
    if (!usage) return total
    return {
      inputTokens: addOptional(total.inputTokens, usage.inputTokens),
      outputTokens: addOptional(total.outputTokens, usage.outputTokens),
      totalTokens: addOptional(total.totalTokens, usage.totalTokens),
      noCacheTokens: addOptional(total.noCacheTokens, usage.noCacheTokens),
      cacheReadTokens: addOptional(total.cacheReadTokens, usage.cacheReadTokens),
      cacheWriteTokens: addOptional(total.cacheWriteTokens, usage.cacheWriteTokens),
      stepCount: addOptional(total.stepCount, usage.stepCount)
    }
  }, {})
}

export function buildContextUsage(
  messages: ModelMessage[],
  options: {
    actualInputTokens?: number
    cacheReadTokens?: number
    maxTokens: number
    capabilities?: CapabilitySnapshot
    source: 'provider' | 'estimate'
    stepNumber: number
    compressionCount?: number
    compressionBeforeTokens?: number
    compressionAfterTokens?: number
    compressionError?: string
  }
): ContextUsage {
  const capabilities = options.capabilities
  const systemTokens = messages
    .filter((message) => message.role === 'system')
    .reduce((total, message) => total + estimateMessageTokens(message), 0)
  const toolMessageTokens = messages
    .filter((message) => message.role === 'tool')
    .reduce((total, message) => total + estimateMessageTokens(message), 0)
  const messageContentTokens = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .reduce((total, message) => total + estimateMessageTokens(message), 0)
  const skillTokens = capabilities?.skillTokens ?? 0
  const mcpTokens = capabilities?.mcpTokens ?? 0
  const instructionTokens = estimateTextTokens(capabilities?.systemPrompt ?? '')
  const systemPromptTokens = Math.max(0, instructionTokens - skillTokens)
  const toolDefinitionTokens = capabilities?.toolDefinitionTokens ?? 0
  const builtinToolTokens = Math.max(0, toolDefinitionTokens - mcpTokens)
  const estimatedInput = messageContentTokens + systemTokens + toolMessageTokens + systemPromptTokens + skillTokens + mcpTokens + builtinToolTokens
  const inputTokens = options.actualInputTokens ?? estimatedInput
  const allocated = scaleCategories({
    messageTokens: messageContentTokens,
    mcpTokens,
    systemTokens,
    toolTokens: toolMessageTokens + builtinToolTokens,
    skillTokens,
    systemPromptTokens
  }, inputTokens)
  const normalized = normalizeCategories(allocated, inputTokens)
  const used = Object.values(normalized).reduce((total, value) => total + value, 0)

  return {
    inputTokens,
    maxTokens: options.maxTokens,
    percent: Math.min(100, Math.round((inputTokens / options.maxTokens) * 1000) / 10),
    ...normalized,
    otherTokens: Math.max(0, inputTokens - used),
    cacheHitRate: inputTokens > 0 && options.cacheReadTokens !== undefined
      ? Math.min(100, Math.round((options.cacheReadTokens / inputTokens) * 1000) / 10)
      : undefined,
    source: options.source,
    stepNumber: options.stepNumber,
    compressionCount: options.compressionCount,
    compressionBeforeTokens: options.compressionBeforeTokens,
    compressionAfterTokens: options.compressionAfterTokens,
    compressionError: options.compressionError
  }
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0)
}

function scaleCategories<T extends Record<string, number>>(categories: T, total: number): T {
  const estimated = Object.values(categories).reduce((sum, value) => sum + value, 0)
  if (estimated <= total || estimated === 0) return categories
  const ratio = total / estimated
  return Object.fromEntries(
    Object.entries(categories).map(([key, value]) => [key, Math.max(0, Math.round(value * ratio))])
  ) as T
}

function normalizeCategories<T extends Record<string, number>>(categories: T, total: number): T {
  const entries = Object.entries(categories)
  let overflow = Math.max(0, entries.reduce((sum, [, value]) => sum + value, 0) - total)
  if (overflow === 0) return categories
  const normalized: Record<string, number> = { ...categories }
  for (const [key] of [...entries].sort((left, right) => right[1] - left[1])) {
    if (overflow === 0) break
    const reduction = Math.min(normalized[key] ?? 0, overflow)
    normalized[key] = (normalized[key] ?? 0) - reduction
    overflow -= reduction
  }
  return normalized as T
}

export function estimateMessagesWithCapabilities(
  messages: ModelMessage[],
  capabilities?: CapabilitySnapshot
): number {
  return estimateContextTokens(messages) +
    estimateTextTokens(capabilities?.systemPrompt ?? '') +
    (capabilities?.toolDefinitionTokens ?? 0)
}
