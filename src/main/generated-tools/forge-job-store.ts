import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { ForgeJob } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseForgeJob } from '../../shared/generated-tools-schema'
import { readJsonWithBackupStrict, updateJsonWithBackupStrict, writeJsonOnce } from '../store/atomic-json'
import { assertToolForgeId } from './paths'
import { generatedToolsRoot } from './store'
import { ToolForgeCasError } from './registry'

export function getForgeJobPath(jokerHome: string, jobId: string): string {
  return join(generatedToolsRoot(jokerHome), 'jobs', assertToolForgeId(jobId, 'job id'), 'job.json')
}

export function hashGeneratedToolSpec(spec: ForgeJob['spec']): string {
  return createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex')
}

export function createForgeJob(jokerHome: string, job: ForgeJob): ForgeJob {
  const parsed = parseForgeJob(job)
  if (parsed.specHash !== hashGeneratedToolSpec(parsed.spec)) throw new Error('ForgeJob specHash does not match its spec')
  const conflict = listForgeJobs(jokerHome).jobs.find((item) =>
    item.idempotencyKey === parsed.idempotencyKey || (
      item.toolId.toLocaleLowerCase('en-US') === parsed.toolId.toLocaleLowerCase('en-US') &&
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(item.status)
    )
  )
  if (conflict && conflict.id !== parsed.id) {
    if (conflict.idempotencyKey === parsed.idempotencyKey) {
      if (conflict.specHash === parsed.specHash && conflict.toolId === parsed.toolId && conflict.mode === parsed.mode &&
        conflict.baseVersionId === parsed.baseVersionId && conflict.baseFingerprint === parsed.baseFingerprint && conflict.maxAttempts === parsed.maxAttempts) return conflict
      throw new ToolForgeCasError('ForgeJob idempotency key already exists with different content')
    }
    throw new ToolForgeCasError('Another active ForgeJob already owns this tool')
  }
  const path = getForgeJobPath(jokerHome, parsed.id)
  const existing = readJsonWithBackupStrict(path, parseForgeJob)
  if (existing) {
    if (canonicalGeneratedToolJson(existing) !== canonicalGeneratedToolJson(parsed)) throw new ToolForgeCasError('ForgeJob id already exists with different content')
    return existing
  }
  writeJsonOnce(path, parsed)
  return parsed
}

export function readForgeJob(jokerHome: string, jobId: string): ForgeJob | null {
  return readJsonWithBackupStrict(getForgeJobPath(jokerHome, jobId), parseForgeJob)
}

export interface ForgeJobListResult {
  jobs: ForgeJob[]
  corruptJobIds: string[]
}

export function listForgeJobs(jokerHome: string): ForgeJobListResult {
  const jobsRoot = join(generatedToolsRoot(jokerHome), 'jobs')
  let entries: string[]
  try {
    entries = readdirSync(jobsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en-US'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [], corruptJobIds: [] }
    throw error
  }

  const jobs: ForgeJob[] = []
  const corruptJobIds: string[] = []
  for (const jobId of entries) {
    try {
      assertToolForgeId(jobId, 'job id')
      const job = readForgeJob(jokerHome, jobId)
      if (!job || job.id !== jobId) {
        corruptJobIds.push(jobId)
        continue
      }
      jobs.push(job)
    } catch {
      corruptJobIds.push(jobId)
    }
  }
  jobs.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, 'en-US'))
  return { jobs, corruptJobIds }
}

