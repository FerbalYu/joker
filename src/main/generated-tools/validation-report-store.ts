import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { GeneratedToolValidationReport } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseGeneratedToolValidationReport } from '../../shared/generated-tools-schema'
import { readJsonWithBackupStrict, withFileLock, writeJsonOnce } from '../store/atomic-json'
import { assertPathHasNoSymlink, assertToolForgeId, resolveRootRelativePath } from './paths'
import { generatedToolsRoot } from './store'
import { ToolForgeCasError } from './registry'

export interface ValidationReportArtifact {
  path: string
  bytes: string
}

export interface CommitValidationReportBundleInput {
  jokerHome: string
  report: Omit<GeneratedToolValidationReport, 'id' | 'logsPath' | 'logsHash'>
  evidence: ValidationReportArtifact[]
  logs: string
}

function sha256Bytes(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function reportBody(report: GeneratedToolValidationReport): Omit<GeneratedToolValidationReport, 'id'> {
  const { id: _id, ...body } = report
  return body
}

export function fingerprintGeneratedToolValidationReport(report: GeneratedToolValidationReport): string {
  return createHash('sha256').update(canonicalGeneratedToolJson(reportBody(report))).digest('hex')
}

export function getValidationReportBundlePath(jokerHome: string, reportId: string): string {
  return join(generatedToolsRoot(jokerHome), 'reports', assertToolForgeId(reportId, 'report id'))
}

export function getValidationReportPath(jokerHome: string, reportId: string): string {
  return join(getValidationReportBundlePath(jokerHome, reportId), 'report.json')
}

export function commitValidationReportBundle(input: CommitValidationReportBundleInput): GeneratedToolValidationReport {
  const evidenceByPath = new Map(input.evidence.map((item) => [item.path, item]))
  if (evidenceByPath.size !== input.evidence.length) throw new Error('Validation evidence paths must be unique')
  const checks = input.report.checks.map((check) => {
    if (!check.evidencePath) throw new Error(`Validation check evidence path is missing: ${check.id}`)
    const artifact = evidenceByPath.get(check.evidencePath)
    if (!artifact) throw new Error(`Validation check evidence is missing: ${check.id}`)
    return { ...check, evidenceHash: sha256Bytes(artifact.bytes) }
  })
  const withPlaceholder = parseGeneratedToolValidationReport({
    ...input.report,
    id: 'validation-placeholder',
    checks,
    logsPath: 'logs/validator.json',
    logsHash: sha256Bytes(input.logs)
  })
  const id = `validation-${fingerprintGeneratedToolValidationReport(withPlaceholder).slice(0, 48)}`
  const report = parseGeneratedToolValidationReport({ ...withPlaceholder, id })
  const bundle = getValidationReportBundlePath(input.jokerHome, report.id)
  const existing = readValidationReport(input.jokerHome, report.id)
  if (existing) {
    if (canonicalGeneratedToolJson(existing) !== canonicalGeneratedToolJson(report)) throw new ToolForgeCasError('Validation report id already exists with different content')
    return verifyValidationReportBundle(input.jokerHome, report.id)
  }
  return withFileLock(bundle, () => {
    for (const artifact of input.evidence) {
      const path = resolveRootRelativePath(bundle, artifact.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, artifact.bytes, 'utf8')
    }
    const logsPath = resolveRootRelativePath(bundle, report.logsPath)
    mkdirSync(dirname(logsPath), { recursive: true })
    writeFileSync(logsPath, input.logs, 'utf8')
    writeJsonOnce(getValidationReportPath(input.jokerHome, report.id), report)
    return verifyValidationReportBundle(input.jokerHome, report.id)
  })
}

export function writeValidationReport(jokerHome: string, report: GeneratedToolValidationReport): GeneratedToolValidationReport {
  const parsed = parseGeneratedToolValidationReport(report)
  const path = getValidationReportPath(jokerHome, parsed.id)
  const existing = readJsonWithBackupStrict(path, parseGeneratedToolValidationReport)
  if (existing) {
    if (canonicalGeneratedToolJson(existing) !== canonicalGeneratedToolJson(parsed)) throw new ToolForgeCasError('Validation report id already exists with different content')
    return existing
  }
  writeJsonOnce(path, parsed)
  return parsed
}

export function readValidationReport(jokerHome: string, reportId: string): GeneratedToolValidationReport | null {
  return readJsonWithBackupStrict(getValidationReportPath(jokerHome, reportId), parseGeneratedToolValidationReport)
}

export function verifyValidationReportBundle(jokerHome: string, reportId: string): GeneratedToolValidationReport {
  const report = readValidationReport(jokerHome, reportId)
  if (!report) throw new Error(`Validation report not found: ${reportId}`)
  if (report.validationProfile && report.id !== `validation-${fingerprintGeneratedToolValidationReport(report).slice(0, 48)}`) {
    throw new Error('Validation report id does not match its content')
  }
  const bundle = getValidationReportBundlePath(jokerHome, report.id)
  for (const check of report.checks) {
    if (!check.evidencePath || !check.evidenceHash) {
      if (report.validationProfile) throw new Error(`Validation evidence hash is missing: ${check.id}`)
      continue
    }
    const path = resolveRootRelativePath(bundle, check.evidencePath)
    if (!existsSync(path)) throw new Error(`Validation evidence is missing: ${check.id}`)
    assertPathHasNoSymlink(bundle, path)
    if (sha256Bytes(readFileSync(path, 'utf8')) !== check.evidenceHash) throw new Error(`Validation evidence changed: ${check.id}`)
  }
  if (report.logsHash) {
    const logsPath = resolveRootRelativePath(bundle, report.logsPath)
    if (!existsSync(logsPath)) throw new Error('Validation logs are missing')
    assertPathHasNoSymlink(bundle, logsPath)
    if (sha256Bytes(readFileSync(logsPath, 'utf8')) !== report.logsHash) throw new Error('Validation logs changed')
  }
  return report
}
