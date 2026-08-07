#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { hostname, platform, release, arch } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { generateGate5AuditReport } from '../src/main/gate5-audit.ts'

export const QUALIFICATION_BUNDLE_SCHEMA_VERSION = 1
export const QUALIFICATION_BUNDLE_FILES = ['manifest.json', 'claim-matrix.json', 'gaps.json', 'SHA256SUMS.json']

const STATUS_ORDER = ['pass', 'partial', 'fail', 'not-verified']
const CREDENTIAL_KEY_PATTERN = /(?:API_KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY|CSC_LINK|CSC_KEY_PASSWORD)$/i

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, path)
}

function runGit(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
  } catch {
    return null
  }
}

function sanitizeRemote(remote) {
  return remote ? remote.replace(/(https?:\/\/)[^/@\s]+@/i, '$1***@') : null
}

function gitMetadata(root) {
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']) === 'true'
  if (!inside) return { available: false, reason: 'source root is not a git work tree' }
  const porcelain = runGit(root, ['status', '--short']) ?? ''
  const changedFiles = porcelain.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).filter(Boolean)
  return {
    available: true,
    root: runGit(root, ['rev-parse', '--show-toplevel']),
    branch: runGit(root, ['branch', '--show-current']) || null,
    head: runGit(root, ['rev-parse', 'HEAD']),
    describe: runGit(root, ['describe', '--always', '--dirty']),
    remoteOrigin: sanitizeRemote(runGit(root, ['config', '--get', 'remote.origin.url'])),
    dirty: changedFiles.length > 0,
    changedFileCount: changedFiles.length,
    changedFiles: changedFiles.slice(0, 200),
    changedFilesTruncated: changedFiles.length > 200
  }
}

