import type { ChatMessage, RunMode, ToolCallInfo } from '@shared/types'
import { ResearchReportSchema } from '../../shared/research'

export type ResearchProgressStage = 'planning' | 'searching' | 'reading' | 'synthesizing' | 'completed' | 'stopped' | 'error'

export interface ResearchProgress {
  stage: ResearchProgressStage
  searchCount: number
  readCount: number
}

export function deriveResearchProgress(
  toolCalls: ToolCallInfo[],
  messages: ChatMessage[] = [],
  streaming = false,
  streamRunMode: RunMode | null = null
): ResearchProgress | null {
  const historicalResearch = [...messages].reverse().find((message) => message.runMode === 'research')
  const isResearch = streamRunMode === 'research' || historicalResearch !== undefined
  if (!isResearch) return null

  const historicalTools = historicalResearch ? messageTools(historicalResearch) : []
  const tools = streamRunMode === 'research' ? toolCalls : historicalTools
  const searchCount = tools.filter((tool) => tool.toolName === 'WebSearch' && tool.status === 'done').length
  const readCount = tools.filter((tool) => tool.toolName === 'WebRead' && tool.status === 'done').length

  if (tools.some((tool) => tool.status === 'error')) return { stage: 'error', searchCount, readCount }
  if (tools.some((tool) => tool.toolName === 'PresentResearchReport' && tool.status === 'done' && ResearchReportSchema.safeParse(tool.metadata?.researchReport).success)) return { stage: 'completed', searchCount, readCount }
  if (!streaming && tools.some((tool) => ['proposed', 'awaiting-approval', 'running'].includes(tool.status))) return { stage: 'stopped', searchCount, readCount }
  if (tools.some((tool) => tool.toolName === 'PresentResearchReport')) return { stage: 'synthesizing', searchCount, readCount }
  if (tools.some((tool) => tool.toolName === 'WebRead')) return { stage: 'reading', searchCount, readCount }
  if (tools.some((tool) => tool.toolName === 'WebSearch')) return { stage: 'searching', searchCount, readCount }
  if (streaming) return { stage: 'planning', searchCount, readCount }
  return { stage: 'stopped', searchCount, readCount }
}

function messageTools(message: ChatMessage): ToolCallInfo[] {
  return message.segments?.flatMap((segment) => segment.type === 'tools' ? segment.tools : []) ?? message.toolCalls ?? []
}
