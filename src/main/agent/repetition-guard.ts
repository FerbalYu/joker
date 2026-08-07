const MAX_TAIL_CHARS = 4096
const MAX_UNITS = 32
const MAX_PATTERN_UNITS = 4
const MIN_REPETITIONS = 4
const MAX_REPETITIONS = 8
const MIN_REPEATED_CHARS = 24

export const REPETITION_LOOP_ERROR = 'Model output was stopped because it entered a repetition loop'
export const REPETITION_LOOP_NOTICE = '\n\n> ⚠️ JOKER 已自动停止：检测到模型输出陷入重复循环。请重试，或切换模型后继续。'

export interface RepetitionLoopMatch {
  pattern: string[]
  repetitions: number
}

export function detectRepetitionLoop(value: string): RepetitionLoopMatch | null {
  const units = completedUnits(value.slice(-MAX_TAIL_CHARS)).slice(-MAX_UNITS)
  for (let patternSize = 1; patternSize <= MAX_PATTERN_UNITS; patternSize += 1) {
    for (let repetitions = MIN_REPETITIONS; repetitions <= MAX_REPETITIONS; repetitions += 1) {
      const required = patternSize * repetitions
      if (units.length < required) continue
      const suffix = units.slice(-required)
      const pattern = suffix.slice(0, patternSize)
      const repeatedChars = pattern.join('').length * repetitions
      if (repeatedChars < MIN_REPEATED_CHARS) continue
      if (suffix.every((unit, index) => unit === pattern[index % patternSize])) {
        return { pattern, repetitions }
      }
    }
  }
  return null
}

function completedUnits(value: string): string[] {
  return [...value.matchAll(/[^。！？.!?\r\n]+(?:[。！？.!?]+|\r?\n)/gu)]
    .map((match) => normalizeUnit(match[0]))
    .filter(Boolean)
}

function normalizeUnit(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}
