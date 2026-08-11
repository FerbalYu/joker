import type { ForgeJob, GeneratedToolValidationReport } from '../../shared/generated-tools'
import { readGeneratedToolCandidate } from './candidate-store'
import { readForgeJob, updateForgeJob } from './forge-job-store'
import { commitValidationReportBundle } from './validation-report-store'

function attachActivationRecord(jokerHome: string, job: ForgeJob, report: GeneratedToolValidationReport): ForgeJob {
  return updateForgeJob(jokerHome, job.id, job.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    status: 'awaiting-policy',
    updatedAt: Math.max(current.updatedAt, report.finishedAt),
    validationReportId: report.id,
    currentPhase: 'awaiting-policy'
  }))
}

/**
 * ToolForge no longer gates activation on runtime qualification, contracts,
 * declared permissions, or test cases. Versions still receive a small durable
 * activation record because the version storage format references one.
 */
export async function validateGeneratedToolCandidate(
  jokerHome: string,
  jobId: string,
  expectedRevision: number,
  _signal?: AbortSignal
): Promise<{ report?: GeneratedToolValidationReport; job: ForgeJob; outcome: 'completed' | 'cancelled' }> {
  const job = readForgeJob(jokerHome, jobId)
  if (!job) throw new Error(`ForgeJob not found: ${jobId}`)
  if (job.revision !== expectedRevision) throw new Error('ForgeJob revision is stale')
  if (job.status !== 'validating' || !job.candidateId || !job.validationRunId) throw new Error('ForgeJob is not ready for activation')
  const candidate = readGeneratedToolCandidate(jokerHome, job.id, job.candidateId)
  if (!candidate) throw new Error('ForgeJob candidate is missing')

  const startedAt = Date.now()
  const finishedAt = Date.now()
  const report = commitValidationReportBundle({
    jokerHome,
    report: {
      toolId: candidate.toolId,
      versionId: candidate.id,
      artifactFingerprint: candidate.artifactFingerprint,
      validationProfile: candidate.validationProfile,
      jobId: job.id,
      attempt: job.attempt,
      validationRunId: job.validationRunId,
      validationPlanId: candidate.validationPlan.id,
      validationPlanHash: candidate.validationPlanHash,
      startedAt,
      finishedAt,
      status: 'passed',
      checks: [{
        id: 'activation-recorded',
        category: 'audit',
        status: 'passed',
        evidencePath: 'evidence/activation-recorded.json',
        message: 'ToolForge activation is direct and ungated'
      }],
      declaredPermissions: candidate.manifest.permissions,
      observedCapabilities: []
    },
    evidence: [{
      path: 'evidence/activation-recorded.json',
      bytes: `${JSON.stringify({ jobId: job.id, candidateId: candidate.id, activation: 'direct' }, null, 2)}\n`
    }],
    logs: `${JSON.stringify({ jobId: job.id, candidateId: candidate.id, activation: 'direct' })}\n`
  })
  const latestJob = readForgeJob(jokerHome, job.id)
  if (!latestJob || latestJob.revision !== job.revision || latestJob.status !== 'validating') throw new Error('ForgeJob changed before activation record attachment')
  return { report, job: attachActivationRecord(jokerHome, latestJob, report), outcome: 'completed' }
}
