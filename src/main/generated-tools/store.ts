import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { GeneratedToolVersion } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson, parseGeneratedToolValidationReport, parseGeneratedToolVersion } from '../../shared/generated-tools-schema'
import { fingerprintGeneratedToolArtifact } from './fingerprint'
import { assertPathHasNoSymlink, assertToolForgeId, resolveRootRelativePath } from './paths'

export function generatedToolsRoot(jokerHome: string): string {
  return join(jokerHome, '.joker', 'generated-tools')
}

export function canonicalVersionPath(toolId: string, versionId: string): string {
  return `tools/${assertToolForgeId(toolId, 'tool id')}/versions/${assertToolForgeId(versionId, 'version id')}`
}

export interface QuarantineGeneratedToolResult {
  quarantineId: string
  moved: boolean
  restore: () => void
}

export function quarantineGeneratedToolDirectory(
  root: string,
  toolId: string,
  operationId: string
): QuarantineGeneratedToolResult {
  const safeToolId = assertToolForgeId(toolId, 'tool id')
  const safeOperationId = assertToolForgeId(operationId, 'operation id')
  const sourceRelativePath = `tools/${safeToolId}`
  const quarantineId = `${safeToolId}-${safeOperationId}`
  const destinationRelativePath = `quarantine/${quarantineId}`
  const source = resolveRootRelativePath(root, sourceRelativePath)
  const destination = resolveRootRelativePath(root, destinationRelativePath)
  mkdirSync(dirname(destination), { recursive: true })
  assertPathHasNoSymlink(root, dirname(destination))
  const sourceExists = existsSync(source)
  const destinationExists = existsSync(destination)
  if (sourceExists && destinationExists) throw new Error('Generated Tool quarantine destination already conflicts with its source')
  if (!sourceExists && !destinationExists) throw new Error('Generated Tool directory is missing')
  if (sourceExists) {
    assertPathHasNoSymlink(root, source)
    if (!lstatSync(source).isDirectory()) throw new Error('Generated Tool directory is not a directory')
    renameSync(source, destination)
  }
  return {
    quarantineId,
    moved: sourceExists,
    restore: () => {
      if (!sourceExists) return
      if (existsSync(source)) return
      if (!existsSync(destination)) throw new Error('Generated Tool quarantine directory is missing during recovery')
      renameSync(destination, source)
    }
  }
}

export interface PublishGeneratedToolBundleInput {
  root: string
  stagingRootRelativePath: string
  version: GeneratedToolVersion
}

