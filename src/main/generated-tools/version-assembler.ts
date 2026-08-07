import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ForgeJob, GeneratedToolCandidate, GeneratedToolVersion } from '../../shared/generated-tools'
import { parseGeneratedToolVersion } from '../../shared/generated-tools-schema'
import { withFileLock } from '../store/atomic-json'
import { readForgeJob } from './forge-job-store'
import { readGeneratedToolCandidate, readForgeAttemptRecord } from './candidate-store'
import { verifyValidationReportBundle } from './validation-report-store'
import { fingerprintGeneratedToolArtifact } from './fingerprint'
import { canonicalVersionPath, generatedToolsRoot, publishGeneratedToolBundle } from './store'
import { readGeneratedToolRegistry } from './registry'
import { resolveRootRelativePath } from './paths'
import type { GeneratedToolPolicyDecision } from '../../shared/generated-tools'

export interface AssembleGeneratedToolVersionInput {
  jokerHome: string
  jobId: string
  promotionId: string
  policy: GeneratedToolPolicyDecision
  approvalGranted?: boolean
  expectedCandidateFingerprint: string
  createdAt?: number
}

export interface AssembledGeneratedToolVersion {
  job: ForgeJob
  candidate: GeneratedToolCandidate
  version: GeneratedToolVersion
  idempotent: boolean
}

function versionIdFor(_promotionId: string, candidate: GeneratedToolCandidate): string {
  // Validation reports are immutable and currently bind their versionId to the
  // sealed candidate. Reusing that identity preserves report/version binding.
  return candidate.id
}

export function assembleGeneratedToolVersion(input: AssembleGeneratedToolVersionInput): AssembledGeneratedToolVersion {
  const job = readForgeJob(input.jokerHome, input.jobId)
  if (!job) throw new Error(`ForgeJob not found: ${input.jobId}`)
  if (!job.candidateId || !job.validationReportId || !job.candidateFingerprint) throw new Error('ForgeJob has no promotion candidate')
  const candidate = readGeneratedToolCandidate(input.jokerHome, job.id, job.candidateId)
  if (!candidate) throw new Error('ForgeJob candidate is missing')
  if (candidate.artifactFingerprint !== input.expectedCandidateFingerprint || candidate.artifactFingerprint !== job.candidateFingerprint) throw new Error('Promotion candidate fingerprint is stale')
  const attempt = readForgeAttemptRecord(input.jokerHome, job.id, job.attempt)
  if (!attempt || attempt.candidateId !== candidate.id || attempt.candidateFingerprint !== candidate.artifactFingerprint) throw new Error('Promotion attempt binding is invalid')
  const report = verifyValidationReportBundle(input.jokerHome, job.validationReportId)
  if (report.status !== 'passed' || report.versionId !== candidate.id || report.artifactFingerprint !== candidate.artifactFingerprint) throw new Error('Validation report does not authorize promotion')
  if (input.policy.action !== 'allow' && !input.approvalGranted) throw new Error('Policy decision does not authorize assembly without approval')
  if (input.policy.inputHash.length !== 64) throw new Error('Policy decision input hash is invalid')

  const root = generatedToolsRoot(input.jokerHome)
  const lockPath = join(root, 'promotion-lock', `${job.toolId}.lock-key`)
  return withFileLock(lockPath, () => {
    const registry = readGeneratedToolRegistry(input.jokerHome)
    const existingVersionId = versionIdFor(input.promotionId, candidate)
    const existingPath = resolveRootRelativePath(root, canonicalVersionPath(job.toolId, existingVersionId))
    if (existsSync(existingPath)) {
      const existing = parseGeneratedToolVersion(JSON.parse(readFileSync(join(existingPath, 'version.json'), 'utf8')))
      if (existing.validationReportId !== report.id || existing.fingerprint !== candidate.artifactFingerprint) throw new Error('Promotion version identity conflicts with existing bundle')
      return { job, candidate, version: existing, idempotent: true }
    }
    const existingEntry = registry.entries.find((entry) => entry.toolId === job.toolId)
    const versions = existingEntry?.versionIds.map((id) => parseGeneratedToolVersion(JSON.parse(readFileSync(join(root, ...canonicalVersionPath(job.toolId, id).split('/'), 'version.json'), 'utf8')))) ?? []
    const versionNumber = versions.length === 0 ? 1 : Math.max(...versions.map((item) => item.version)) + 1
    const versionId = existingVersionId
    const stagingRelative = `staging/promotion-${input.promotionId}`
    const staging = resolveRootRelativePath(root, stagingRelative)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(join(staging, 'source'), { recursive: true })
    mkdirSync(join(staging, 'dist'), { recursive: true })
    cpSync(resolveRootRelativePath(root, `${candidate.artifactPath}/source`), join(staging, 'source'), { recursive: true, verbatimSymlinks: true })
    cpSync(resolveRootRelativePath(root, `${candidate.artifactPath}/dist`), join(staging, 'dist'), { recursive: true, verbatimSymlinks: true })
    cpSync(resolveRootRelativePath(root, `${candidate.artifactPath}/manifest.json`), join(staging, 'manifest.json'))
    const fingerprint = fingerprintGeneratedToolArtifact(root, stagingRelative)
    if (fingerprint.fingerprint !== candidate.artifactFingerprint) throw new Error('Candidate changed while assembling version')
    const version = parseGeneratedToolVersion({
      id: versionId,
      toolId: job.toolId,
      version: versionNumber,
      ...fingerprint,
      artifactPath: canonicalVersionPath(job.toolId, versionId),
      validationReportId: report.id,
      trustState: 'trusted',
      createdAt: input.createdAt ?? Date.now()
    })
    mkdirSync(join(staging, 'evidence'), { recursive: true })
    mkdirSync(join(staging, 'logs'), { recursive: true })
    const sourceReport = readFileSync(join(root, 'reports', report.id, 'report.json'))
    writeFileSync(join(staging, 'validation-report.json'), sourceReport)
    for (const check of report.checks) {
      if (!check.evidencePath) continue
      const source = resolveRootRelativePath(root, `reports/${report.id}/${check.evidencePath}`)
      const destination = resolveRootRelativePath(staging, check.evidencePath)
      mkdirSync(dirname(destination), { recursive: true })
      cpSync(source, destination)
    }
    const sourceLogs = resolveRootRelativePath(root, `reports/${report.id}/${report.logsPath}`)
    const destinationLogs = resolveRootRelativePath(staging, report.logsPath)
    mkdirSync(dirname(destinationLogs), { recursive: true })
    cpSync(sourceLogs, destinationLogs)
    writeFileSync(join(staging, 'version.json'), `${JSON.stringify(version, null, 2)}\n`, 'utf8')
    const published = publishGeneratedToolBundle({ root, stagingRootRelativePath: stagingRelative, version })
    return { job, candidate, version, idempotent: published.idempotent }
  })
}
