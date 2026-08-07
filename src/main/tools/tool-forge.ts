import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { GeneratedToolSpecSchema } from '../../shared/generated-tools-schema'
import { readEffectiveRuntimeQualificationReport } from '../generated-tools/qualification'
import { readQualificationOperation } from '../generated-tools/qualification-operation-store'
import { getJokerHomeDir } from '../store/paths'
import { hashGeneratedToolSpec, createForgeJob, readForgeJob, updateForgeJob } from '../generated-tools/forge-job-store'
import type { ForgeController } from '../generated-tools/forge-service'
import { getDefaultForgeController, getDefaultPromotionService } from '../generated-tools/forge-service-runtime'
import { readGeneratedToolRegistry } from '../generated-tools/registry'
import type { ToolDefinition } from './registry'
import { searchTools } from './tool-search'

export interface BuildToolForgeMetaToolsOptions {
  jokerHome?: string
  builtinTools?: readonly Pick<ToolDefinition, 'name' | 'description'>[]
  now?: () => number
  createId?: () => string
  controller?: ForgeController
  promotionService?: ReturnType<typeof getDefaultPromotionService>
}

function json(value: unknown): { output: string } {
  return { output: JSON.stringify(value, null, 2) }
}

export function buildToolForgeMetaTools(options: BuildToolForgeMetaToolsOptions = {}): ToolDefinition[] {
  const jokerHome = options.jokerHome ?? getJokerHomeDir()
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const controller = options.controller ?? getDefaultForgeController()
  const promotionService = options.promotionService ?? getDefaultPromotionService()
  return [
    {
      name: 'ToolSearch',
      description: 'Search builtin, connected MCP, Generated Tools, and in-progress ForgeJobs before manufacturing a new capability. Returns exact, compatible, building, unavailable, or missing.',
      inputSchema: z.object({ query: z.string().trim().min(1).max(500) }).strict(),
      risk: 'read',
      execute: async (input) => {
        const results = searchTools(input['query'] as string, { jokerHome, builtinTools: options.builtinTools })
        return json({ match: results.length > 0 ? results[0].match : 'missing', results })
      }
    },
    {
      name: 'ToolForgeStart',
      description: 'Create a durable queued ForgeJob after ToolSearch found no existing capability. Manufacturing does not complete the original task.',
      inputSchema: z.object({
        idempotencyKey: z.string().trim().min(1).max(256),
        mode: z.enum(['create', 'edit', 'repair']).default('create'),
        baseVersionId: z.string().trim().min(1).max(128).optional(),
        maxAttempts: z.number().int().min(1).max(3).default(3),
        spec: GeneratedToolSpecSchema
      }).strict(),
      risk: 'write_local',
      execute: async (input, context) => {
        const qualificationOperation = readQualificationOperation(jokerHome)
        const runtimeLevel = readEffectiveRuntimeQualificationReport(jokerHome)?.level ?? 'L0'
        if (!['L1', 'L2'].includes(runtimeLevel)) {
          return json({
            status: 'blocked',
            blocker: 'runtime-qualification',
            qualificationStatus: qualificationOperation?.status ?? 'missing',
            qualificationPhase: qualificationOperation?.phase,
            nextAction: 'verify-toolforge',
            originalTaskComplete: false
          })
        }
        const spec = GeneratedToolSpecSchema.parse(input['spec'])
        const createdAt = now()
        const id = `forge-${createId()}`.slice(0, 128)
        const hostBoundSpec = {
          ...spec,
          requestedBy: {
            ...spec.requestedBy,
            sessionId: context.sessionId,
            ...(context.runId ? { runId: context.runId } : {})
          }
        }
        const existing = searchTools(hostBoundSpec.id, { jokerHome, builtinTools: options.builtinTools })
          .filter((item) => item.match === 'exact' || item.match === 'building')
        if ((input['mode'] as string) === 'create' && existing.length > 0) {
          throw new Error('ToolForgeStart refused duplicate capability; use the existing tool or edit its stable identity')
        }
        const job = createForgeJob(jokerHome, {
          id,
          idempotencyKey: input['idempotencyKey'] as string,
          specHash: hashGeneratedToolSpec(hostBoundSpec),
          toolId: hostBoundSpec.id,
          ...(input['baseVersionId'] ? { baseVersionId: input['baseVersionId'] as string } : {}),
          mode: input['mode'] as 'create' | 'edit' | 'repair',
          status: 'queued',
          revision: 0,
          spec: hostBoundSpec,
          attempt: 1,
          maxAttempts: input['maxAttempts'] as number,
          createdAt,
          updatedAt: createdAt,
          artifactPath: `jobs/${id}/workspace`
        })
        controller?.enqueue(job.id)
        return json({ jobId: job.id, toolId: job.toolId, status: job.status, revision: job.revision, originalTaskComplete: false })
      }
    },
    {
      name: 'ToolForgeStatus',
      description: 'Read the authoritative durable status of one ForgeJob.',
      inputSchema: z.object({ jobId: z.string().trim().min(1).max(128) }).strict(),
      risk: 'read',
      execute: async (input) => {
        const job = readForgeJob(jokerHome, input['jobId'] as string)
        if (!job) throw new Error('ForgeJob not found')
        const registry = readGeneratedToolRegistry(jokerHome)
        return json({
          jobId: job.id,
          toolId: job.toolId,
          status: job.status,
          jobRevision: job.revision,
          registryRevision: registry.revision,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
          candidateId: job.candidateId,
          candidateFingerprint: job.candidateFingerprint,
          validationReportId: job.validationReportId,
          originalTaskComplete: false
        })
      }
    },
    {
      name: 'ToolPromote',
      description: 'Promote a passed immutable Generated Tool candidate only after host policy and approval checks. Promotion changes capabilityRevision; it does not by itself complete the original task.',
      inputSchema: z.object({
        jobId: z.string().trim().min(1).max(128),
        expectedJobRevision: z.number().int().nonnegative(),
        registryRevision: z.number().int().nonnegative(),
        expectedCandidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        promotionId: z.string().trim().min(1).max(128).optional()
      }).strict(),
      risk: 'write_local',
      execute: async (input, context) => {
        if (!promotionService) throw new Error('ToolForge promotion service is unavailable')
        const result = await promotionService.promote({
          jobId: input['jobId'] as string,
          expectedJobRevision: input['expectedJobRevision'] as number,
          registryRevision: input['registryRevision'] as number,
          expectedCandidateFingerprint: input['expectedCandidateFingerprint'] as string,
          ...(input['promotionId'] ? { promotionId: input['promotionId'] as string } : {}),
          ...(context.hostApprovalGrant ? { approvalGrant: context.hostApprovalGrant } : {}),
          ...(context.requestHostApproval ? { requestApproval: context.requestHostApproval } : {})
        })
        return json({
          jobId: result.job.id,
          toolId: result.job.toolId,
          status: result.job.status,
          jobRevision: result.job.revision,
          action: result.action,
          reason: result.reason,
          promotionId: result.journal.id,
          phase: result.journal.phase,
          versionId: result.versionId,
          capabilityRevision: result.capabilityRevision,
          originalTaskComplete: false
        })
      }
    },
    {
      name: 'ToolForgeCancel',
      description: 'Durably cancel a non-terminal ForgeJob. Cancellation never claims the original task completed.',
      inputSchema: z.object({ jobId: z.string().trim().min(1).max(128), expectedRevision: z.number().int().nonnegative() }).strict(),
      risk: 'write_local',
      execute: async (input) => {
        const job = controller
          ? await controller.cancel(input['jobId'] as string, input['expectedRevision'] as number)
          : updateForgeJob(jokerHome, input['jobId'] as string, input['expectedRevision'] as number, (current) => {
              const cancelledAt = now()
              return {
                ...current,
                revision: current.revision + 1,
                status: 'cancelled',
                updatedAt: Math.max(current.updatedAt, cancelledAt),
                finishedAt: Math.max(current.updatedAt, cancelledAt),
                candidateId: undefined,
                candidateFingerprint: undefined,
                attemptRecordId: undefined,
                validationRunId: undefined,
                validationReportId: undefined,
                error: 'cancelled-by-user'
              }
            })
        return json({ jobId: job.id, toolId: job.toolId, status: job.status, revision: job.revision, originalTaskComplete: false })
      }
    }
  ]
}