export function recoverInterruptedForgeJobs(jokerHome: string, recoveredAt: number): ForgeJob[] {
  const jobsRoot = join(generatedToolsRoot(jokerHome), 'jobs')
  let entries: string[]
  try {
    entries = readdirSync(jobsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en-US'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const recovered: ForgeJob[] = []
  for (const jobId of entries) {
    const current = readForgeJob(jokerHome, jobId)
    if (!current || ['completed', 'failed', 'cancelled', 'interrupted', 'queued', 'awaiting-policy'].includes(current.status)) continue
    recovered.push(updateForgeJob(jokerHome, current.id, current.revision, (job) => ({
      ...job,
      status: 'interrupted',
      revision: job.revision + 1,
      updatedAt: Math.max(job.updatedAt, recoveredAt),
      finishedAt: Math.max(job.updatedAt, recoveredAt),
      error: 'recovered-after-restart',
      resumeHint: job.resumeHint ?? `resume-from-${job.status}`
    })))
  }
  return recovered
}

export function isLegalForgeJobTransition(current: ForgeJob, next: ForgeJob): boolean {
  if (next.status === 'interrupted' && ['planning', 'building', 'validating', 'promoting'].includes(current.status)) return true
  const transitions: Record<ForgeJob['status'], ForgeJob['status'][]> = {
    queued: ['planning', 'failed', 'cancelled'],
    planning: ['building', 'failed', 'cancelled'],
    building: ['validating', 'failed', 'cancelled'],
    validating: ['building', 'awaiting-policy', 'failed', 'cancelled'],
    'awaiting-policy': ['building', 'promoting', 'failed', 'cancelled'],
    promoting: ['completed', 'failed', 'interrupted'],
    completed: [],
    failed: ['building'],
    cancelled: [],
    interrupted: ['planning', 'building', 'validating']
  }
  return transitions[current.status].includes(next.status)
}

export function updateForgeJob(
  jokerHome: string,
  jobId: string,
  expectedRevision: number,
  update: (job: ForgeJob) => ForgeJob
): ForgeJob {
  return updateJsonWithBackupStrict(
    getForgeJobPath(jokerHome, jobId),
    parseForgeJob,
    () => { throw new Error(`ForgeJob not found: ${jobId}`) },
    (current) => {
      if (current.revision !== expectedRevision) throw new ToolForgeCasError('ForgeJob revision is stale')
      const next = update(structuredClone(current))
      if (next.id !== current.id || next.idempotencyKey !== current.idempotencyKey || next.specHash !== current.specHash ||
        next.toolId !== current.toolId || next.mode !== current.mode || next.baseVersionId !== current.baseVersionId ||
        next.baseFingerprint !== current.baseFingerprint || next.maxAttempts !== current.maxAttempts ||
        next.artifactPath !== current.artifactPath || canonicalGeneratedToolJson(next.spec) !== canonicalGeneratedToolJson(current.spec) ||
        next.revision !== current.revision + 1) {
        throw new Error('ForgeJob update must preserve host-owned identity and increment revision exactly once')
      }
      if (current.status === 'building' && next.status === 'validating' &&
        (!next.candidateId || !next.candidateFingerprint || !next.attemptRecordId || !next.validationRunId)) {
        throw new Error('Building ForgeJob requires an immutable candidate before validation')
      }
      if (current.candidateId && current.status !== 'validating' &&
        !(current.status === 'failed' && next.status === 'building') &&
        next.candidateId !== current.candidateId) {
        throw new Error('ForgeJob candidate identity is immutable outside a repair transition')
      }
      if (current.status === 'validating' && next.status === 'validating' &&
        (next.candidateId !== current.candidateId || next.candidateFingerprint !== current.candidateFingerprint || next.attemptRecordId !== current.attemptRecordId)) {
        throw new Error('Validating ForgeJob candidate identity cannot change')
      }
      if (current.status === 'validating' && next.status === 'building' ||
        current.status === 'failed' && next.status === 'building') {
        if (current.attempt >= current.maxAttempts || next.attempt !== current.attempt + 1) {
          throw new Error('ForgeJob repair must consume exactly one remaining attempt')
        }
        if (next.candidateId || next.candidateFingerprint || next.attemptRecordId || next.validationRunId || next.validationReportId) {
          throw new Error('ForgeJob repair must clear current candidate and validation bindings')
        }
      } else if (next.attempt !== current.attempt) {
        throw new Error('ForgeJob attempt can change only when validation returns to building')
      }
      if (!isLegalForgeJobTransition(current, next)) throw new Error(`Invalid ForgeJob transition: ${current.status} -> ${next.status}`)
      const parsed = parseForgeJob(next)
      if (parsed.specHash !== hashGeneratedToolSpec(parsed.spec)) throw new Error('ForgeJob specHash no longer matches its spec')
      return parsed
    }
  )
}
