export interface EditDiffPreview {
  text: string
  additions: number
  deletions: number
}

const DIFF_CONTEXT_LINES = 2

export function getEditDiffPreview(
  metadata: Record<string, unknown> | undefined
): EditDiffPreview {
  const diff = typeof metadata?.diff === 'string' ? metadata.diff : ''
  const lines = diff ? diff.split('\n') : []
  const inferredAdditions = countChangedLines(lines, '+')
  const inferredDeletions = countChangedLines(lines, '-')

  return {
    text: isStructuredDiff(lines) ? diff : cropLegacyDiff(lines),
    additions: metadataCount(metadata?.additions) ?? inferredAdditions,
    deletions: metadataCount(metadata?.deletions) ?? inferredDeletions
  }
}

function metadataCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}

function countChangedLines(lines: string[], prefix: '+' | '-'): number {
  return lines.filter((line) => line.startsWith(prefix) && !isDiffFileHeader(line)).length
}

function isStructuredDiff(lines: string[]): boolean {
  return lines.some((line) => line.startsWith('@@ '))
}

function cropLegacyDiff(lines: string[]): string {
  if (lines.length === 0) return ''

  const changedIndexes = lines.flatMap((line, index) => isChangedLine(line) ? [index] : [])
  if (changedIndexes.length === 0) return lines.join('\n')

  const ranges = changedIndexes
    .map((index) => ({
      start: Math.max(0, index - DIFF_CONTEXT_LINES),
      end: Math.min(lines.length - 1, index + DIFF_CONTEXT_LINES)
    }))
    .reduce<Array<{ start: number; end: number }>>((merged, range) => {
      const previous = merged.at(-1)
      if (previous && range.start <= previous.end + 1) {
        previous.end = Math.max(previous.end, range.end)
      } else {
        merged.push({ ...range })
      }
      return merged
    }, [])

  const output: string[] = []
  ranges.forEach((range, index) => {
    const previous = ranges[index - 1]
    if ((index === 0 && range.start > 0) || (previous && range.start > previous.end + 1)) {
      output.push('…')
    }
    output.push(...lines.slice(range.start, range.end + 1))
  })

  const finalRange = ranges.at(-1)
  if (finalRange && finalRange.end < lines.length - 1) output.push('…')
  return output.join('\n')
}

function isChangedLine(line: string): boolean {
  return (line.startsWith('+') || line.startsWith('-')) && !isDiffFileHeader(line)
}

function isDiffFileHeader(line: string): boolean {
  return /^(---|\+\+\+) /.test(line)
}
