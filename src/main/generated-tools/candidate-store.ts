import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  ForgeJob,
  GeneratedToolCandidate,
  GeneratedToolForgeAttempt,
  GeneratedToolValidationProfileId
} from '../../shared/generated-tools'
import {
  canonicalGeneratedToolJson,
  parseGeneratedToolCandidate,
  parseGeneratedToolForgeAttempt
} from '../../shared/generated-tools-schema'
import { readJsonWithBackupStrict, withFileLock, writeJsonOnce } from '../store/atomic-json'
import { fingerprintGeneratedToolArtifact } from './fingerprint'
import { readForgeJob, updateForgeJob } from './forge-job-store'
import { assertPathHasNoSymlink, assertToolForgeId, resolveRootRelativePath, toRootRelativePath } from './paths'
import { ToolForgeCasError } from './registry'
import { generatedToolsRoot } from './store'

export const GATE2_PROJECT_READ_PROFILE: GeneratedToolValidationProfileId = 'gate2-project-read-v1'

export interface SealGeneratedToolCandidateInput {
  jokerHome: string
  jobId: string
  expectedRevision: number
  validationSuiteId: string
  validationSuiteHash: string
  createdAt: number
  validationRunId: string
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalGeneratedToolJson(value)).digest('hex')
}

export function getForgeAttemptRecordPath(jokerHome: string, jobId: string, attempt: number): string {
  return join(
    generatedToolsRoot(jokerHome),
    'jobs',
    assertToolForgeId(jobId, 'job id'),
    'attempts',
    `attempt-${attempt}.json`
  )
}

export function getGeneratedToolCandidatePath(jokerHome: string, jobId: string, candidateId: string): string {
  return join(
    generatedToolsRoot(jokerHome),
    'jobs',
    assertToolForgeId(jobId, 'job id'),
    'candidates',
    assertToolForgeId(candidateId, 'candidate id'),
    'candidate.json'
  )
}

function candidateArtifactRelativePath(jobId: string, candidateId: string): string {
  return `jobs/${assertToolForgeId(jobId, 'job id')}/candidates/${assertToolForgeId(candidateId, 'candidate id')}/artifact`
}

export function computeForgeJobSpecHash(job: Pick<ForgeJob, 'spec'>): string {
  return sha256(job.spec)
}

function candidateIdFor(job: ForgeJob, artifactFingerprint: string, suiteId: string, suiteHash: string): string {
  return `candidate-${sha256({
    jobId: job.id,
    attempt: job.attempt,
    artifactFingerprint,
    specHash: job.specHash,
    validationProfile: GATE2_PROJECT_READ_PROFILE,
    validationSuiteId: suiteId,
    validationSuiteHash: suiteHash
  }).slice(0, 48)}`
}

function attemptRecordIdFor(jobId: string, attempt: number, candidateId: string): string {
  return `attempt-${sha256({ jobId, attempt, candidateId }).slice(0, 48)}`
}

export function readGeneratedToolCandidate(
  jokerHome: string,
  jobId: string,
  candidateId: string
): GeneratedToolCandidate | null {
  return readJsonWithBackupStrict(
    getGeneratedToolCandidatePath(jokerHome, jobId, candidateId),
    parseGeneratedToolCandidate
  )
}

export function readForgeAttemptRecord(
  jokerHome: string,
  jobId: string,
  attempt: number
): GeneratedToolForgeAttempt | null {
  return readJsonWithBackupStrict(
    getForgeAttemptRecordPath(jokerHome, jobId, attempt),
    parseGeneratedToolForgeAttempt
  )
}

