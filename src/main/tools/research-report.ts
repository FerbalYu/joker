import { z } from 'zod'
import {
  ResearchReportDraftSchema,
  ResearchReportSchema,
  type ResearchReport
} from '../../shared/research'
import type { ToolDefinition, ToolResult } from './registry'

export const presentResearchReportTool: ToolDefinition = {
  name: 'PresentResearchReport',
  description: 'Submit the final structured research report. Cite only sourceIds returned by successful WebRead calls and quote exact normalized substrings from those pages. Do not include URLs or a sources field; the main process validates citations and injects authoritative source metadata.',
  inputSchema: ResearchReportDraftSchema,
  execute: async (input, context): Promise<ToolResult> => {
    const parsed = ResearchReportDraftSchema.safeParse(input)
    if (!parsed.success) {
      return retryResult('Research report schema validation failed.', parsed.error.issues.map(formatIssue))
    }
    if (!context.researchContext) {
      return retryResult('PresentResearchReport is only available during a research run.', [])
    }

    const validation = context.researchContext.validateReport(parsed.data)
    if (!validation.success) {
      return retryResult('Research report citation validation failed.', validation.errors)
    }

    const normalized = ResearchReportSchema.safeParse({ ...parsed.data, sources: validation.sources })
    if (!normalized.success) {
      return retryResult('Normalized research report validation failed.', normalized.error.issues.map(formatIssue))
    }

    return {
      output: `Research report accepted with ${normalized.data.sections.length} sections and ${normalized.data.sources.length} verified sources.`,
      metadata: { researchReport: normalized.data satisfies ResearchReport }
    }
  }
}

export const researchReportTools: ToolDefinition[] = [presentResearchReportTool]

function retryResult(summary: string, details: readonly string[]): ToolResult {
  const lines = details.slice(0, 20).map((detail) => `- ${detail}`)
  return {
    output: [
      summary,
      ...lines,
      details.length > lines.length ? `- ${details.length - lines.length} more validation errors omitted.` : '',
      'Revise the report and call PresentResearchReport again. Do not invent sourceIds, quotes, or URLs.'
    ].filter(Boolean).join('\n')
  }
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : 'report'
  return `${path}: ${issue.message}`
}
