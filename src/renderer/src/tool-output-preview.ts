import type { Language } from './i18n'

const DEFAULT_MAX_OUTPUT_CHARS = 2000
export const READ_PREVIEW_LINES = 20

export interface ToolOutputPreview {
  text: string
  truncated: boolean
  shownLines?: number
  totalLines?: number
}

export function getToolOutputPreview(
  toolName: string,
  output: string,
  language: Language,
  maxChars = DEFAULT_MAX_OUTPUT_CHARS
): ToolOutputPreview {
  if (toolName === 'Read') return getReadOutputPreview(output, language)
  if (output.length <= maxChars) return { text: output, truncated: false }
  return {
    text: `${output.slice(0, maxChars)}\n${language === 'zh' ? '... [已截断]' : '... [truncated]'}`,
    truncated: true
  }
}

function getReadOutputPreview(output: string, language: Language): ToolOutputPreview {
  const lines = output.split('\n')
  const totalLines = lines.length
  if (totalLines <= READ_PREVIEW_LINES) {
    return { text: output, truncated: false, shownLines: totalLines, totalLines }
  }

  const shownLines = READ_PREVIEW_LINES
  const notice = language === 'zh'
    ? `... [仅显示前 ${shownLines} 行，共 ${totalLines} 行]`
    : `... [showing the first ${shownLines} of ${totalLines} lines]`
  return {
    text: `${lines.slice(0, shownLines).join('\n')}\n${notice}`,
    truncated: true,
    shownLines,
    totalLines
  }
}
