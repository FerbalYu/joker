import { streamText, isStepCount, type FinishReason, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import { createLanguageModel } from '../providers'
import { loadConfig, resolveActiveModel } from '../store/config'
import { compressContext, estimateTextTokens, type CompressionResult } from './context'
import type { AssistantSegment, ChatMessage, ReasoningLevel, RunMode, StreamEvent, StreamUsage, ToolCallInfo } from '../../shared/types'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../shared/types'
import type { CapabilitySnapshot } from './capabilities'
import { formatSafeError } from './diagnostics'
import { addStreamUsage, buildContextUsage, streamUsageFromModelUsage } from './usage'
import {
  EXECUTION_CONTRACT_VIOLATION,
  executionContractInstructions,
  type AgentExecutionContract
} from './execution-contract'
import { detectRepetitionLoop, REPETITION_LOOP_ERROR, REPETITION_LOOP_NOTICE } from './repetition-guard'

const DEFAULT_MAX_OUTPUT_TOKENS = 8192
const DEFAULT_MAX_STEPS = 50

export interface AgentStepDetails {
  count: number
  limit: number
  finishReason?: FinishReason
  rawFinishReason?: string
}

interface AgentRunSnapshot {
  messageId?: string
  text: string
  segments: AssistantSegment[]
  toolCalls: ToolCallInfo[]
  usage?: StreamUsage
  steps: AgentStepDetails
}

type AgentRunDetails =
  | { status: 'completed'; messageId: string; usage: StreamUsage; finishReason: FinishReason }
  | { status: 'step-limit'; messageId: string; usage: StreamUsage; finishReason: FinishReason }
  | { status: 'repetition'; messageId: string; usage: StreamUsage; error: string }
  | { status: 'aborted' }
  | { status: 'error'; error: string }
  | { status: 'empty'; messageId: string; error: string }

export type AgentRunResult = AgentRunSnapshot & AgentRunDetails

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
  checkpointUsed?: boolean
  /** Returns queued steer messages to apply at the next safe model-step boundary. */
  takeSteerMessages?: (stepNumber: number) => Promise<ChatMessage[]> | ChatMessage[]
  /** Receives each completed model step as a replayable assistant message. */
  onStepCommitted?: (message: ChatMessage, stepNumber: number) => Promise<void> | void
  /** Maximum model steps when tools are available. */
  maxSteps?: number
  /** Host-side requirement for tool-eligible turns. */
  executionContract?: AgentExecutionContract
  /** Test seam for deterministic stream lifecycle contracts. */
  model?: LanguageModel
}

