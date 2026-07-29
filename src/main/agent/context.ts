import { generateText, type ModelMessage } from 'ai'
import { createLanguageModel } from '../providers'
import { loadConfig, resolveActiveModel } from '../store/config'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../shared/types'

const KEEP_RECENT = 10
const COMPRESSION_SAFETY_RESERVE = 4096

export interface CompressContextOptions {
  maxContextTokens?: number
  outputTokenReserve?: number
}

export function estimateMessageTokens(message: ModelMessage): number {
  if (typeof message.content === 'string') return Math.max(1, Math.ceil(message.content.length / 4))
  return message.content.reduce((total, part) => {
    if (part.type === 'text') return total + Math.max(1, Math.ceil(part.text.length / 4))
    return total + 256
  }, 0)
}

export function estimateContextTokens(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

function redactMessageForSummary(message: ModelMessage): ModelMessage {
  if (typeof message.content === 'string') return message
  return {
    ...message,
    content: message.content.map((part) => part.type === 'text' ? part : { type: 'text' as const, text: '[image attachment]' })
  } as ModelMessage
}

export async function compressContext(messages: ModelMessage[], options: CompressContextOptions = {}): Promise<ModelMessage[]> {
  const maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
  const outputTokenReserve = options.outputTokenReserve ?? 8192
  const threshold = Math.max(1, maxContextTokens - outputTokenReserve - COMPRESSION_SAFETY_RESERVE)
  if (estimateContextTokens(messages) < threshold) return messages

  const toSummarize = messages.slice(0, Math.max(1, messages.length - KEEP_RECENT))
  const recent = messages.slice(Math.max(0, messages.length - KEEP_RECENT))
  try {
    const model = createLanguageModel(resolveActiveModel(loadConfig()))
    const { text } = await generateText({
      model,
      system: 'Summarize the following conversation concisely, preserving key decisions, file paths, code snippets, and context needed to continue the work.',
      maxOutputTokens: 2048,
      messages: toSummarize.map(redactMessageForSummary)
    })
    return [{ role: 'system', content: `Previous conversation summary:\n${text}` }, ...recent]
  } catch {
    return messages
  }
}
