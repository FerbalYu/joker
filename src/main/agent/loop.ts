import { streamText, isStepCount, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import { createLanguageModel } from '../providers'
import { loadConfig, resolveActiveModel } from '../store/config'
import { compressContext, estimateTextTokens, type CompressionResult } from './context'
import type { ReasoningLevel, RunMode, StreamEvent, StreamUsage } from '../../shared/types'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../shared/types'
import type { CapabilitySnapshot } from './capabilities'
import { formatSafeError } from './diagnostics'
import { addStreamUsage, buildContextUsage, streamUsageFromModelUsage } from './usage'

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
  runMode?: RunMode
  onEvent: (event: StreamEvent) => void | Promise<void>
  signal?: AbortSignal
  capabilities?: CapabilitySnapshot
  /** Test seam for deterministic stream lifecycle contracts. */
  model?: LanguageModel
}

export async function runAgent({ sessionId, runId = crypto.randomUUID(), messages, tools, reasoningLevel, runMode = 'chat', onEvent, signal, capabilities, model: injectedModel }: RunOptions): Promise<void> {
  let compressionCount = 0
  let compressionBeforeTokens: number | undefined
  let compressionAfterTokens: number | undefined
  let compressionError: string | undefined
  let auxiliaryUsage: StreamUsage | undefined
  let latestStepMessages = messages
  let primaryErrorEmitted = false
  let abortEmitted = false

  try {
    const activeConfig = loadConfig()
    const activeProvider = activeConfig.providers.find((provider) => provider.id === activeConfig.activeProviderId && provider.enabled) ??
      activeConfig.providers.find((provider) => provider.enabled)
    const activeModel = activeProvider?.models.find((model) => model.id === activeProvider.currentModelId && model.enabled) ??
      activeProvider?.models.find((model) => model.enabled)
    const modelConfig = resolveActiveModel(activeConfig)
    const model = injectedModel ?? createLanguageModel(modelConfig)
    const maxContextTokens = activeModel?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
    const extraTokens = estimateTextTokens(capabilities?.systemPrompt ?? '') + (capabilities?.toolDefinitionTokens ?? 0)

    const initialCompression = await compressContext(messages, {
      maxContextTokens,
      outputTokenReserve: DEFAULT_MAX_OUTPUT_TOKENS,
      extraTokens,
      model
    })
    applyCompression(initialCompression)
    const agentMessages = initialCompression.messages
    latestStepMessages = agentMessages

    const messageId = crypto.randomUUID()
    await onEvent({
      type: 'message-start',
      sessionId,
      runId,
      messageId,
      runMode,
      providerName: activeProvider?.name,
      modelName: activeModel?.name
    })

    let responseContentSeen = false
    const result = streamText({
      model,
      messages: agentMessages,
      instructions: capabilities?.systemPrompt,
      tools,
      toolOrder: tools ? Object.keys(tools).sort() : undefined,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      reasoning: toSdkReasoning(reasoningLevel),
      stopWhen: tools ? isStepCount(50) : undefined,
      abortSignal: signal,
      allowSystemInMessages: true,
      include: { requestMessages: true },
      providerOptions: providerOptions(modelConfig, runId),
      prepareStep: async ({ messages: stepMessages }) => {
        const compressed = await compressContext(stepMessages, {
          maxContextTokens,
          outputTokenReserve: DEFAULT_MAX_OUTPUT_TOKENS,
          extraTokens,
          model
        })
        applyCompression(compressed)
        return compressed.messages === stepMessages ? undefined : { messages: compressed.messages }
      },
      onStepStart: async ({ messages: stepMessages, stepNumber }) => {
        latestStepMessages = stepMessages
        await onEvent({
          type: 'context-usage',
          sessionId,
          runId,
          usage: buildContextUsage(stepMessages, {
            maxTokens: maxContextTokens,
            capabilities,
            source: 'estimate',
            stepNumber: stepNumber + 1,
            compressionCount,
            compressionBeforeTokens,
            compressionAfterTokens,
            compressionError
          })
        })
      },
      onStepEnd: async (step) => {
        await onEvent({
          type: 'context-usage',
          sessionId,
          runId,
          usage: buildContextUsage(step.request.messages ?? latestStepMessages, {
            actualInputTokens: step.usage.inputTokens,
            cacheReadTokens: step.usage.inputTokenDetails.cacheReadTokens,
            maxTokens: maxContextTokens,
            capabilities,
            source: step.usage.inputTokens === undefined ? 'estimate' : 'provider',
            stepNumber: step.stepNumber + 1,
            compressionCount,
            compressionBeforeTokens,
            compressionAfterTokens,
            compressionError
          })
        })
      },
      onError: () => undefined
    })

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        if (part.text) responseContentSeen = true
        await onEvent({ type: 'token', sessionId, runId, text: part.text })
      } else if (part.type === 'tool-call') {
        responseContentSeen = true
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
        const metadata =
          typeof part.output === 'object' && part.output !== null && 'metadata' in part.output
            ? (part.output as { metadata?: Record<string, unknown> }).metadata
            : undefined
        auxiliaryUsage = addStreamUsage(auxiliaryUsage, usageFromMetadata(metadata))
        await onEvent({
          type: 'tool-result',
          sessionId,
          runId,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output,
          metadata
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
        if (!primaryErrorEmitted) {
          primaryErrorEmitted = true
          await onEvent({ type: 'error', sessionId, runId, error: formatSafeError(part.error) })
        }
      } else if (part.type === 'abort') {
        abortEmitted = true
        await onEvent({ type: 'abort', sessionId, runId })
      }
    }

    if (primaryErrorEmitted || abortEmitted) return
    if (!responseContentSeen) {
      primaryErrorEmitted = true
      await onEvent({ type: 'error', sessionId, runId, error: 'The model returned an empty response' })
      return
    }
    const [usage, steps, finalStep] = await Promise.all([result.usage, result.steps, result.finalStep])
    const totalUsage = addStreamUsage(streamUsageFromModelUsage(usage, steps.length), auxiliaryUsage)
    await onEvent({ type: 'message-end', sessionId, runId, messageId, usage: totalUsage })
    await onEvent({
      type: 'context-usage',
      sessionId,
      runId,
      usage: buildContextUsage(finalStep.request.messages ?? latestStepMessages, {
        actualInputTokens: finalStep.usage.inputTokens,
        cacheReadTokens: finalStep.usage.inputTokenDetails.cacheReadTokens,
        maxTokens: maxContextTokens,
        capabilities,
        source: finalStep.usage.inputTokens === undefined ? 'estimate' : 'provider',
        stepNumber: finalStep.stepNumber + 1,
        compressionCount,
        compressionBeforeTokens,
        compressionAfterTokens,
        compressionError
      })
    })
  } catch (err) {
    if (signal?.aborted) {
      if (!abortEmitted) await emitTerminal({ type: 'abort', sessionId, runId })
    } else if (!primaryErrorEmitted) {
      await emitTerminal({ type: 'error', sessionId, runId, error: formatSafeError(err) })
    }
  } finally {
    await emitTerminal({ type: 'done', sessionId, runId })
  }

  async function emitTerminal(event: StreamEvent): Promise<void> {
    try {
      await onEvent(event)
    } catch (error) {
      console.error('Failed to emit terminal stream event', error)
    }
  }

  function applyCompression(result: CompressionResult): void {
    if (result.attempted) {
      compressionCount += 1
      compressionBeforeTokens = result.beforeTokens
      compressionAfterTokens = result.afterTokens
      compressionError = result.error
    }
    if (result.usage) auxiliaryUsage = addStreamUsage(auxiliaryUsage, streamUsageFromModelUsage(result.usage, 1))
  }
}

function providerOptions(config: ReturnType<typeof resolveActiveModel>, runId: string): ProviderOptions | undefined {
  if (config.promptCache === false) return undefined
  const cacheKey = `joker:${config.provider}:${config.model}`
  if (config.apiFormat === 'anthropic-messages') {
    return { anthropic: { cacheControl: { type: 'ephemeral' } } }
  }
  if (config.provider === 'openai') {
    return {
      openai: {
        promptCacheKey: cacheKey,
        promptCacheOptions: { mode: 'implicit', ttl: '30m' }
      }
    }
  }
  void runId
  return undefined
}

function usageFromMetadata(metadata: Record<string, unknown> | undefined): StreamUsage | undefined {
  const value = metadata?.['usage']
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  return {
    inputTokens: numeric(usage['inputTokens']),
    outputTokens: numeric(usage['outputTokens']),
    totalTokens: numeric(usage['totalTokens']),
    noCacheTokens: numeric(usage['noCacheTokens']),
    cacheReadTokens: numeric(usage['cacheReadTokens']),
    cacheWriteTokens: numeric(usage['cacheWriteTokens']),
    stepCount: numeric(usage['stepCount'])
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
