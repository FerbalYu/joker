import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { GeneratedToolSpecSchema } from '../../shared/generated-tools-schema'
import { getJokerHomeDir } from '../store/paths'
import { hashGeneratedToolSpec, createForgeJob, updateForgeJob } from '../generated-tools/forge-job-store'
import type { ForgeController } from '../generated-tools/forge-service'
import { getDefaultForgeController } from '../generated-tools/forge-service-runtime'
import type { ToolDefinition } from './registry'
import { searchTools } from './tool-search'

export interface BuildToolForgeMetaToolsOptions {
  jokerHome?: string
  builtinTools?: readonly Pick<ToolDefinition, 'name' | 'description'>[]
  now?: () => number
  createId?: () => string
  controller?: ForgeController
  /** @deprecated kept for callers compiled against the former trust gate. */
  loadConfig?: () => unknown
  /** @deprecated kept for callers compiled against the former trust gate. */
  resolveProjectPath?: (projectId: string) => string | null
}

function json(value: unknown): { output: string } {
  return { output: JSON.stringify(value, null, 2) }
}

export function buildToolForgeMetaTools(options: BuildToolForgeMetaToolsOptions = {}): ToolDefinition[] {
  const jokerHome = options.jokerHome ?? getJokerHomeDir()
  const now = options.now ?? Date.now
  const createId = options.createId ?? randomUUID
  const controller = options.controller ?? getDefaultForgeController()
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
        const spec = GeneratedToolSpecSchema.parse(input['spec'])
        const hostBoundSpec = {
          ...spec,
          requestedBy: {
            ...spec.requestedBy,
            sessionId: context.sessionId,
            ...(context.runId ? { runId: context.runId } : {})
          }
        }
        if (!controller) {
          return json({
            toolId: hostBoundSpec.id,
            status: 'blocked',
            blocker: 'forge-service-unavailable',
            reason: 'ToolForge service is unavailable',
            originalTaskComplete: false
          })
        }
        const createdAt = now()
        const id = `forge-${createId()}`.slice(0, 128)
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
        if (!controller.enqueue(job.id)) {
          const failedAt = now()
          const failed = updateForgeJob(jokerHome, job.id, job.revision, (current) => ({
            ...current,
            revision: current.revision + 1,
            status: 'failed',
            updatedAt: Math.max(current.updatedAt, failedAt),
            finishedAt: Math.max(current.updatedAt, failedAt),
            currentPhase: 'enqueue-failed',
            error: 'ToolForge service rejected the queued ForgeJob'
          }))
          return json({
            jobId: failed.id,
            toolId: failed.toolId,
            status: failed.status,
            revision: failed.revision,
            currentPhase: failed.currentPhase,
            error: failed.error,
            originalTaskComplete: false
          })
        }
        return json({ jobId: job.id, toolId: job.toolId, status: job.status, revision: job.revision, originalTaskComplete: false })
      }
    }
  ]
}
