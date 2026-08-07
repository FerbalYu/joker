import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GeneratedToolValidationReport } from '../../shared/generated-tools'
import type { GeneratedToolRevalidateResult } from '../../shared/generated-tools-management'
import { parseGeneratedToolRevalidateInput } from '../../shared/generated-tools-management'
import { parseGeneratedToolValidationReport } from '../../shared/generated-tools-schema'
import { readGeneratedToolVersion } from './version-store'
import { generatedToolsRoot, verifyPublishedGeneratedToolBundle } from './store'
import { promoteGeneratedTool, readGeneratedToolRegistry } from './registry'
import { assertPathHasNoSymlink, assertToolForgeId, resolveRootRelativePath } from './paths'

export interface GeneratedToolRevalidateServiceOptions {
  jokerHome: string
  now?: () => number
}

function readPublishedValidationReport(jokerHome: string, toolId: string, versionId: string): GeneratedToolValidationReport {
  const root = generatedToolsRoot(jokerHome)
  const artifactRoot = resolveRootRelativePath(root, `tools/${assertToolForgeId(toolId, 'tool id')}/versions/${assertToolForgeId(versionId, 'version id')}`)
  assertPathHasNoSymlink(root, artifactRoot)
  const path = join(artifactRoot, 'validation-report.json')
  if (!existsSync(path)) throw new Error(`Published validation report is missing: ${versionId}`)
  assertPathHasNoSymlink(artifactRoot, path)
  return parseGeneratedToolValidationReport(JSON.parse(readFileSync(path, 'utf8')))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function verifyPublishedValidationEvidence(report: GeneratedToolValidationReport, artifactRoot: string): void {
  for (const check of report.checks) {
    if (!check.evidencePath || !check.evidenceHash) {
      throw new Error(`Published validation evidence hash is missing: ${check.id}`)
    }
    const path = resolveRootRelativePath(artifactRoot, check.evidencePath)
    if (!existsSync(path)) throw new Error(`Published validation evidence is missing: ${check.id}`)
    assertPathHasNoSymlink(artifactRoot, path)
    if (sha256(readFileSync(path, 'utf8')) !== check.evidenceHash) throw new Error(`Published validation evidence changed: ${check.id}`)
  }
  const logsPath = resolveRootRelativePath(artifactRoot, report.logsPath)
  if (!existsSync(logsPath)) throw new Error('Published validation logs are missing')
  assertPathHasNoSymlink(artifactRoot, logsPath)
  if (report.logsHash && sha256(readFileSync(logsPath, 'utf8')) !== report.logsHash) throw new Error('Published validation logs changed')
}

/**
 * Revalidates an immutable published version before making it executable again.
 *
 * Revalidation is deliberately host-owned: it does not trust the renderer,
 * version metadata, or a previous report by itself. The published artifact,
 * report bundle, evidence hashes, and registry binding must all still agree.
 */
export class GeneratedToolRevalidateService {
  private readonly now: () => number

  constructor(private readonly options: GeneratedToolRevalidateServiceOptions) {
    this.now = options.now ?? Date.now
  }

  revalidate(input: unknown): GeneratedToolRevalidateResult {
    try {
      const request = parseGeneratedToolRevalidateInput(input)
      const toolId = assertToolForgeId(request.toolId, 'tool id')
      const versionId = assertToolForgeId(request.versionId, 'version id')
      const registry = readGeneratedToolRegistry(this.options.jokerHome)
      if (registry.revision !== request.expectedRevision) throw new Error('Generated Tool registry revision is stale')
      const entry = registry.entries.find((item) => item.toolId === toolId)
      if (!entry) throw new Error(`Generated Tool is not registered: ${toolId}`)
      if (!entry.versionIds.includes(versionId)) throw new Error('Target Generated Tool version is not registered')

      const version = readGeneratedToolVersion(this.options.jokerHome, toolId, versionId)
      const published = verifyPublishedGeneratedToolBundle(generatedToolsRoot(this.options.jokerHome), version)
      const report = readPublishedValidationReport(this.options.jokerHome, toolId, versionId)
      const artifactRoot = resolveRootRelativePath(generatedToolsRoot(this.options.jokerHome), version.artifactPath)
      verifyPublishedValidationEvidence(report, artifactRoot)
      if (report.toolId !== toolId || report.versionId !== versionId || report.artifactFingerprint !== published.fingerprint || report.status !== 'passed') {
        throw new Error('Validation report does not authorize this Generated Tool version')
      }

      const pointer = registry.activePointers.find((item) => item.toolId === toolId)
      if (pointer?.activeVersionId === versionId && entry.descriptor.availability === 'available') {
        return {
          success: true,
          data: {
            toolId,
            versionId,
            action: 'already-active',
            registryRevision: registry.revision,
            capabilityRevision: registry.capabilityRevision.revision,
            activeVersionId: versionId,
            reason: 'Generated Tool version is already revalidated and active'
          }
        }
      }

      const promoted = promoteGeneratedTool({
        jokerHome: this.options.jokerHome,
        registryId: registry.registryId,
        expectedRevision: request.expectedRevision,
        operationId: request.operationId,
        createdAt: this.now(),
        toolId,
        versionId
      })
      const active = promoted.state.activePointers.find((item) => item.toolId === toolId)
      return {
        success: true,
        data: {
          toolId,
          versionId,
          action: 'revalidated',
          registryRevision: promoted.state.revision,
          capabilityRevision: promoted.state.capabilityRevision.revision,
          activeVersionId: active?.activeVersionId,
          reason: 'Generated Tool version passed fresh integrity and validation evidence checks'
        }
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'read-failed',
          message: error instanceof Error ? error.message : 'Generated Tool revalidation failed'
        }
      }
    }
  }
}

export function revalidateGeneratedTool(
  input: unknown,
  jokerHome: string,
  now = Date.now
): GeneratedToolRevalidateResult {
  return new GeneratedToolRevalidateService({ jokerHome, now }).revalidate(input)
}
