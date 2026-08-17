import type { ChatMessage, ToolCallInfo } from '@shared/types'
import type { ModelMessage } from 'ai'
import { validateChatParts } from '../shared/messages'

export function toModelMessages(messages: unknown[]): ModelMessage[] {
  return messages.flatMap((message) => toModelMessageList(message))
}

function toModelMessageList(message: unknown): ModelMessage[] {
  if (!message || typeof message !== 'object') throw new Error('Invalid message')
  const value = message as Partial<ChatMessage>
  if (typeof value.role !== 'string' || typeof value.content !== 'string') throw new Error('Invalid message')
  if (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'system') throw new Error('Invalid message role')
  if (value.parts !== undefined && !validateChatParts(value.parts)) throw new Error('Invalid image attachment')

  if (value.role === 'assistant') return assistantModelMessages(value)
  if (!value.parts) return [{ role: value.role as 'user' | 'system', content: value.content }]
  const content = value.parts.map((part) => part.type === 'text'
    ? { type: 'text' as const, text: part.text }
    : { type: 'file' as const, data: part.data, mediaType: part.mediaType })
  return [{ role: value.role as 'user', content }]
}

function assistantModelMessages(message: Partial<ChatMessage>): ModelMessage[] {
  const segments = message.segments?.length
    ? message.segments
    : [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.toolCalls?.length ? [{ type: 'tools' as const, tools: message.toolCalls }] : [])
      ]
  const modelMessages: ModelMessage[] = []

  segments.forEach((segment, segmentIndex) => {
    if (segment.type === 'text') {
      if (segment.text) modelMessages.push({ role: 'assistant', content: segment.text })
      return
    }

    const calls = segment.tools.map((tool, toolIndex) => ({
      type: 'tool-call' as const,
      toolCallId: toolCallId(message.id, segmentIndex, toolIndex, tool),
      toolName: tool.toolName,
      input: tool.input
    }))
    if (calls.length > 0) modelMessages.push({ role: 'assistant', content: calls })

    const results = segment.tools.map((tool, toolIndex) => ({
      type: 'tool-result' as const,
      toolCallId: toolCallId(message.id, segmentIndex, toolIndex, tool),
      toolName: tool.toolName,
      output: tool.output === undefined
        ? { type: 'error-text' as const, value: terminalToolError(tool) }
        : tool.status === 'error' || tool.status === 'denied' || tool.status === 'cancelled' || tool.status === 'timed-out'
          ? { type: 'error-text' as const, value: tool.output }
          : { type: 'text' as const, value: tool.output }
    }))
    if (results.length > 0) modelMessages.push({ role: 'tool', content: results })
  })

  return modelMessages
}

function terminalToolError(tool: ToolCallInfo): string {
  return tool.status === 'error'
    ? 'Tool failed before returning a result.'
    : 'Tool execution was interrupted before returning a result.'
}

function toolCallId(
  messageId: string | undefined,
  segmentIndex: number,
  toolIndex: number,
  tool: ToolCallInfo
): string {
  return tool.toolCallId ?? `${messageId ?? 'message'}-${segmentIndex}-${toolIndex}`
}