export async function runAgent({ sessionId, runId = crypto.randomUUID(), messages, tools, reasoningLevel, runMode = 'chat', onEvent, signal, capabilities, checkpointUsed = false, takeSteerMessages, onStepCommitted, maxSteps = DEFAULT_MAX_STEPS, executionContract, model: injectedModel }: RunOptions): Promise<AgentRunResult> {
  let compressionCount = 0
  let compressionBeforeTokens: number | undefined
  let compressionAfterTokens: number | undefined
  let compressionError: string | undefined
  let auxiliaryUsage: StreamUsage | undefined
  let latestStepMessages = messages
  let primaryErrorEmitted = false
  let abortEmitted = false
  let messageId = crypto.randomUUID()
  let text = ''
  let segments: AssistantSegment[] = []
  const toolCalls: ToolCallInfo[] = []
  let totalUsage: StreamUsage | undefined
  let completedStepUsage: StreamUsage | undefined
  let stepCount = 0
  let finishReason: FinishReason | undefined
  let rawFinishReason: string | undefined
  let terminalResult: AgentRunResult | undefined
  let executionContractViolation: string | undefined
  let repetitionDetected = false
  let currentStepNumber = 1
  let currentStepTextStart = 0
  let streamController = new AbortController()
  let stepBuffer: StreamEvent[] = []
  const forwardExternalAbort = (): void => streamController.abort(signal?.reason)
  if (signal?.aborted) forwardExternalAbort()
  else signal?.addEventListener('abort', forwardExternalAbort, { once: true })

  try {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps must be a positive integer')
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
    let requiredToolChoice = true
    for (;;) {
      stepBuffer = []
      let retryStream = false
      const result = streamText({
        model,
        messages: agentMessages,
        instructions: capabilities?.systemPrompt,
        tools,
        toolOrder: tools ? Object.keys(tools).sort() : undefined,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        reasoning: toSdkReasoning(reasoningLevel),
        stopWhen: tools ? isStepCount(maxSteps) : undefined,
        abortSignal: streamController.signal,
        allowSystemInMessages: true,
        include: { requestMessages: true },
        providerOptions: providerOptions(modelConfig, runId),
        prepareStep: async ({ messages: stepMessages, stepNumber, instructions }) => {
          const compressed = await compressContext(stepMessages, {
            maxContextTokens,
            outputTokenReserve: DEFAULT_MAX_OUTPUT_TOKENS,
            extraTokens,
            model
          })
          applyCompression(compressed)
          const steers = await takeSteerMessages?.(stepNumber)
          const steerMessages = steers?.length ? steers.flatMap(toUserModelMessages) : []
          const preparedMessages = steerMessages.length > 0 ? [...compressed.messages, ...steerMessages] : compressed.messages
          const enforceExecution = stepNumber === 0 && executionContract?.requireToolCall === true
          if (!enforceExecution && preparedMessages === stepMessages) return undefined
          return {
            ...(preparedMessages === stepMessages ? {} : { messages: preparedMessages }),
            ...(enforceExecution ? {
              instructions: [instructions, executionContractInstructions(executionContract)].filter(Boolean).join('\n\n'),
              ...(requiredToolChoice ? { toolChoice: 'required' as const } : {}),
              activeTools: executionContract.activeToolNames
            } : {})
          }
        },
        onStepStart: async ({ messages: stepMessages, stepNumber }) => {
          latestStepMessages = stepMessages
          currentStepNumber = stepNumber + 1
          currentStepTextStart = text.length
          stepBuffer.push(
            { type: 'step-start', sessionId, runId, stepNumber: stepNumber + 1 },
            {
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
                compressionError,
                checkpointUsed
              })
            }
          )
        },
        onStepEnd: async (step) => {
          await flushStepBuffer(stepBuffer)
          stepCount = Math.max(stepCount, step.stepNumber + 1)
          completedStepUsage = addStreamUsage(completedStepUsage, streamUsageFromModelUsage(step.usage, 1))
          const missingRequiredTool = step.stepNumber === 0 && executionContract?.requireToolCall === true && !stepHasRequiredToolCall(step.content, executionContract.requiredFirstTool)
          if (missingRequiredTool) executionContractViolation = EXECUTION_CONTRACT_VIOLATION
          if (onStepCommitted && !missingRequiredTool) {
            const stepMessage = stepResultMessage(messageId, runMode, step)
            if (stepMessage) await onStepCommitted(stepMessage, step.stepNumber + 1)
          }
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
              compressionError,
              checkpointUsed
            })
          })
        },
        onError: () => undefined
      })

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          await flushStepBuffer(stepBuffer)
          if (part.text) {
            responseContentSeen = true
            text += part.text
            segments = appendTextSegment(segments, part.text)
          }
          await onEvent({ type: 'token', sessionId, runId, text: part.text })
          if (!repetitionDetected && detectRepetitionLoop(text)) {
            repetitionDetected = true
            text += REPETITION_LOOP_NOTICE
            segments = appendTextSegment(segments, REPETITION_LOOP_NOTICE)
            await onEvent({ type: 'token', sessionId, runId, text: REPETITION_LOOP_NOTICE })
            streamController.abort(new Error(REPETITION_LOOP_ERROR))
            break
          }
        } else if (part.type === 'tool-call') {
          await flushStepBuffer(stepBuffer)
          responseContentSeen = true
          const now = Date.now()
          const toolCall: ToolCallInfo = {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input as Record<string, unknown>,
            status: 'running',
            startedAt: now,
            updatedAt: now,
            lastProgressAt: now
          }
          toolCalls.push(toolCall)
          segments = appendToolSegment(segments, toolCall)
          await onEvent({
            type: 'tool-call',
            sessionId,
            runId,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input as Record<string, unknown>,
            startedAt: now,
            updatedAt: now,
            lastProgressAt: now
          })
        } else if (part.type === 'tool-result') {
          await flushStepBuffer(stepBuffer)
          const output = toolOutputText(part.output)
          const metadata =
            typeof part.output === 'object' && part.output !== null && 'metadata' in part.output
              ? (part.output as { metadata?: Record<string, unknown> }).metadata
              : undefined
          auxiliaryUsage = addStreamUsage(auxiliaryUsage, usageFromMetadata(metadata))
          const completedAt = Date.now()
          updateTool(part.toolCallId, { output, metadata, status: 'done', updatedAt: completedAt, lastProgressAt: completedAt })
          await onEvent({
            type: 'tool-result',
            sessionId,
            runId,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output,
            metadata,
            updatedAt: completedAt,
            lastProgressAt: completedAt
          })
        } else if (part.type === 'tool-error') {
          await flushStepBuffer(stepBuffer)
          const error = formatSafeError(part.error)
          const completedAt = Date.now()
          updateTool(part.toolCallId, { output: error, status: 'error', updatedAt: completedAt, lastProgressAt: completedAt, error })
          await onEvent({
            type: 'tool-error',
            sessionId,
            runId,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            error,
            status: 'error',
            updatedAt: completedAt,
            lastProgressAt: completedAt
          })
        } else if (part.type === 'error') {
          if (requiredToolChoice && stepCount === 0 && !responseContentSeen && isToolChoiceRejection(part.error)) {
            retryStream = true
            break
          }
          await flushStepBuffer(stepBuffer)
          const error = formatSafeError(part.error)
          terminalResult ??= snapshot({ status: 'error', error })
          if (!primaryErrorEmitted) {
            primaryErrorEmitted = true
            await onEvent({ type: 'error', sessionId, runId, error })
          }
        } else if (part.type === 'abort') {
          await flushStepBuffer(stepBuffer)
          terminalResult ??= snapshot({ status: 'aborted' })
          abortEmitted = true
          await onEvent({ type: 'abort', sessionId, runId })
        }
      }

      if (retryStream) {
        requiredToolChoice = false
        streamController.abort()
        streamController = new AbortController()
        continue
      }
      await flushStepBuffer(stepBuffer)

      if (repetitionDetected) return await finalizeRepetition()
      if (primaryErrorEmitted || abortEmitted) {
        if (terminalResult) return terminalResult
        return abortEmitted
          ? snapshot({ status: 'aborted' })
          : snapshot({ status: 'error', error: 'Agent stream failed' })
      }
      if (executionContractViolation) {
        primaryErrorEmitted = true
        await onEvent({ type: 'error', sessionId, runId, error: executionContractViolation })
        return snapshot({ status: 'error', error: executionContractViolation })
      }
      if (!responseContentSeen) {
        const error = 'The model returned an empty response'
        primaryErrorEmitted = true
        await onEvent({ type: 'error', sessionId, runId, error })
        return snapshot({ status: 'empty', messageId, error })
      }
      const [usage, steps, finalStep] = await Promise.all([result.usage, result.steps, result.finalStep])
      stepCount = steps.length
      finishReason = finalStep.finishReason
      rawFinishReason = finalStep.rawFinishReason
      totalUsage = addStreamUsage(streamUsageFromModelUsage(usage, steps.length), auxiliaryUsage)
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
          compressionError,
          checkpointUsed
        })
      })
      const stepLimitReached = Boolean(tools) && steps.length >= maxSteps && finalStep.finishReason === 'tool-calls'
      return snapshot({
        status: stepLimitReached ? 'step-limit' : 'completed',
        messageId,
        usage: totalUsage,
        finishReason
      })
    }
  } catch (err) {
    if (repetitionDetected) return await finalizeRepetition()
    await flushStepBuffer(stepBuffer)
    if (signal?.aborted) {
      if (!abortEmitted) {
        abortEmitted = true
        await emitTerminal({ type: 'abort', sessionId, runId })
      }
      return snapshot({ status: 'aborted' })
    }
    const error = formatSafeError(err)
    if (!primaryErrorEmitted) await emitTerminal({ type: 'error', sessionId, runId, error })
    return terminalResult?.status === 'error' ? terminalResult : snapshot({ status: 'error', error })
  } finally {
    signal?.removeEventListener('abort', forwardExternalAbort)
    await emitTerminal({ type: 'done', sessionId, runId })
  }

  async function flushStepBuffer(buffer: StreamEvent[]): Promise<void> {
    for (const event of buffer.splice(0)) await onEvent(event)
  }

  async function emitTerminal(event: StreamEvent): Promise<void> {
    try {
      await onEvent(event)
    } catch (error) {
      console.error('Failed to emit terminal stream event', error)
    }
  }

  function updateTool(toolCallId: string, update: Partial<Pick<ToolCallInfo, 'output' | 'status' | 'metadata' | 'startedAt' | 'updatedAt' | 'lastProgressAt' | 'deadlineAt' | 'durationMs' | 'error'>>): void {
    const tool = toolCalls.find((candidate) => candidate.toolCallId === toolCallId)
    if (!tool) return
    Object.assign(tool, update)
  }

  function snapshot<T extends AgentRunDetails>(details: T): AgentRunSnapshot & T {
    return {
      ...details,
      messageId,
      text,
      segments: cloneSegments(segments),
      toolCalls: toolCalls.map((tool) => ({ ...tool })),
      usage: 'usage' in details ? details.usage : totalUsage,
      steps: {
        count: stepCount,
        limit: maxSteps,
        finishReason,
        rawFinishReason
      }
    }
  }

  async function finalizeRepetition(): Promise<AgentRunResult> {
    stepCount = Math.max(stepCount, currentStepNumber)
    const currentStepText = text.slice(currentStepTextStart)
    const estimatedUsage: StreamUsage = {
      outputTokens: estimateTextTokens(currentStepText),
      stepCount: 1
    }
    totalUsage = addStreamUsage(completedStepUsage, auxiliaryUsage, estimatedUsage)
    if (onStepCommitted && currentStepText) {
      await onStepCommitted({
        id: `${messageId}-step-${currentStepNumber}`,
        role: 'assistant',
        content: currentStepText,
        segments: [{ type: 'text', text: currentStepText }],
        usage: estimatedUsage,
        runMode,
        createdAt: Date.now()
      }, currentStepNumber)
    }
    await onEvent({ type: 'message-end', sessionId, runId, messageId, usage: totalUsage })
    return snapshot({
      status: 'repetition',
      messageId,
      usage: totalUsage,
      error: REPETITION_LOOP_ERROR
    })
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

function stepHasRequiredToolCall(content: readonly unknown[], requiredTool?: { toolName: string; toolId?: string; versionId?: string; fingerprint?: string; validationReportId?: string; pointerRevision?: number; capabilityRevision?: number }): boolean {
  if (!requiredTool) return stepHasToolCall(content)
  const calls = new Set<string>()
  for (const value of content) {
    if (!value || typeof value !== 'object') continue
    const part = value as Record<string, unknown>
    if (part.type === 'tool-call' && part.toolName === requiredTool.toolName && typeof part.toolCallId === 'string') calls.add(part.toolCallId)
  }
  if (calls.size === 0) return false
  const hasBinding = requiredTool.toolId !== undefined || requiredTool.versionId !== undefined || requiredTool.fingerprint !== undefined || requiredTool.validationReportId !== undefined || requiredTool.pointerRevision !== undefined || requiredTool.capabilityRevision !== undefined
  if (!hasBinding) return true
  return content.some((value) => {
    if (!value || typeof value !== 'object') return false
    const part = value as Record<string, unknown>
    if ((part.type !== 'tool-result') || typeof part.toolCallId !== 'string' || !calls.has(part.toolCallId)) return false
    const output = part.output && typeof part.output === 'object' ? part.output as Record<string, unknown> : undefined
    const metadata = generatedToolMetadata(output)
    const generatedTool = metadata?.generatedTool && typeof metadata.generatedTool === 'object' ? metadata.generatedTool as Record<string, unknown> : undefined
    return Boolean(generatedTool
      && (requiredTool.toolId === undefined || generatedTool.toolId === requiredTool.toolId)
      && (requiredTool.versionId === undefined || generatedTool.versionId === requiredTool.versionId)
      && (requiredTool.fingerprint === undefined || generatedTool.fingerprint === requiredTool.fingerprint)
      && (requiredTool.validationReportId === undefined || generatedTool.validationReportId === requiredTool.validationReportId)
      && (requiredTool.pointerRevision === undefined || generatedTool.pointerRevision === requiredTool.pointerRevision)
      && (requiredTool.capabilityRevision === undefined || generatedTool.capabilityRevision === requiredTool.capabilityRevision))
  })
}

function generatedToolMetadata(output: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const direct = output?.metadata
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>
  const nested = output?.value
  if (nested && typeof nested === 'object' && 'metadata' in nested) {
    const metadata = (nested as Record<string, unknown>).metadata
    if (metadata && typeof metadata === 'object') return metadata as Record<string, unknown>
  }
  return undefined
}

function stepHasToolCall(content: readonly unknown[]): boolean {
  return content.some((value) => Boolean(value) && typeof value === 'object' && (value as Record<string, unknown>).type === 'tool-call')
}

function appendTextSegment(segments: AssistantSegment[], value: string): AssistantSegment[] {
  const last = segments.at(-1)
  if (last?.type === 'text') return [...segments.slice(0, -1), { type: 'text', text: last.text + value }]
  return [...segments, { type: 'text', text: value }]
}

function appendToolSegment(segments: AssistantSegment[], toolCall: ToolCallInfo): AssistantSegment[] {
  const last = segments.at(-1)
  if (last?.type === 'tools') return [...segments.slice(0, -1), { type: 'tools', tools: [...last.tools, toolCall] }]
  return [...segments, { type: 'tools', tools: [toolCall] }]
}

function cloneSegments(segments: AssistantSegment[]): AssistantSegment[] {
  return segments.map((segment) => segment.type === 'text'
    ? { ...segment }
    : { type: 'tools', tools: segment.tools.map((tool) => ({ ...tool })) })
}

function flattenSegmentText(segments: AssistantSegment[]): string {
  return segments.flatMap((segment) => segment.type === 'text' ? [segment.text] : []).join('')
}

function flattenToolCalls(segments: AssistantSegment[]): ToolCallInfo[] {
  return segments.flatMap((segment) => segment.type === 'tools' ? segment.tools.map((tool) => ({ ...tool })) : [])
}

function toUserModelMessages(message: ChatMessage): ModelMessage[] {
  if (message.role !== 'user') return []
  if (!message.parts?.length) return [{ role: 'user', content: message.content }]
  return [{
    role: 'user',
    content: message.parts.map((part) => part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'file' as const, data: part.data, mediaType: part.mediaType })
  }]
}

