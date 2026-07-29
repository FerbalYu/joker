import { streamText, isStepCount, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import { createLanguageModel } from '../providers'
import { loadConfig, resolveActiveModel } from '../store/config'
import { compressContext } from './context'
import type { ContextUsage, ReasoningLevel, StreamEvent } from '../../shared/types'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../shared/types'
import type { CapabilitySnapshot } from './capabilities'
import { formatSafeError } from './diagnostics'

const DEFAULT_MAX_OUTPUT_TOKENS = 8192

function toSdkReasoning(level: ReasoningLevel): 'provider-default' | 'none' | 'low' | 'medium' | 'high' {
  return level === 'auto' ? 'provider-default' : level
}

export interface RunOptions {
  sessionId: string
  runId?: string
  messages: ModelMessage[]
  tools?: ToolSet
  reasoningLevel: ReasoningLevel
  onEvent: (event: StreamEvent) => void | Promise<void>
  signal?: AbortSignal
  capabilities?: CapabilitySnapshot
  /** Test seam for deterministic stream lifecycle contracts. */
  model?: LanguageModel
}

export async function runAgent({ sessionId, runId = crypto.randomUUID(), messages, tools, reasoningLevel, onEvent, signal, capabilities, model: injectedModel }: RunOptions): Promise<void> {
  const activeConfig = loadConfig()
  const activeProvider = activeConfig.providers.find((provider) => provider.id === activeConfig.activeProviderId && provider.enabled) ??
    activeConfig.providers.find((provider) => provider.enabled)
  const activeModel = activeProvider?.models.find((model) => model.id === activeProvider.currentModelId && model.enabled) ??
    activeProvider?.models.find((model) => model.enabled)
  const model = injectedModel ?? createLanguageModel(resolveActiveModel(activeConfig))

  const maxContextTokens = activeModel?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
  const compressedMessages = await compressContext(messages, { maxContextTokens, outputTokenReserve: DEFAULT_MAX_OUTPUT_TOKENS })
  const agentMessages = compressedMessages

  const messageId = crypto.randomUUID()
  await onEvent({
    type: 'message-start',
    sessionId,
    runId,
    messageId,
    providerName: activeProvider?.name,
    modelName: activeModel?.name
  })

  let primaryErrorEmitted = false
  let abortEmitted = false
  try {
    const result = streamText({
      model,
      messages: agentMessages,
      instructions: capabilities?.systemPrompt,
      tools,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      reasoning: toSdkReasoning(reasoningLevel),
      stopWhen: tools ? isStepCount(50) : undefined,
      abortSignal: signal,
      onError: () => undefined
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        await onEvent({ type: 'token', sessionId, runId, text: part.text })
      } else if (part.type === 'tool-call') {
        await onEvent({
          type: 'tool-call',
          sessionId,
          runId,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input as Record<string, unknown>
        })
      } else if (part.type === 'tool-result') {
        const output =
          typeof part.output === 'object' && part.output !== null && 'output' in part.output
            ? String((part.output as { output: unknown }).output)
            : String(part.output)
        await onEvent({
          type: 'tool-result',
          sessionId,
          runId,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output,
          metadata:
            typeof part.output === 'object' && part.output !== null && 'metadata' in part.output
              ? (part.output as { metadata?: Record<string, unknown> }).metadata
              : undefined
        })
      } else if (part.type === 'tool-error') {
        await onEvent({
          type: 'tool-error',
          sessionId,
          runId,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          error: formatSafeError(part.error)
        })
      } else if (part.type === 'error') {
        primaryErrorEmitted = true
        await onEvent({ type: 'error', sessionId, runId, error: formatSafeError(part.error) })
      } else if (part.type === 'abort') {
        abortEmitted = true
        await onEvent({ type: 'abort', sessionId, runId })
      }
    }

    const usage = await result.usage
    const contextUsage = buildContextUsage(
      agentMessages,
      usage.inputTokens ?? 0,
      usage.inputTokenDetails.cacheReadTokens,
      maxContextTokens,
      capabilities
    )
    await onEvent({
      type: 'message-end',
      sessionId,
      runId,
      messageId,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.inputTokenDetails.cacheReadTokens
      }
    })
    await onEvent({ type: 'context-usage', sessionId, runId, usage: contextUsage })
  } catch (err) {
    if (signal?.aborted) {
      if (!abortEmitted) await onEvent({ type: 'abort', sessionId, runId })
    } else if (!primaryErrorEmitted) {
      await onEvent({ type: 'error', sessionId, runId, error: formatSafeError(err) })
    }
  } finally {
    await onEvent({ type: 'done', sessionId, runId })
  }
}

function buildContextUsage(
  messages: ModelMessage[],
  inputTokens: number,
  cacheReadTokens: number | undefined,
  maxTokens: number,
  capabilities?: CapabilitySnapshot
): ContextUsage {
  const messageTokens = Math.max(0, Math.round(inputTokens * 0.86))
  const systemPromptTokens = Math.max(0, inputTokens - messageTokens)
  const toolTokens = messages.filter((message) => message.role === 'tool').length * 120
  const systemTokens = messages.filter((message) => message.role === 'system').length * 80
  const mcpTokens = capabilities?.mcpTokens ?? 0
  const skillTokens = capabilities?.skillTokens ?? 0
  const otherTokens = Math.max(0, inputTokens - messageTokens - systemPromptTokens)
  return {
    inputTokens,
    maxTokens,
    percent: Math.min(100, Math.round((inputTokens / maxTokens) * 1000) / 10),
    messageTokens,
    mcpTokens,
    systemTokens,
    toolTokens,
    skillTokens,
    systemPromptTokens,
    otherTokens,
    cacheHitRate: inputTokens > 0 && cacheReadTokens !== undefined
      ? Math.min(100, Math.round((cacheReadTokens / inputTokens) * 1000) / 10)
      : undefined
  }
}
