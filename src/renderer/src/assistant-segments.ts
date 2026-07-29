import type { AssistantSegment, ToolCallInfo } from '@shared/types'

export function appendTextSegment(segments: AssistantSegment[], token: string): AssistantSegment[] {
  if (!token) return segments
  const next = [...segments]
  const last = next[next.length - 1]
  if (last?.type === 'text') {
    next[next.length - 1] = { type: 'text', text: last.text + token }
    return next
  }
  next.push({ type: 'text', text: token })
  return next
}

export function appendToolSegment(segments: AssistantSegment[], toolCall: ToolCallInfo): AssistantSegment[] {
  const next = [...segments]
  const last = next[next.length - 1]
  if (last?.type === 'tools') {
    next[next.length - 1] = { type: 'tools', tools: [...last.tools, toolCall] }
    return next
  }
  next.push({ type: 'tools', tools: [toolCall] })
  return next
}

export function updateToolInSegments(
  segments: AssistantSegment[],
  matcher: (tool: ToolCallInfo) => boolean,
  updater: (tool: ToolCallInfo) => ToolCallInfo
): AssistantSegment[] {
  let matched = false
  return segments.map((segment) => {
    if (segment.type !== 'tools' || matched) return segment
    return {
      type: 'tools',
      tools: segment.tools.map((tool) => {
        if (matched || !matcher(tool)) return tool
        matched = true
        return updater(tool)
      })
    }
  })
}

export function updateRunningToolsInSegments(
  segments: AssistantSegment[],
  updater: (tool: ToolCallInfo) => ToolCallInfo
): AssistantSegment[] {
  return segments.map((segment) => {
    if (segment.type !== 'tools') return segment
    return {
      type: 'tools',
      tools: segment.tools.map((tool) => tool.status === 'running' ? updater(tool) : tool)
    }
  })
}

export function flattenToolCalls(segments: AssistantSegment[]): ToolCallInfo[] {
  return segments.flatMap((segment) => segment.type === 'tools' ? segment.tools : [])
}

export function flattenSegmentText(segments: AssistantSegment[]): string {
  return segments
    .filter((segment): segment is { type: 'text'; text: string } => segment.type === 'text')
    .map((segment) => segment.text)
    .join('')
}

/** Legacy messages only have content + toolCalls; put tools after leading text when possible. */
export function segmentsFromLegacyMessage(content: string, toolCalls?: ToolCallInfo[]): AssistantSegment[] {
  const segments: AssistantSegment[] = []
  if (content) segments.push({ type: 'text', text: content })
  if (toolCalls && toolCalls.length > 0) segments.push({ type: 'tools', tools: toolCalls })
  return segments
}
