import { createHash } from 'node:crypto'

import type {
  GeneratedToolPolicyDecision,
  GeneratedToolPolicyInput,
  GeneratedToolPermissionManifest,
  ForgeJob,
  GeneratedToolCandidate,
  GeneratedToolValidationReport
} from '../../shared/generated-tools'
import {
  canonicalGeneratedToolJson,
  parseGeneratedToolPolicyDecision,
  parseGeneratedToolPolicyInput
} from '../../shared/generated-tools-schema'
import { readEffectiveRuntimeQualificationReport } from './qualification'
import { readGeneratedToolRegistry } from './registry'
import { readForgeJob } from './forge-job-store'
import {
  readGeneratedToolCandidate,
  readForgeAttemptRecord,
  verifyGeneratedToolCandidate
} from './candidate-store'
import { verifyValidationReportBundle } from './validation-report-store'

export const GENERATED_TOOL_POLICY_VERSION = 'gate3-policy-v1'

export interface EvaluateGeneratedToolPolicyOptions {
  jokerHome: string
  jobId: string
  operation?: 'promote' | 'execute'
  approvalMode?: 'suggest' | 'auto-edit' | 'full-auto'
  evaluatedAt?: number
  expectedRegistryRevision?: number
}

export interface GeneratedToolPolicyEvaluation {
  input: GeneratedToolPolicyInput
  decision: GeneratedToolPolicyDecision
  job: ForgeJob
  candidate: GeneratedToolCandidate
  report: GeneratedToolValidationReport
}

function hash(value: unknown): string {
  const input = value && typeof value === 'object' ? { ...(value as Record<string, unknown>), evaluatedAt: undefined } : value
  return createHash('sha256').update(canonicalGeneratedToolJson(input)).digest('hex')
}

function emptyProjectReadPermissions(permissions: GeneratedToolPermissionManifest): boolean {
  return permissions.filesystem.write.length === 0
    && permissions.network.hosts.length === 0
    && permissions.process.commands.length === 0
    && permissions.environment.keys.length === 0
    && permissions.secrets.handles.length === 0
}

function narrowProjectRead(job: ForgeJob, candidate: GeneratedToolCandidate): boolean {
  return job.spec.scope === 'project'
    && Boolean(job.spec.projectId)
    && candidate.manifest.permissions.filesystem.read.length > 0
    && emptyProjectReadPermissions(candidate.manifest.permissions)
    && candidate.manifest.dependencies.length === 0
}

function baseVersionIsStale(job: ForgeJob, registry: ReturnType<typeof readGeneratedToolRegistry>): boolean {
  if (!job.baseVersionId) return false
  const entry = registry.entries.find((item) => item.toolId === job.toolId)
  const pointer = registry.activePointers.find((item) => item.toolId === job.toolId)
  return !entry
    || !entry.versionIds.includes(job.baseVersionId)
    || pointer?.activeVersionId !== job.baseVersionId
}

function unsupportedPermissionReason(permissions: GeneratedToolPermissionManifest): 'permission-profile-hard-deny' | 'permission-profile-unsupported' | undefined {
  if (permissions.process.commands.length > 0 || permissions.environment.keys.length > 0 || permissions.secrets.handles.length > 0) {
    return 'permission-profile-hard-deny'
  }
  if (permissions.filesystem.write.length > 0 || permissions.network.hosts.length > 0) return 'permission-profile-unsupported'
  return undefined
}

function makeDecision(
  input: GeneratedToolPolicyInput,
  action: GeneratedToolPolicyDecision['action'],
  reasonCode: GeneratedToolPolicyDecision['reasonCode'],
  reason: string,
  requiresApproval: boolean,
  hardDeny: boolean
): GeneratedToolPolicyDecision {
  return parseGeneratedToolPolicyDecision({
    schemaVersion: 1,
    action,
    reasonCode,
    reason,
    policyVersion: GENERATED_TOOL_POLICY_VERSION,
    inputHash: hash(input),
    evaluatedAt: input.evaluatedAt,
    requiresApproval,
    hardDeny
  })
}

function hostInput(
  job: ForgeJob,
  candidate: GeneratedToolCandidate,
  report: GeneratedToolValidationReport,
  runtimeQualificationLevel: 'L2' | 'L1' | 'L0',
  registryRevision: number,
  capabilityRevision: number,
  operation: 'promote' | 'execute',
  approvalMode: 'suggest' | 'auto-edit' | 'full-auto',
  evaluatedAt: number
): GeneratedToolPolicyInput {
  return parseGeneratedToolPolicyInput({
    schemaVersion: 1,
    operation,
    jobId: job.id,
    toolId: job.toolId,
    specHash: job.specHash,
    candidateId: candidate.id,
    candidateFingerprint: candidate.artifactFingerprint,
    validationReportId: report.id,
    runtimeQualificationLevel,
    scope: job.spec.scope,
    ...(job.spec.projectId ? { projectId: job.spec.projectId } : {}),
    permissions: candidate.manifest.permissions,
    ...(job.baseVersionId ? { baseVersionId: job.baseVersionId } : {}),
    registryRevision,
    capabilityRevision,
    approvalMode,
    evaluatedAt
  })
}

