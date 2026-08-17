const MAX_TAIL_CHARS = 4096
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