function stepResultMessage(messageId: string, runMode: RunMode, step: { stepNumber: number; content: readonly unknown[] }): ChatMessage | null {
  const segments: AssistantSegment[] = []
  const tools = new Map<string, ToolCallInfo>()
  for (const value of step.content) {
    if (!value || typeof value !== 'object') continue
    const part = value as Record<string, unknown>
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      const last = segments.at(-1)
      if (last?.type === 'text') last.text += part.text
      else segments.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'tool-call' && typeof part.toolCallId === 'string' && typeof part.toolName === 'string') {
      const tool: ToolCallInfo = {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input && typeof part.input === 'object' ? part.input as Record<string, unknown> : {},
        status: 'running'
      }
      tools.set(part.toolCallId, tool)
      const last = segments.at(-1)
      if (last?.type === 'tools') last.tools.push(tool)
      else segments.push({ type: 'tools', tools: [tool] })
      continue
    }
    if ((part.type === 'tool-result' || part.type === 'tool-error') && typeof part.toolCallId === 'string') {
      const tool = tools.get(part.toolCallId)
      if (!tool) continue
      tool.output = part.type === 'tool-error' ? formatSafeError(part.error) : toolOutputText(part.output)
      tool.metadata = part.type === 'tool-result' ? toolOutputMetadata(part.output) : undefined
      tool.status = part.type === 'tool-error' ? 'error' : 'done'
    }
  }
  if (segments.length === 0) return null
  const toolCalls = flattenToolCalls(segments)
  return {
    id: `${messageId}-step-${step.stepNumber + 1}`,
    role: 'assistant',
    content: flattenSegmentText(segments),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    segments,
    runMode,
    createdAt: Date.now()
  }
}

function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return 'Tool returned no output.'
  if (output && typeof output === 'object' && 'output' in output) {
    const nested = (output as { output: unknown }).output
    return nested === undefined || nested === null ? 'Tool returned no output.' : toolOutputText(nested)
  }
  try {
    const serialized = JSON.stringify(output)
    return serialized ?? 'Tool returned no output.'
  } catch {
    return String(output)
  }
}

function toolOutputMetadata(output: unknown): Record<string, unknown> | undefined {
  if (!output || typeof output !== 'object' || !('metadata' in output)) return undefined
  const metadata = (output as { metadata?: unknown }).metadata
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : undefined
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

function isToolChoiceRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { statusCode?: unknown; message?: unknown }
  if (typeof candidate.statusCode === 'number' && candidate.statusCode !== 400) return false
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return /tool[_\s-]?choice/i.test(message)
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