export function evaluateGeneratedToolPolicy(options: EvaluateGeneratedToolPolicyOptions): GeneratedToolPolicyEvaluation {
  const operation = options.operation ?? 'promote'
  const approvalMode = options.approvalMode ?? 'suggest'
  const evaluatedAt = options.evaluatedAt ?? Date.now()
  const job = readForgeJob(options.jokerHome, options.jobId)
  if (!job) throw new Error(`ForgeJob not found: ${options.jobId}`)
  if (!job.candidateId || !job.validationReportId || !job.candidateFingerprint) throw new Error('ForgeJob has no complete candidate and validation binding')
  const candidate = readGeneratedToolCandidate(options.jokerHome, job.id, job.candidateId)
  if (!candidate) throw new Error('ForgeJob candidate is missing')
  const attempt = readForgeAttemptRecord(options.jokerHome, job.id, job.attempt)
  if (!attempt || attempt.candidateId !== candidate.id || attempt.candidateFingerprint !== candidate.artifactFingerprint) throw new Error('Forge attempt binding is invalid')
  const report = verifyValidationReportBundle(options.jokerHome, job.validationReportId)
  const registry = readGeneratedToolRegistry(options.jokerHome)
  const qualification = readEffectiveRuntimeQualificationReport(options.jokerHome)
  const runtimeLevel = qualification?.level ?? 'L0'
  const input = hostInput(job, candidate, report, runtimeLevel, registry.revision, registry.capabilityRevision.revision, operation, approvalMode, evaluatedAt)

  let decision: GeneratedToolPolicyDecision
  try {
    verifyGeneratedToolCandidate(options.jokerHome, candidate)
    if (candidate.artifactFingerprint !== job.candidateFingerprint) throw new Error('Candidate fingerprint does not match ForgeJob')
    if (candidate.specHash !== job.specHash || candidate.toolId !== job.toolId) throw new Error('Candidate identity does not match ForgeJob')
    if (report.status !== 'passed' || report.toolId !== job.toolId || report.versionId !== candidate.id || report.artifactFingerprint !== candidate.artifactFingerprint) {
      throw new Error('Validation report does not authorize this candidate')
    }
      if (options.expectedRegistryRevision !== undefined && options.expectedRegistryRevision !== registry.revision) {
        decision = makeDecision(input, 'deny', 'stale-registry-revision', 'Generated Tool registry revision is stale', false, true)
      } else if (baseVersionIsStale(job, registry)) {
        decision = makeDecision(input, 'deny', 'stale-base-version', 'Generated Tool base version is no longer the active stable version', false, true)
      } else {
        const permissionReason = unsupportedPermissionReason(candidate.manifest.permissions)

      if (permissionReason === 'permission-profile-hard-deny') {
        decision = makeDecision(input, 'deny', permissionReason, 'Generated Tool requests a forbidden process, environment, or secret capability', false, true)
      } else if (runtimeLevel === 'L0') {
        decision = makeDecision(input, 'deny', 'runtime-l0', 'Generated Tool runtime is not qualified', false, true)
      } else if (permissionReason === 'permission-profile-unsupported' || !emptyProjectReadPermissions(candidate.manifest.permissions)) {
        decision = makeDecision(input, 'ask', 'permission-profile-unsupported', 'Generated Tool permissions require explicit approval', true, false)
      } else if (runtimeLevel === 'L1') {
        decision = makeDecision(input, 'ask', 'runtime-l1-approval-required', 'L1 Generated Tool promotion requires explicit approval', true, false)
      } else if (!narrowProjectRead(job, candidate)) {
        decision = makeDecision(input, 'ask', 'permission-profile-unsupported', 'Generated Tool is outside the automatic project-read profile', true, false)
      } else {
        decision = makeDecision(input, 'allow', 'runtime-l2-project-read', operation === 'promote' ? 'L2 project-read Generated Tool may be promoted automatically' : 'L2 project-read Generated Tool may execute automatically', false, false)
      }
    }
  } catch (error) {
    decision = makeDecision(input, 'deny', report.status === 'passed' ? 'candidate-integrity-failed' : 'validation-not-passed', error instanceof Error ? error.message : String(error), false, true)
  }
  return { input, decision, job, candidate, report }
}
