import { createHash, randomUUID } from 'node:crypto'

import type { GeneratedToolEditResult } from '../../shared/generated-tools-management'
import { parseGeneratedToolEditRequest } from '../../shared/generated-tools-management'
import { readGeneratedToolRegistry } from './registry'
import { readGeneratedToolVersion } from './version-store'
import { createForgeJob, hashGeneratedToolSpec } from './forge-job-store'
import type { ForgeController } from './forge-service'
import { assertToolForgeId } from './paths'

export interface GeneratedToolEditServiceOptions {
  jokerHome: string
  controller?: ForgeController
  now?: () => number
  createId?: () => string
}

function fail(message: string): never {
  throw new Error(message)
}

export class GeneratedToolEditService {
  private readonly now: () => number
  private readonly createId: () => string

  constructor(private readonly options: GeneratedToolEditServiceOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  start(input: unknown, sessionId: string, runId?: string): GeneratedToolEditResult {
    try {
      const request = parseGeneratedToolEditRequest(input)
      const toolId = assertToolForgeId(request.toolId, 'tool id')
      const registry = readGeneratedToolRegistry(this.options.jokerHome)
      const entry = registry.entries.find((item) => item.toolId === toolId)
      if (!entry) fail('Generated Tool was not found')
      const pointer = registry.activePointers.find((item) => item.toolId === toolId)
      if (!pointer?.activeVersionId) fail('Generated Tool has no active stable version')
      if (pointer.activeVersionId !== request.baseVersionId) fail('Generated Tool edit base version is stale')
      const base = readGeneratedToolVersion(this.options.jokerHome, toolId, request.baseVersionId)
      if (base.fingerprint !== request.baseFingerprint) fail('Generated Tool edit base fingerprint is stale')
      if (base.trustState !== 'trusted') fail('Generated Tool edit base version is not trusted')

      const createdAt = this.now()
      const jobId = `forge-${this.createId()}`.slice(0, 128)
      const spec = {
        id: toolId,
        displayName: base.manifest.displayName,
        goal: base.manifest.description,
        reason: request.instruction,
        requestedBy: { sessionId, runId: runId ?? `edit-run-${jobId}`, userMessageId: `edit-${jobId}` },
        scope: entry.descriptor.scope,
        ...(entry.descriptor.projectId ? { projectId: entry.descriptor.projectId } : {}),
        inputContract: base.manifest.inputSchema,
        outputContract: base.manifest.outputSchema,
        permissions: base.manifest.permissions,
        acceptance: ['Preserve the existing contract unless the edit explicitly changes it.', `Apply this requested edit: ${request.instruction}`],
        examples: [{ input: {}, expected: 'See the existing tool contract.' }]
      }
      const job = createForgeJob(this.options.jokerHome, {
        id: jobId,
        idempotencyKey: `edit-${toolId}-${request.baseVersionId}-${createHash('sha256').update(request.instruction).digest('hex').slice(0, 24)}`,
        specHash: hashGeneratedToolSpec(spec),
        toolId,
        baseVersionId: request.baseVersionId,
        baseFingerprint: request.baseFingerprint,
        mode: 'edit',
        status: 'queued',
        revision: 0,
        spec,
        attempt: 1,
        maxAttempts: 3,
        createdAt,
        updatedAt: createdAt,
        artifactPath: `jobs/${jobId}/workspace`
      })
      this.options.controller?.enqueue(job.id)
      return { success: true, data: { jobId: job.id, toolId, baseVersionId: request.baseVersionId, baseFingerprint: request.baseFingerprint, status: job.status, revision: job.revision, originalTaskComplete: false } }
    } catch (error) {
      return { success: false, error: { code: 'read-failed', message: error instanceof Error ? error.message : 'Generated Tool edit failed' } }
    }
  }
}