function environmentMetadata(root, packageJson) {
  const relevantEnv = ['CI', 'GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'RUNNER_OS', 'NODE_ENV']
  const env = Object.fromEntries(relevantEnv.map((key) => [key, process.env[key] ?? null]))
  const credentialVariablesPresent = Object.keys(process.env).filter((key) => CREDENTIAL_KEY_PATTERN.test(key)).sort()
  return {
    node: process.version,
    platform: platform(),
    osRelease: release(),
    arch: arch(),
    hostname: hostname(),
    cwd: process.cwd(),
    sourceRoot: root,
    package: packageJson ? { name: packageJson.name ?? null, version: packageJson.version ?? null } : null,
    env,
    credentialVariablesPresent,
    credentialValuesLogged: false
  }
}

function readPackageJson(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function normalizedRunId(value) {
  const candidate = value || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') + `-${process.pid}`
  const normalized = candidate.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!normalized) throw new Error('Qualification run id must contain at least one safe character.')
  return normalized.slice(0, 128)
}

function parseArgs(argv, cwd) {
  const positional = argv.find((arg) => !arg.startsWith('--'))
  const sourceRoot = resolve(positional ?? cwd)
  const outputRootArg = argv.find((arg) => arg.startsWith('--output-root='))?.slice('--output-root='.length)
  const runId = argv.find((arg) => arg.startsWith('--run-id='))?.slice('--run-id='.length)
  return {
    sourceRoot,
    outputRoot: resolve(outputRootArg ? (outputRootArg.startsWith('.') || outputRootArg.startsWith('/') || /^[A-Za-z]:[\\/]/.test(outputRootArg) ? outputRootArg : join(sourceRoot, outputRootArg)) : join(sourceRoot, 'output', 'qualification')),
    runId: normalizedRunId(runId),
    indexOnly: argv.includes('--index-only'),
    strict: argv.includes('--strict')
  }
}

function overallStatus(claims, gaps) {
  if (gaps.some((gap) => gap.status === 'fail')) return 'fail'
  const passCount = claims.filter((claim) => claim.status === 'pass').length
  const blockingGaps = gaps.filter((gap) => gap.severity === 'high')
  if (passCount === claims.length && claims.length > 0 && blockingGaps.length === 0) return 'pass'
  if (passCount > 0) return 'partial'
  return 'not-verified'
}

function claimMatrixFromAudit(audit) {
  const claims = audit.section23.map((section) => ({
    id: section.id,
    requirement: section.requirement,
    status: section.status === 'pass' ? 'pass' : 'not-verified',
    claimable: section.status === 'pass' && section.evidence.length > 0,
    evidence: section.evidence.map((item) => ({
      artifactPath: item.artifactPath,
      checksum: item.checksum,
      checkIds: item.checkIds
    })),
    ...(section.note ? { note: section.note } : {})
  }))
  return {
    schemaVersion: QUALIFICATION_BUNDLE_SCHEMA_VERSION,
    generatedAt: audit.generatedAt,
    auditStatus: audit.status,
    claims,
    summary: Object.fromEntries(['pass', 'not-verified'].map((status) => [status, claims.filter((claim) => claim.status === status).length]))
  }
}

function isExpectedNegativeRuntimeControlArtifact(path) {
  const normalized = path.toLowerCase()
  return normalized.includes('/qualification/evidence-') &&
    (normalized.includes('/node-vm-') || normalized.includes('/child-process-'))
}

function isExpectedFailureScenarioArtifact(path) {
  const normalized = path.toLowerCase()
  return normalized.includes('/toolforge-gate4-package-run/home/failure/.joker/generated-tools/')
}

function artifactFailureScope(artifact) {
  if (isExpectedNegativeRuntimeControlArtifact(artifact.path)) return 'expected-negative-runtime-control'
  if (isExpectedFailureScenarioArtifact(artifact.path)) return 'expected-failure-scenario'
  if (artifact.kind === 'signed-release') return 'release-signing'
  return 'blocking'
}

function gapsFromAudit(audit, claims, indexOnly) {
  const gaps = []
  for (const claim of claims) {
    if (claim.status !== 'pass' || !claim.claimable) {
      gaps.push({
        id: `claim.${claim.id}`,
        status: 'not-verified',
        severity: 'high',
        description: claim.note ?? `No retained passing evidence was found for: ${claim.requirement}`,
        claimId: claim.id,
        evidence: claim.evidence
      })
    }
  }
  for (const artifact of audit.artifacts) {
    if (artifact.status !== 'fail') continue
    const scope = artifactFailureScope(artifact)
    gaps.push({
      id: `artifact.${artifact.path}`,
      status: scope === 'blocking' ? 'fail' : 'not-verified',
      severity: scope === 'blocking' ? 'high' : scope === 'release-signing' ? 'medium' : 'info',
      scope,
      description: scope === 'expected-negative-runtime-control'
        ? 'Expected-negative runtime candidate evidence records the unsafe candidate failure; it is retained as a control and does not override authoritative QuickJS qualification.'
        : scope === 'expected-failure-scenario'
          ? 'The retained artifact belongs to the expected-failure Gate 4 scenario; its failure is required evidence and is not a product qualification failure.'
          : scope === 'release-signing'
            ? 'Release-signing evidence is non-passing or unavailable; it remains a separate release readiness gap and does not invalidate ToolForge §23 claims.'
            : 'A retained qualification artifact records an unexpected failed status; this bundle does not convert it to a pass.',
      artifactPath: artifact.path,
      evidence: [{ checksum: artifact.sha256 }]
    })
  }
  if (indexOnly && audit.artifactCount === 0) {
    gaps.push({
      id: 'retained-artifacts.absent',
      status: 'not-verified',
      severity: 'high',
      description: 'Index-only mode found no retained JSON artifacts under .qa/ or coverage/.',
      evidence: []
    })
  }
  return {
    schemaVersion: QUALIFICATION_BUNDLE_SCHEMA_VERSION,
    generatedAt: audit.generatedAt,
    gaps,
    summary: {
      ...Object.fromEntries(['fail', 'not-verified'].map((status) => [status, gaps.filter((gap) => gap.status === status).length])),
      blocking: gaps.filter((gap) => gap.severity === 'high').length,
      informational: gaps.filter((gap) => gap.severity !== 'high').length
    },
    policy: 'Missing, stale, or non-passing evidence remains not-verified; no pass is inferred from filenames, logs, UI smoke output, or absent artifacts.'
  }
}

export function buildQualificationBundle(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? process.cwd())
  const outputRoot = resolve(options.outputRoot ?? join(sourceRoot, 'output', 'qualification'))
  const runId = normalizedRunId(options.runId)
  const runDir = join(outputRoot, runId)
  if (existsSync(runDir)) throw new Error(`Qualification run already exists: ${runDir}`)
  mkdirSync(outputRoot, { recursive: true })
  mkdirSync(runDir)

  const generatedAt = new Date().toISOString()
  const packageJson = readPackageJson(sourceRoot)
  const audit = generateGate5AuditReport(sourceRoot)
  const retainedArtifacts = audit.artifacts.map((artifact) => ({
    path: artifact.path,
    kind: artifact.kind,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    status: artifact.status,
    checks: artifact.checks,
    ...(artifact.generatedAt !== undefined ? { generatedAt: artifact.generatedAt } : {})
  }))
  const claimMatrix = claimMatrixFromAudit(audit)
  const gaps = gapsFromAudit(audit, claimMatrix.claims, Boolean(options.indexOnly))
  const status = overallStatus(claimMatrix.claims, gaps.gaps) === 'not-verified' && audit.artifacts.some((artifact) => artifact.status === 'pass')
    ? 'partial'
    : overallStatus(claimMatrix.claims, gaps.gaps)

  const manifest = {
    schemaVersion: QUALIFICATION_BUNDLE_SCHEMA_VERSION,
    bundle: 'joker-qualification',
    runId,
    generatedAt,
    sourceRoot,
    mode: options.indexOnly ? 'index-retained-qa' : 'gate5-audit-retained-qa',
    status,
    environment: environmentMetadata(sourceRoot, packageJson),
    git: gitMetadata(sourceRoot),
    audit: {
      schemaVersion: audit.schemaVersion,
      generatedAt: audit.generatedAt,
      status: audit.status,
      artifactCount: audit.artifactCount,
      section23Count: audit.section23.length,
      section23PassCount: audit.section23.filter((section) => section.status === 'pass').length,
      limitations: audit.limitations
    },
    retainedArtifacts,
    outputFiles: QUALIFICATION_BUNDLE_FILES,
    integrity: { algorithm: 'sha256', sumsFile: 'SHA256SUMS.json', sumsSelfExcluded: true }
  }

  writeJsonAtomically(join(runDir, 'manifest.json'), manifest)
  writeJsonAtomically(join(runDir, 'claim-matrix.json'), claimMatrix)
  writeJsonAtomically(join(runDir, 'gaps.json'), gaps)
  const sums = {
    schemaVersion: QUALIFICATION_BUNDLE_SCHEMA_VERSION,
    bundle: 'joker-qualification',
    runId,
    generatedAt,
    algorithm: 'SHA-256',
    selfExcluded: true,
    files: Object.fromEntries(QUALIFICATION_BUNDLE_FILES.slice(0, -1).map((name) => [name, sha256(join(runDir, name))])),
    retainedArtifacts: retainedArtifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes }))
  }
  writeJsonAtomically(join(runDir, 'SHA256SUMS.json'), sums)

  return { runDir, runId, status, manifest, claimMatrix, gaps, sums }
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv, process.cwd())
  const result = buildQualificationBundle({ ...parsed })
  console.log(JSON.stringify({ runDir: result.runDir, runId: result.runId, status: result.status, artifactCount: result.manifest.audit.artifactCount, gapCount: result.gaps.gaps.length }, null, 2))
  if (parsed.strict && result.status !== 'pass') process.exitCode = 1
  return result
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) main()

export { claimMatrixFromAudit, gapsFromAudit, gitMetadata, parseArgs }
