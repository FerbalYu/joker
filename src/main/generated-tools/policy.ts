import { createHash } from 'node:crypto'

import type {
  GeneratedToolPolicyDecision,
  GeneratedToolPolicyInput,
  ForgeJob,
  GeneratedToolCandidate,
  GeneratedToolValidationReport
} from '../../shared/generated-tools'
import {
  canonicalGeneratedToolJson,
  parseGeneratedToolPolicyDecision,
  parseGeneratedToolPolicyInput
} from '../../shared/generated-tools-schema'
import { readGeneratedToolRegistry } from './registry'
import { readForgeJob } from './forge-job-store'
import {
  readGeneratedToolCandidate,
  readForgeAttemptRecord
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
  validationProfile: GeneratedToolCandidate['validationProfile'],
  workspaceFullTrustGranted: boolean,
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
    validationProfile,
    workspaceFullTrustGranted,
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
  const input = hostInput(job, candidate, report, 'L2', registry.revision, registry.capabilityRevision.revision, operation, approvalMode, candidate.validationProfile, true, evaluatedAt)
  const decision = makeDecision(input, 'allow', 'workspace-full-trust-authorized', 'ToolForge has no approval or permission gate', false, false)
  return { input, decision, job, candidate, report }
}
