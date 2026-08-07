import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  RuntimeQualificationCandidateResult,
  RuntimeQualificationFileIdentity,
  RuntimeQualificationReport
} from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseRuntimeQualificationReport } from '../../shared/generated-tools-schema'
import { readJsonWithBackup, writeJsonWithBackup } from '../store/atomic-json'
import { getJokerHomeDir } from '../store/paths'

/**
 * Runtime qualification is derived from host evidence. Declared levels and
 * caller-provided passesIsolation values are never trusted by consumers.
 */

export const QUALIFICATION_SCHEMA_VERSION = 2 as const
export const QUALIFICATION_RELATIVE_PATH = join('.joker', 'qualification', 'runtime-qualification.json')

export function getQualificationPath(jokerHome = getJokerHomeDir()): string {
  return join(jokerHome, QUALIFICATION_RELATIVE_PATH)
}

export const MANDATORY_QUALIFICATION_CASES = [
  'legit-execution',
  'workspace-boundary',
  'network-denied',
  'subprocess-denied',
  'env-denied',
  'timeout-cleanup',
  'cancel-cleanup',
  'ipc-registry-audit-isolation'
] as const

export type MandatoryQualificationCase = (typeof MANDATORY_QUALIFICATION_CASES)[number]
export const PACKAGED_EQUIVALENCE_CASE = 'packaged-equivalence' as const

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function portableRelativePath(root: string, target: string): string {
  const path = relative(resolve(root), resolve(target))
  if (path === '' || path.startsWith('..') || isAbsolute(path)) {
    throw new Error(`qualification file is outside its declared root: ${target}`)
  }
  return path.split(sep).join('/')
}

export function runtimeQualificationFileIdentity(path: string, root: string): RuntimeQualificationFileIdentity {
  const resolved = resolve(path)
  const stat = lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`qualification artifact is not a regular non-symlink file: ${resolved}`)
  return { path: portableRelativePath(root, resolved), size: stat.size, sha256: sha256(resolved) }
}

function caseCountsAsPass(caseResult: { status: string; evidence?: RuntimeQualificationFileIdentity }): boolean {
  return caseResult.status === 'pass' && Boolean(caseResult.evidence)
}

