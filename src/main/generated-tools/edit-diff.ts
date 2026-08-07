import { createHash } from 'node:crypto'

import type {
  GeneratedToolManifest,
  GeneratedToolValidationReport,
  GeneratedToolVersion,
  GeneratedToolCandidate
} from '../../shared/generated-tools'
import type {
  GeneratedToolEditDiff,
  GeneratedToolEditPermissionDiff,
  GeneratedToolEditSchemaDiff,
  GeneratedToolEditValidationDiff
} from '../../shared/generated-tools-management'
import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalGeneratedToolJson(value)).digest('hex')
}

function schemaDiff(base: unknown, candidate: unknown): GeneratedToolEditSchemaDiff {
  const baseHash = hash(base)
  const candidateHash = hash(candidate)
  return { changed: baseHash !== candidateHash, baseHash, candidateHash }
}

function permissionValues(manifest: GeneratedToolManifest): Map<string, Set<string>> {
  return new Map([
    ['filesystem.read', new Set(manifest.permissions.filesystem.read)],
    ['filesystem.write', new Set(manifest.permissions.filesystem.write)],
    ['network.hosts', new Set(manifest.permissions.network.hosts)],
    ['network.methods', new Set(manifest.permissions.network.methods ?? [])],
    ['process.commands', new Set(manifest.permissions.process.commands)],
    ['environment.keys', new Set(manifest.permissions.environment.keys)],
    ['secrets.handles', new Set(manifest.permissions.secrets.handles)]
  ])
}

export function permissionDiff(base: GeneratedToolManifest, candidate: GeneratedToolManifest): GeneratedToolEditPermissionDiff {
  const before = permissionValues(base)
  const after = permissionValues(candidate)
  const added: string[] = []
  const removed: string[] = []
  for (const [category, values] of after) {
    for (const value of values) if (!before.get(category)?.has(value)) added.push(`${category}:${value}`)
  }
  for (const [category, values] of before) {
    for (const value of values) if (!after.get(category)?.has(value)) removed.push(`${category}:${value}`)
  }
  added.sort((left, right) => left.localeCompare(right, 'en-US'))
  removed.sort((left, right) => left.localeCompare(right, 'en-US'))
  const categories = [...new Set(added.map((item) => item.slice(0, item.indexOf(':'))))]
  return {
    added,
    removed,
    expanded: added.length > 0,
    categories: categories.sort((left, right) => left.localeCompare(right, 'en-US'))
  }
}

function validationDiff(base: GeneratedToolValidationReport, candidate: GeneratedToolValidationReport): GeneratedToolEditValidationDiff {
  const before = new Map(base.checks.map((check) => [check.id, check]))
  const added: string[] = []
  const changed: string[] = []
  const failed: string[] = []
  for (const check of candidate.checks) {
    const prior = before.get(check.id)
    if (!prior) added.push(check.id)
    else if (prior.status !== check.status || prior.message !== check.message) changed.push(check.id)
    if (check.status === 'failed') failed.push(check.id)
  }
  return {
    added: added.sort((left, right) => left.localeCompare(right, 'en-US')),
    changed: changed.sort((left, right) => left.localeCompare(right, 'en-US')),
    failed: failed.sort((left, right) => left.localeCompare(right, 'en-US'))
  }
}

export function buildGeneratedToolEditDiff(
  base: GeneratedToolVersion,
  candidate: GeneratedToolCandidate,
  baseReport: GeneratedToolValidationReport,
  candidateReport: GeneratedToolValidationReport
): GeneratedToolEditDiff {
  return {
    baseVersionId: base.id,
    baseFingerprint: base.fingerprint,
    candidateId: candidate.id,
    candidateFingerprint: candidate.artifactFingerprint,
    inputSchema: schemaDiff(base.manifest.inputSchema, candidate.manifest.inputSchema),
    outputSchema: schemaDiff(base.manifest.outputSchema, candidate.manifest.outputSchema),
    permissions: permissionDiff(base.manifest, candidate.manifest),
    sourceChanged: base.sourceHash !== candidate.sourceHash,
    distChanged: base.distHash !== candidate.distHash,
    dependencies: schemaDiff(base.manifest.dependencies, candidate.manifest.dependencies),
    validation: validationDiff(baseReport, candidateReport)
  }
}
