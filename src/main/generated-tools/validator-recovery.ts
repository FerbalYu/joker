import { randomUUID } from 'node:crypto'

import type { ForgeJob } from '../../shared/generated-tools'
import { readGeneratedToolCandidate } from './candidate-store'
import { readForgeJob, updateForgeJob } from './forge-job-store'
import { validateGeneratedToolCandidate } from './validator'
import { verifyValidationReportBundle } from './validation-report-store'

export function resumeInterruptedForgeJob(jokerHome: string, jobId: string, expectedRevision: number, resumedAt = Date.now()): ForgeJob {
  const job = readForgeJob(jokerHome, jobId)
  if (!job) throw new Error(`ForgeJob not found: ${jobId}`)
  if (job.revision !== expectedRevision) throw new Error('ForgeJob revision is stale')
  if (job.status !== 'interrupted') throw new Error('Only interrupted ForgeJobs can resume')
  const hint = job.resumeHint ?? ''
  if (hint.includes('validating')) {
    if (!job.candidateId) throw new Error('Interrupted validation has no candidate')
    const candidate = readGeneratedToolCandidate(jokerHome, job.id, job.candidateId)
    if (!candidate) throw new Error('Interrupted validation candidate is missing')
    return updateForgeJob(jokerHome, job.id, job.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      status: 'validating',
      updatedAt: Math.max(current.updatedAt, resumedAt),
      finishedAt: undefined,
      error: undefined,
      validationRunId: `validation-${randomUUID()}`,
      validationReportId: undefined,
      resumeHint: undefined
    }))
  }
  const status = hint.includes('planning') ? 'planning' : 'building'
  return updateForgeJob(jokerHome, job.id, job.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    status,
    updatedAt: Math.max(current.updatedAt, resumedAt),
    finishedAt: undefined,
    error: undefined,
    resumeHint: undefined
  }))
}

export async function resumeAndValidateGeneratedToolCandidate(
  jokerHome: string,
  jobId: string,
  expectedRevision: number,
  signal?: AbortSignal
): Promise<Awaited<ReturnType<typeof validateGeneratedToolCandidate>>> {
  const interrupted = readForgeJob(jokerHome, jobId)
  if (!interrupted) throw new Error(`ForgeJob not found: ${jobId}`)
  if (interrupted.validationReportId) {
    const report = verifyValidationReportBundle(jokerHome, interrupted.validationReportId)
    const resumed = resumeInterruptedForgeJob(jokerHome, jobId, expectedRevision)
    if (report.status === 'passed') {
      const job = updateForgeJob(jokerHome, resumed.id, resumed.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        status: 'awaiting-policy',
        updatedAt: Math.max(current.updatedAt, report.finishedAt),
        validationReportId: report.id,
        currentPhase: 'awaiting-policy'
      }))
      return { report, job, outcome: 'completed' }
    }
  }
  const resumed = resumeInterruptedForgeJob(jokerHome, jobId, expectedRevision)
  return validateGeneratedToolCandidate(jokerHome, resumed.id, resumed.revision, signal)
}
