import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GeneratedToolEditResult } from '../../shared/generated-tools-management'
import { parseGeneratedToolEditRequest } from '../../shared/generated-tools-management'
import { GeneratedToolValidationReportSchema } from '../../shared/generated-tools-schema'
import { hasToolForgeFullTrust, loadConfig } from '../store/config'
import { resolveProjectPath } from '../store/projects'
import { generatedToolsRoot } from './store'
import { readGeneratedToolRegistry } from './registry'
import { readGeneratedToolVersion } from './version-store'
import { preflightGeneratedToolSpec } from './forge-preflight'
import { createForgeJob, hashGeneratedToolSpec, updateForgeJob } from './forge-job-store'
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

function validationProfileForVersion(jokerHome: string, toolId: string, versionId: string): 'gate2-project-read-v1' | 'user-owned-full-trust-v1' {
  const version = readGeneratedToolVersion(jokerHome, toolId, versionId)
  const reportPath = join(generatedToolsRoot(jokerHome), ...version.artifactPath.split('/'), 'validation-report.json')
  const report = GeneratedToolValidationReportSchema.parse(JSON.parse(readFileSync(reportPath, 'utf8')))
  if (report.validationProfile === 'user-owned-full-trust-v1') return report.validationProfile
  if (report.validationProfile === 'gate2-project-read-v1') return report.validationProfile
  if (version.manifest.runtime.id === 'quickjs-wasm') return 'gate2-project-read-v1'
  fail('Generated Tool validation profile is missing or unsupported')
}

function assertFullTrustEditEligibility(projectId: string | undefined): void {
  if (!projectId) fail('user-owned-full-trust-v1 requires a project-scoped tool')
  const workspacePath = resolveProjectPath(projectId)
  if (!workspacePath || !hasToolForgeFullTrust(loadConfig(), workspacePath)) {
    fail('user-owned-full-trust-v1 requires an active workspace full-trust grant')
  }
}

function fullTrustPreflightOptions(projectId: string | undefined): Parameters<typeof preflightGeneratedToolSpec>[1] {
  if (!projectId) return {}
  const workspacePath = resolveProjectPath(projectId)
  return {
    workspacePath,
    projectWorkspacePath: workspacePath,
    workspaceFullTrustGranted: Boolean(workspacePath && hasToolForgeFullTrust(loadConfig(), workspacePath))
  }
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
      const validationProfile = validationProfileForVersion(this.options.jokerHome, toolId, request.baseVersionId)
      if (validationProfile === 'user-owned-full-trust-v1') {
        assertFullTrustEditEligibility(entry.descriptor.projectId)
      }

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
        validationProfile,
        acceptance: ['Preserve the existing contract unless the edit explicitly changes it.', `Apply this requested edit: ${request.instruction}`],
        examples: [{ input: {}, expected: 'See the existing tool contract.' }]
      }
      const preflight = preflightGeneratedToolSpec(spec, fullTrustPreflightOptions(entry.descriptor.projectId))
      if (!preflight.ok) fail(`${preflight.blocker}: ${preflight.reason}`)
      if (!this.options.controller) fail('ToolForge service is unavailable')
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
      if (!this.options.controller.enqueue(job.id)) {
        const failedAt = this.now()
        updateForgeJob(this.options.jokerHome, job.id, job.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          status: 'failed',
          updatedAt: Math.max(current.updatedAt, failedAt),
          finishedAt: Math.max(current.updatedAt, failedAt),
          currentPhase: 'enqueue-failed',
          error: 'ToolForge service rejected the queued edit ForgeJob'
        }))
        fail('ToolForge service rejected the queued edit ForgeJob')
      }
      return { success: true, data: { jobId: job.id, toolId, baseVersionId: request.baseVersionId, baseFingerprint: request.baseFingerprint, status: job.status, revision: job.revision, originalTaskComplete: false } }
    } catch (error) {
      return { success: false, error: { code: 'read-failed', message: error instanceof Error ? error.message : 'Generated Tool edit failed' } }
    }
  }
}