export function publishGeneratedToolBundle(input: PublishGeneratedToolBundleInput): { artifactPath: string; idempotent: boolean } {
  const { root, stagingRootRelativePath } = input
  const version = parseGeneratedToolVersion(input.version)
  if (version.trustState !== 'trusted') throw new Error('Only trusted Generated Tool versions can be published')
  const destinationRelativePath = canonicalVersionPath(version.toolId, version.id)
  if (version.artifactPath !== destinationRelativePath) throw new Error('Generated Tool version artifactPath is not canonical')
  mkdirSync(root, { recursive: true })
  const destination = resolveRootRelativePath(root, destinationRelativePath)
  if (existsSync(destination)) {
    const existing = verifyStagedBundle(root, destinationRelativePath, version)
    if (canonicalGeneratedToolJson(existing) !== canonicalGeneratedToolJson(version)) throw new Error('Generated Tool version already exists with different metadata')
    return { artifactPath: destinationRelativePath, idempotent: true }
  }

  const staging = resolveRootRelativePath(root, stagingRootRelativePath)
  assertPathHasNoSymlink(root, staging)
  if (!lstatSync(staging).isDirectory()) throw new Error('Generated Tool staging bundle is not a directory')
  verifyStagedBundle(root, stagingRootRelativePath, version)
  mkdirSync(dirname(destination), { recursive: true })
  assertPathHasNoSymlink(root, dirname(destination))

  try {
    renameSync(staging, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    const publicationStagingRelative = `${destinationRelativePath}.publish-${randomUUID()}`
    const publicationStaging = resolveRootRelativePath(root, publicationStagingRelative)
    try {
      cpSync(staging, publicationStaging, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
      verifyStagedBundle(root, publicationStagingRelative, version)
      renameSync(publicationStaging, destination)
      rmSync(staging, { recursive: true, force: true })
    } finally {
      rmSync(publicationStaging, { recursive: true, force: true })
    }
  }
  return { artifactPath: destinationRelativePath, idempotent: false }
}

export function verifyPublishedGeneratedToolBundle(root: string, version: GeneratedToolVersion): GeneratedToolVersion {
  const parsed = parseGeneratedToolVersion(version)
  if (parsed.trustState !== 'trusted') throw new Error('Only trusted Generated Tool versions can be verified')
  const canonicalPath = canonicalVersionPath(parsed.toolId, parsed.id)
  if (parsed.artifactPath !== canonicalPath) throw new Error('Generated Tool version artifactPath is not canonical')
  return verifyStagedBundle(root, canonicalPath, parsed)
}

function verifyStagedBundle(root: string, artifactPath: string, expectedVersion: GeneratedToolVersion): GeneratedToolVersion {
  const artifactRoot = resolveRootRelativePath(root, artifactPath)
  assertPathHasNoSymlink(root, artifactRoot)
  const version = parseGeneratedToolVersion(JSON.parse(readFileSync(join(artifactRoot, 'version.json'), 'utf8')))
  const report = parseGeneratedToolValidationReport(JSON.parse(readFileSync(join(artifactRoot, 'validation-report.json'), 'utf8')))
  const actual = fingerprintGeneratedToolArtifact(root, artifactPath)
  if (version.toolId !== expectedVersion.toolId || version.id !== expectedVersion.id || version.artifactPath !== expectedVersion.artifactPath ||
    canonicalGeneratedToolJson(version) !== canonicalGeneratedToolJson(expectedVersion)) throw new Error('Staged Generated Tool version metadata does not match publication request')
  if (actual.manifest.toolId !== version.toolId || actual.fingerprint !== version.fingerprint || actual.manifestHash !== version.manifestHash ||
    actual.sourceHash !== version.sourceHash || actual.distHash !== version.distHash ||
    canonicalGeneratedToolJson(actual.manifest) !== canonicalGeneratedToolJson(version.manifest)) {
    throw new Error('Staged Generated Tool fingerprint does not match version metadata')
  }
  if (report.id !== version.validationReportId || report.toolId !== version.toolId || report.versionId !== version.id ||
    report.status !== 'passed' || report.artifactFingerprint !== version.fingerprint) throw new Error('Staged validation report does not authorize this version')
  if (canonicalGeneratedToolJson(report.declaredPermissions) !== canonicalGeneratedToolJson(actual.manifest.permissions)) {
    throw new Error('Staged validation report permissions do not match the manifest')
  }
  for (const check of report.checks) {
    if (!check.evidencePath) throw new Error(`Staged validation evidence is missing: ${check.id}`)
    const evidencePath = resolveRootRelativePath(artifactRoot, check.evidencePath)
    if (!existsSync(evidencePath)) throw new Error(`Staged validation evidence is missing: ${check.id}`)
    assertPathHasNoSymlink(artifactRoot, evidencePath)
    if (!lstatSync(evidencePath).isFile()) throw new Error(`Staged validation evidence is not a file: ${check.id}`)
  }
  const logsPath = resolveRootRelativePath(artifactRoot, report.logsPath)
  if (!existsSync(logsPath)) throw new Error('Staged validation log is missing')
  assertPathHasNoSymlink(artifactRoot, logsPath)
  if (!lstatSync(logsPath).isFile()) throw new Error('Staged validation log is not a file')
  return version
}
