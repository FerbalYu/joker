const MAX_TAIL_CHARS = 4096
const TOOL_REPEAT_THRESHOLDS = new Set([3, 5])
const TOOL_ARGUMENT_PREVIEW_CHARS = 500

export const TOOL_REPEAT_GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.'

export interface ToolRepeatObservation {
  count: number
  reminder?: string
}

export class ToolCallRepetitionGuard {
  private key: string | undefined
  private count = 0

  observe(toolName: string, input: unknown): ToolRepeatObservation {
    const canonicalArguments = canonicalizeJson(input)
    const nextKey = JSON.stringify([toolName, canonicalArguments])
    this.count = this.key === nextKey ? this.count + 1 : 1
    this.key = nextKey
    if (!TOOL_REPEAT_THRESHOLDS.has(this.count)) return { count: this.count }
    if (this.count === 3) return { count: this.count, reminder: TOOL_REPEAT_GENTLE_REMINDER }
    const preview = canonicalArguments.length <= TOOL_ARGUMENT_PREVIEW_CHARS
      ? canonicalArguments
      : `${canonicalArguments.slice(0, TOOL_ARGUMENT_PREVIEW_CHARS)}… (+${canonicalArguments.length - TOOL_ARGUMENT_PREVIEW_CHARS} more chars)`
    return {
      count: this.count,
      reminder: [
        'Repeated tool call detected:',
        `- tool: ${toolName}`,
        `- consecutive_calls: ${this.count}`,
        `- arguments: ${preview}`,
        'The repeated calls are not making progress. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.'
      ].join('\n')
    }
  }
}

function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}
const MAX_UNITS = 32
const MAX_PATTERN_UNITS = 4
const MIN_REPETITIONS = 3
const MAX_REPETITIONS = 8
const MIN_REPEATED_CHARS = 24

export const REPETITION_LOOP_ERROR = 'Model output was stopped because it entered a repetition loop'
export const REPETITION_LOOP_NOTICE = '\n\n> 检测到重复输出，已自动停止。'

export interface RepetitionLoopMatch {
  pattern: string[]
  repetitions: number
  /** Character offset in the original value where the repeated suffix begins. */
  truncateAt: number
}

export function detectRepetitionLoop(value: string): RepetitionLoopMatch | null {
  const tail = value.length > MAX_TAIL_CHARS ? value.slice(-MAX_TAIL_CHARS) : value
  const tailOffset = value.length - tail.length
  const units = completedUnits(tail).slice(-MAX_UNITS)
  for (let patternSize = 1; patternSize <= MAX_PATTERN_UNITS; patternSize += 1) {
    for (let repetitions = MIN_REPETITIONS; repetitions <= MAX_REPETITIONS; repetitions += 1) {
      const required = patternSize * repetitions
      if (units.length < required) continue
      const suffix = units.slice(-required)
      const pattern = suffix.slice(0, patternSize).map((unit) => unit.text)
      const repeatedChars = pattern.join('').length * repetitions
      if (repeatedChars < MIN_REPEATED_CHARS) continue
      if (suffix.every((unit, index) => unit.text === pattern[index % patternSize])) {
        return { pattern, repetitions, truncateAt: tailOffset + units[units.length - required].start }
      }
    }
  }
  return null
}

function completedUnits(value: string): Array<{ text: string; start: number }> {
  const result: Array<{ text: string; start: number }> = []
  for (const match of value.matchAll(/[^。！？.!?\r\n]+(?:[。！？.!?]+|\r?\n)/gu)) {
    const text = normalizeUnit(match[0])
    if (text && match.index !== undefined) result.push({ text, start: match.index })
  }
  return result
}

function normalizeUnit(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}
