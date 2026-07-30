import type { ToolCallInfo } from '@shared/types'
import { ResearchReportSchema, type ResearchReport } from '../../shared/research'

export const DETAIL_ONLY_TOOL_NAMES = new Set(['TodoWrite'])
export const REPORT_ARTIFACT_TOOL_NAMES = new Set(['PresentResearchReport'])

export interface ResearchReportArtifact {
  toolCall: ToolCallInfo
  report: ResearchReport | null
  error: string | null
}

export function extractResearchReports(toolCalls: ToolCallInfo[]): ResearchReportArtifact[] {
  return toolCalls
    .filter((toolCall) => REPORT_ARTIFACT_TOOL_NAMES.has(toolCall.toolName))
    .map((toolCall) => {
      const parsed = ResearchReportSchema.safeParse(toolCall.metadata?.researchReport)
      return {
        toolCall,
        report: parsed.success ? parsed.data : null,
        error: parsed.success ? null : 'invalid-research-report'
      }
    })
}

export function visibleChatTools(toolCalls: ToolCallInfo[]): ToolCallInfo[] {
  return toolCalls.filter((toolCall) =>
    !DETAIL_ONLY_TOOL_NAMES.has(toolCall.toolName) &&
    !REPORT_ARTIFACT_TOOL_NAMES.has(toolCall.toolName)
  )
}