function isPathInside(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function containsSymlink(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return true
  let current = resolve(root)
  for (const segment of rel.split(sep)) {
    current = join(current, segment)
    if (lstatSync(current).isSymbolicLink()) return true
  }
  return false
}

function validateEvidenceFile(
  evidenceRoot: string,
  identity: RuntimeQualificationFileIdentity,
  expectedCaseId: string
): void {
  const evidencePath = resolve(evidenceRoot, identity.path)
  if (!isPathInside(evidenceRoot, evidencePath) || !existsSync(evidencePath)) throw new Error('evidence is missing or outside the report root')
  if (containsSymlink(evidenceRoot, evidencePath)) throw new Error('evidence path contains a symlink')
  const canonicalRoot = realpathSync(evidenceRoot)
  const canonicalEvidence = realpathSync(evidencePath)
  if (!isPathInside(canonicalRoot, canonicalEvidence)) throw new Error('evidence canonical path escapes the report root')
  const stat = lstatSync(evidencePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('evidence is not a regular non-symlink file')
  if (stat.size !== identity.size) throw new Error('evidence size mismatch')
  if (sha256(evidencePath) !== identity.sha256) throw new Error('evidence hash mismatch')
  const parsedEvidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as Record<string, unknown>
  if (parsedEvidence['id'] !== expectedCaseId && parsedEvidence['caseId'] !== expectedCaseId) {
    throw new Error('evidence case id mismatch')
  }
}

function validateQualificationEvidence(report: RuntimeQualificationReport, reportPath: string): RuntimeQualificationReport {
  const evidenceRoot = dirname(reportPath)
  const candidates = report.candidates.map((candidate) => {
    const cases = candidate.cases.map((item) => {
      if (item.status !== 'pass' || !item.evidence) return item
      try {
        validateEvidenceFile(evidenceRoot, item.evidence, item.id)
        return item
      } catch (error) {
        return {
          ...item,
          status: 'inconclusive' as const,
          details: `${item.details}; ${error instanceof Error ? error.message : String(error)}`,
          evidence: undefined
        }
      }
    })
    return {
      ...candidate,
      cases,
      passesIsolation: qualificationCandidatePassesIsolation({ cases, error: candidate.error }, candidate.env)
    }
  })
  return { ...report, candidates }
}

export function qualificationCandidatePassesIsolation(
  candidate: Pick<RuntimeQualificationCandidateResult, 'cases' | 'error'>,
  env: RuntimeQualificationCandidateResult['env']
): boolean {
  if (candidate.error) return false
  const applicable = new Map(
    candidate.cases
      .filter((item) => MANDATORY_QUALIFICATION_CASES.includes(item.id as MandatoryQualificationCase))
      .map((item) => [item.id, item])
  )
  if (!MANDATORY_QUALIFICATION_CASES.every((caseId) => {
    const result = applicable.get(caseId)
    return result !== undefined && caseCountsAsPass(result)
  })) return false
  if (env === 'packaged') {
    const equivalence = candidate.cases.find((item) => item.id === PACKAGED_EQUIVALENCE_CASE)
    if (!equivalence || !caseCountsAsPass(equivalence)) return false
  }
  return true
}

/** L2 requires one identical runner candidate to qualify in both environments. */
export function deriveRuntimeLevel(
  report: Pick<RuntimeQualificationReport, 'artifactIdentity' | 'environments' | 'candidates'>
): RuntimeQualificationReport['level'] {
  const { dev, packaged } = report.environments
  if (dev.status !== 'passed') return 'L0'

  const qualifiedDevIds = new Set(
    report.candidates
      .filter((candidate) => candidate.env === 'dev' && qualificationCandidatePassesIsolation(candidate, 'dev'))
      .map((candidate) => candidate.candidate)
  )
  if (qualifiedDevIds.size === 0) return 'L0'
  if (packaged.status !== 'passed') return 'L1'
  if (!report.artifactIdentity.packaged) return 'L1'

  const sameCandidateQualified = report.candidates.some(
    (candidate) => candidate.env === 'packaged'
      && qualifiedDevIds.has(candidate.candidate)
      && qualificationCandidatePassesIsolation(candidate, 'packaged')
  )
  return sameCandidateQualified ? 'L2' : 'L1'
}

function normalizeRuntimeQualificationReport(value: unknown, reportPath?: string): RuntimeQualificationReport {
  const parsed = parseRuntimeQualificationReport(value)
  const evidenceValidated = reportPath ? validateQualificationEvidence(parsed, reportPath) : parsed
  const level = deriveRuntimeLevel(evidenceValidated)
  return evidenceValidated.level === level ? evidenceValidated : { ...evidenceValidated, level }
}

export function validateRuntimeQualificationReportEvidence(
  report: RuntimeQualificationReport,
  reportPath: string
): RuntimeQualificationReport {
  return normalizeRuntimeQualificationReport(report, reportPath)
}

/** The only consumer entry point: schema, evidence and effective level are revalidated on every read. */
export function readEffectiveRuntimeQualificationReport(jokerHome = getJokerHomeDir()): RuntimeQualificationReport | null {
  const path = getQualificationPath(jokerHome)
  return readJsonWithBackup(path, (value) => normalizeRuntimeQualificationReport(value, path))
}

/** @deprecated Use readEffectiveRuntimeQualificationReport for all policy and execution decisions. */
export const readRuntimeQualificationReport = readEffectiveRuntimeQualificationReport

/** Fingerprint of the factual report; generatedAt is intentionally excluded. */
export function qualificationReportFingerprint(report: RuntimeQualificationReport): string {
  const canonical = {
    level: deriveRuntimeLevel(report),
    artifactIdentity: report.artifactIdentity,
    environments: report.environments,
    candidates: report.candidates,
    limitations: report.limitations
  }
  return createHash('sha256').update(canonicalGeneratedToolJson(canonical)).digest('hex')
}

/** Persists a strictly parsed report after replacing any caller-declared level. */
export function writeRuntimeQualificationReport(report: RuntimeQualificationReport, jokerHome = getJokerHomeDir()): string {
  const normalized = normalizeRuntimeQualificationReport(report)
  const path = getQualificationPath(jokerHome)
  writeJsonWithBackup(path, normalized)
  return path
}
