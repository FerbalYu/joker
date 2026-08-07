import type { ChatMessage, StreamEvent, ToolCallInfo } from '@shared/types'
import { formatSafeError } from './agent/diagnostics'
import { imageTools } from './tools/image'
import { executeToolDefinition, type ToolContext, type ToolDefinition } from './tools/registry'

export interface ImageGenerationRequest {
  prompt: string
}

const SEPARATED_PREFIXES = [
  '/image',
  '/img',
  '生成图片',
  '生成图像',
  '生成一张图片',
  '生成一张图',
  '生成一幅图片',
  '生成一幅图',
  '画图',
  '画一张图片',
  '画一张图',
  '绘制图片',
  '绘制一张图片',
  'create an image',
  'generate an image',
  'draw an image'
] as const

const DIRECT_PREFIXES = [
  '请帮我画',
  '帮我画',
  '请画',
  '画一个',
  '画一只',
  '画一位',
  '画一幅'
] as const

export function matchImageGenerationRequest(value: string): ImageGenerationRequest | null {
  const text = value.trim()
  if (!text) return null

  for (const prefix of SEPARATED_PREFIXES) {
    if (!text.toLowerCase().startsWith(prefix.toLowerCase())) continue
    const remainder = text.slice(prefix.length)
    if (!/^(?:\s+|[：:，,。]\s*)/.test(remainder)) continue
    const prompt = remainder.replace(/^(?:\s+|[：:，,。]\s*)/, '').trim()
    if (prompt) return { prompt }
  }

  for (const prefix of DIRECT_PREFIXES) {
    if (!text.startsWith(prefix)) continue
    const prompt = text.slice(prefix.length).replace(/^[：:，,。\s]+/, '').trim()
    if (prompt) return { prompt }
  }

  return null
}

export type DirectImageGenerationResult =
  | { status: 'completed' | 'error'; message: ChatMessage }
  | { status: 'aborted'; messageId: string }

export async function runDirectImageGeneration(options: {
  sessionId: string
  runId: string
  prompt: string
  context: ToolContext
  onEvent: (event: StreamEvent) => void | Promise<void>
  tool?: ToolDefinition
}): Promise<DirectImageGenerationResult> {
  const { sessionId, runId, prompt, context, onEvent } = options
  const messageId = crypto.randomUUID()
  const toolCallId = crypto.randomUUID()
  const input = { prompt }

  await onEvent({ type: 'message-start', sessionId, runId, messageId, runMode: 'chat' })
  await onEvent({
    type: 'tool-call',
    sessionId,
    runId,
    toolCallId,
    toolName: 'GenerateImage',
    input
  })

  try {
    const tool = options.tool ?? imageTools[0]
    if (!tool) throw new Error('GenerateImage tool is unavailable')
    const result = await executeToolDefinition(tool, input, context)
    await onEvent({
      type: 'tool-result',
      sessionId,
      runId,
      toolCallId,
      toolName: 'GenerateImage',
      output: result.output,
      metadata: result.metadata
    })
    return {
      status: 'completed',
      message: directImageMessage(messageId, {
        toolCallId,
        toolName: 'GenerateImage',
        input,
        output: result.output,
        metadata: result.metadata,
        status: 'done'
      })
    }
  } catch (error) {
    if (context.abortSignal?.aborted) {
      await emitSafely(onEvent, { type: 'abort', sessionId, runId })
      return { status: 'aborted', messageId }
    }
    const safeError = formatSafeError(error)
    await emitSafely(onEvent, {
      type: 'tool-error',
      sessionId,
      runId,
      toolCallId,
      toolName: 'GenerateImage',
      error: safeError
    })
    return {
      status: 'error',
      message: directImageMessage(messageId, {
        toolCallId,
        toolName: 'GenerateImage',
        input,
        output: safeError,
        status: 'error'
      })
    }
  }
}

function directImageMessage(messageId: string, toolCall: ToolCallInfo): ChatMessage {
  return {
    id: messageId,
    role: 'assistant',
    content: '',
    toolCalls: [toolCall],
    segments: [{ type: 'tools', tools: [toolCall] }],
    runMode: 'chat',
    createdAt: Date.now()
  }
}

async function emitSafely(
  onEvent: (event: StreamEvent) => void | Promise<void>,
  event: StreamEvent
): Promise<void> {
  try {
    await onEvent(event)
  } catch (error) {
    console.error('Failed to emit direct image stream event', error)
  }
}