export function listGeneratedToolCandidatesForJob(
  jokerHome: string,
  jobId: string
): GeneratedToolCandidate[] {
  const root = join(
    generatedToolsRoot(jokerHome),
    'jobs',
    assertToolForgeId(jobId, 'job id'),
    'candidates'
  )
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readGeneratedToolCandidate(jokerHome, jobId, entry.name))
      .filter((candidate): candidate is GeneratedToolCandidate => candidate !== null)
      .sort((left, right) => left.attempt - right.attempt || left.id.localeCompare(right.id, 'en-US'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function verifyGeneratedToolCandidate(
  jokerHome: string,
  candidate: GeneratedToolCandidate
): GeneratedToolCandidate {
  const parsed = parseGeneratedToolCandidate(candidate)
  const root = generatedToolsRoot(jokerHome)
  const canonicalArtifactPath = candidateArtifactRelativePath(parsed.jobId, parsed.id)
  if (parsed.artifactPath !== canonicalArtifactPath) throw new Error('Generated Tool candidate artifactPath is not canonical')
  const actual = fingerprintGeneratedToolArtifact(root, parsed.artifactPath)
  if (
    actual.manifest.toolId !== parsed.toolId ||
    actual.fingerprint !== parsed.artifactFingerprint ||
    actual.manifestHash !== parsed.manifestHash ||
    actual.sourceHash !== parsed.sourceHash ||
    actual.distHash !== parsed.distHash ||
    canonicalGeneratedToolJson(actual.manifest) !== canonicalGeneratedToolJson(parsed.manifest)
  ) {
    throw new Error('Generated Tool candidate artifact changed after sealing')
  }
  return parsed
}

export function sealGeneratedToolCandidate(input: SealGeneratedToolCandidateInput): {
  candidate: GeneratedToolCandidate
  attempt: GeneratedToolForgeAttempt
  job: ForgeJob
  idempotent: boolean
} {
  assertToolForgeId(input.validationSuiteId, 'validation suite id')
  assertToolForgeId(input.validationRunId, 'validation run id')
  if (!/^[a-f0-9]{64}$/.test(input.validationSuiteHash)) throw new Error('Invalid validation suite hash')

  const lockPath = join(
    generatedToolsRoot(input.jokerHome),
    'jobs',
    assertToolForgeId(input.jobId, 'job id'),
    'candidate-seal'
  )
  return withFileLock(lockPath, () => {
    const job = readForgeJob(input.jokerHome, input.jobId)
    if (!job) throw new Error(`ForgeJob not found: ${input.jobId}`)
    if (job.revision !== input.expectedRevision) throw new ToolForgeCasError('ForgeJob revision is stale')
    if (job.status !== 'building') throw new Error('ForgeJob must be building before candidate submission')
    if (job.specHash !== computeForgeJobSpecHash(job)) throw new Error('ForgeJob spec hash no longer matches its spec')

    const existingAttempt = readForgeAttemptRecord(input.jokerHome, job.id, job.attempt)
    if (existingAttempt) {
      const existingCandidate = readGeneratedToolCandidate(input.jokerHome, job.id, existingAttempt.candidateId)
      if (!existingCandidate) throw new Error('Forge attempt record references a missing candidate')
      verifyGeneratedToolCandidate(input.jokerHome, existingCandidate)
      return { candidate: existingCandidate, attempt: existingAttempt, job, idempotent: true }
    }

    const root = generatedToolsRoot(input.jokerHome)
    const draftPath = resolveRootRelativePath(root, job.artifactPath)
    assertPathHasNoSymlink(root, draftPath)
    if (!lstatSync(draftPath).isDirectory()) throw new Error('ForgeJob artifactPath is not a directory')
    const before = fingerprintGeneratedToolArtifact(root, job.artifactPath)
    if (before.manifest.toolId !== job.toolId) throw new Error('Candidate manifest toolId does not match ForgeJob toolId')
    const previous = listGeneratedToolCandidatesForJob(input.jokerHome, job.id).at(-1)
    if (previous && previous.artifactFingerprint === before.fingerprint && previous.specHash === job.specHash) {
      throw new Error('Forge repair candidate has no artifact or spec changes')
    }

    const candidateId = candidateIdFor(job, before.fingerprint, input.validationSuiteId, input.validationSuiteHash)
    const attemptRecordId = attemptRecordIdFor(job.id, job.attempt, candidateId)
    const artifactPath = candidateArtifactRelativePath(job.id, candidateId)
    const candidatePath = getGeneratedToolCandidatePath(input.jokerHome, job.id, candidateId)
    const candidateRoot = dirname(candidatePath)
    if (existsSync(candidateRoot)) throw new ToolForgeCasError('Forge attempt already has a different candidate')
    const staging = `${candidateRoot}.staging-${process.pid}`
    const stagingArtifactPath = `${staging}/artifact`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    try {
      cpSync(draftPath, join(staging, 'artifact'), {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true
      })
      const stagingRelative = toRootRelativePath(root, stagingArtifactPath)
      const copied = fingerprintGeneratedToolArtifact(root, stagingRelative)
      const after = fingerprintGeneratedToolArtifact(root, job.artifactPath)
      if (
        canonicalGeneratedToolJson(before) !== canonicalGeneratedToolJson(copied) ||
        canonicalGeneratedToolJson(before) !== canonicalGeneratedToolJson(after)
      ) {
        throw new Error('Forge candidate changed while it was being sealed')
      }
      const candidate = parseGeneratedToolCandidate({
        schemaVersion: 1,
        id: candidateId,
        jobId: job.id,
        toolId: job.toolId,
        attempt: job.attempt,
        attemptRecordId,
        artifactPath,
        artifactFingerprint: copied.fingerprint,
        manifestHash: copied.manifestHash,
        sourceHash: copied.sourceHash,
        distHash: copied.distHash,
        manifest: copied.manifest,
        specHash: job.specHash,
        validationProfile: GATE2_PROJECT_READ_PROFILE,
        validationSuiteId: input.validationSuiteId,
        validationSuiteHash: input.validationSuiteHash,
        createdAt: input.createdAt
      })
      const attempt = parseGeneratedToolForgeAttempt({
        schemaVersion: 1,
        id: attemptRecordId,
        jobId: job.id,
        toolId: job.toolId,
        attempt: job.attempt,
        candidateId: candidate.id,
        candidateFingerprint: candidate.artifactFingerprint,
        specHash: job.specHash,
        validationProfile: candidate.validationProfile,
        validationSuiteId: candidate.validationSuiteId,
        validationSuiteHash: candidate.validationSuiteHash,
        createdAt: input.createdAt
      })
      writeJsonOnce(join(staging, 'candidate.json'), candidate)
      mkdirSync(dirname(candidateRoot), { recursive: true })
      renameSync(staging, candidateRoot)
      verifyGeneratedToolCandidate(input.jokerHome, candidate)
      writeJsonOnce(getForgeAttemptRecordPath(input.jokerHome, job.id, job.attempt), attempt)
      const updated = updateForgeJob(input.jokerHome, job.id, job.revision, (current) => ({
        ...current,
        status: 'validating',
        revision: current.revision + 1,
        updatedAt: Math.max(current.updatedAt, input.createdAt),
        candidateId: candidate.id,
        candidateFingerprint: candidate.artifactFingerprint,
        attemptRecordId: attempt.id,
        validationRunId: input.validationRunId,
        currentPhase: 'validating-candidate'
      }))
      return { candidate, attempt, job: updated, idempotent: false }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  })
}
