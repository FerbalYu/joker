import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { ToolContext, ToolDefinition, ToolResult } from '../tools/registry'
import { sealGeneratedToolCandidate } from './candidate-store'
import { readForgeJob } from './forge-job-store'
import { ForgeWorkspaceBroker, type ForgeCheckResult } from './forge-workspace'

export const FORGE_AGENT_TOOL_NAMES = [
  'ForgeReadSpec',
  'ForgeListFiles',
  'ForgeReadFile',
  'ForgeWriteFile',
  'ForgeApplyPatch',
  'ForgeRunCheck',
  'ForgeReadCheckResult',
  'ForgeSubmitCandidate'
] as const

interface ForgeToolState {
  latestCheck?: ForgeCheckResult
}

export interface BuildForgeAgentToolsOptions {
  jokerHome: string
  jobId: string
  validationPlan?: import('../../shared/generated-tools').GeneratedToolValidationPlan
  validationPlanHash?: string
  /** @deprecated legacy suite identity accepted for existing callers. */
  validationSuiteId?: string
  validationSuiteHash?: string
  now?: () => number
  createValidationRunId?: () => string
}

function jsonResult(value: unknown): ToolResult {
  return { output: JSON.stringify(value, null, 2) }
}

export function buildForgeAgentTools(options: BuildForgeAgentToolsOptions): ToolDefinition[] {
  const state: ForgeToolState = {}
  const broker = (): ForgeWorkspaceBroker => new ForgeWorkspaceBroker(options.jokerHome, options.jobId)
  const contextFree = (execute: (input: Record<string, unknown>) => ToolResult | Promise<ToolResult>): ToolDefinition['execute'] =>
    async (input, _context: ToolContext) => execute(input)

  return [
    {
      name: 'ForgeReadSpec',
      description: 'Read the immutable GeneratedToolSpec for this ForgeJob.',
      inputSchema: z.object({}).strict(),
      risk: 'read',
      execute: contextFree(() => jsonResult(broker().readSpec()))
    },
    {
      name: 'ForgeListFiles',
      description: 'List files in this job-scoped Forge workspace.',
      inputSchema: z.object({}).strict(),
      risk: 'read',
      execute: contextFree(() => jsonResult(broker().listFiles()))
    },
    {
      name: 'ForgeReadFile',
      description: 'Read one UTF-8 file inside this job-scoped Forge workspace.',
      inputSchema: z.object({ path: z.string().min(1).max(512) }).strict(),
      risk: 'read',
      execute: contextFree((input) => ({ output: broker().readFile(input['path'] as string) }))
    },
    {
      name: 'ForgeWriteFile',
      description: 'Write one bounded UTF-8 source, manifest, test, or documentation file inside this job-scoped Forge workspace.',
      inputSchema: z.object({ path: z.string().min(1).max(512), content: z.string().max(1024 * 1024) }).strict(),
      risk: 'write_local',
      execute: contextFree((input) => jsonResult(broker().writeFile(input['path'] as string, input['content'] as string)))
    },
    {
      name: 'ForgeApplyPatch',
      description: 'Replace one exact, unique text fragment in a job-scoped Forge file.',
      inputSchema: z.object({
        path: z.string().min(1).max(512),
        expected: z.string().min(1).max(1024 * 1024),
        replacement: z.string().max(1024 * 1024)
      }).strict(),
      risk: 'write_local',
      execute: contextFree((input) => jsonResult(broker().applyPatch(
        input['path'] as string,
        input['expected'] as string,
        input['replacement'] as string
      )))
    },
    {
      name: 'ForgeRunCheck',
      description: 'Run the host-owned deterministic artifact structure check. This cannot validate or trust the candidate.',
      inputSchema: z.object({}).strict(),
      risk: 'read',
      execute: contextFree(() => {
        state.latestCheck = broker().runCheck()
        return jsonResult(state.latestCheck)
      })
    },
    {
      name: 'ForgeReadCheckResult',
      description: 'Read the latest host-owned check result for this ForgeAgent run.',
      inputSchema: z.object({}).strict(),
      risk: 'read',
      execute: contextFree(() => jsonResult(state.latestCheck ?? null))
    },
    {
      name: 'ForgeSubmitCandidate',
      description: 'Seal the current workspace into one immutable untrusted candidate and transition the job to validating. This does not validate, trust, register, promote, or activate the Tool.',
      inputSchema: z.object({ expectedRevision: z.number().int().nonnegative() }).strict(),
      risk: 'write_local',
      execute: contextFree((input) => {
        const current = readForgeJob(options.jokerHome, options.jobId)
        if (!current) throw new Error(`ForgeJob not found: ${options.jobId}`)
        const sealed = sealGeneratedToolCandidate({
          jokerHome: options.jokerHome,
          jobId: options.jobId,
          expectedRevision: input['expectedRevision'] as number | undefined ?? current.revision,
          validationPlan: options.validationPlan,
          validationPlanHash: options.validationPlanHash,
          createdAt: (options.now ?? Date.now)(),
          validationRunId: (options.createValidationRunId ?? randomUUID)()
        })
        return jsonResult({
          jobId: sealed.job.id,
          status: sealed.job.status,
          revision: sealed.job.revision,
          candidateId: sealed.candidate.id,
          candidateFingerprint: sealed.candidate.artifactFingerprint,
          attempt: sealed.candidate.attempt,
          validationProfile: sealed.candidate.validationProfile,
          trusted: false,
          registered: false,
          active: false
        })
      })
    }
  ]
}

export function getForgeAgentToolNames(): string[] {
  return [...FORGE_AGENT_TOOL_NAMES]
}
