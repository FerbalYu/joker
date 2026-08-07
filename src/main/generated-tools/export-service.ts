import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { GeneratedToolExportResult } from '../../shared/generated-tools-management'
import { canonicalGeneratedToolJson, parseGeneratedToolValidationReport } from '../../shared/generated-tools-schema'
import { readGeneratedToolVersion } from './version-store'
import { generatedToolsRoot } from './store'
import { assertPathHasNoSymlink, resolveRootRelativePath } from './paths'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function sanitizeManifest(manifest: import('../../shared/generated-tools').GeneratedToolManifest): import('../../shared/generated-tools').GeneratedToolManifest {
  return {
    ...structuredClone(manifest),
    permissions: {
      ...structuredClone(manifest.permissions),
      secrets: { handles: [] }
    }
  }
}

function sanitizeReport(report: import('../../shared/generated-tools').GeneratedToolValidationReport): import('../../shared/generated-tools').GeneratedToolValidationReport {
  return {
    ...structuredClone(report),
    declaredPermissions: {
      ...structuredClone(report.declaredPermissions),
      secrets: { handles: [] }
    },
    checks: report.checks.map((check) => ({
      ...check,
      evidencePath: check.evidencePath?.split(/\\|\\/g).pop()
    })),
    logsPath: report.logsPath.split(/\\|\\/g).pop() ?? 'validation.log'
  }
}
function readFiles(
  root: string,
  current: string,
  files: Array<{ path: string; content: string; sha256: string }>
): void {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en-US'))) {
    const path = join(current, entry.name)
    assertPathHasNoSymlink(root, path)
    if (entry.isDirectory()) readFiles(root, path, files)
    else if (entry.isFile()) {
      const bytes = readFileSync(path)
      files.push({ path: relative(root, path).split(/\\|\\/g).join('/'), content: bytes.toString('utf8'), sha256: sha256(bytes) })
    } else throw new Error('Unsupported Generated Tool export entry')
  }
}

export function exportGeneratedTool(
  toolId: string,
  versionId: string,
  jokerHome: string
): GeneratedToolExportResult {
  try {
    const version = readGeneratedToolVersion(jokerHome, toolId, versionId)
    const root = generatedToolsRoot(jokerHome)
    const artifactRoot = resolveRootRelativePath(root, version.artifactPath)
    assertPathHasNoSymlink(root, artifactRoot)
    const report = parseGeneratedToolValidationReport(JSON.parse(readFileSync(join(artifactRoot, 'validation-report.json'), 'utf8')))
    const files: Array<{ path: string; content: string; sha256: string }> = []
    for (const directory of ['source', 'dist']) readFiles(root, join(artifactRoot, directory), files)
    files.sort((left, right) => left.path.localeCompare(right.path, 'en-US'))
    const data = {
      toolId: version.toolId,
      versionId: version.id,
      version: version.version,
      fingerprint: version.fingerprint,
      manifestHash: version.manifestHash,
      sourceHash: version.sourceHash,
      distHash: version.distHash,
      validationReportHash: sha256(canonicalGeneratedToolJson(report)),
      manifest: sanitizeManifest(version.manifest),
      validationReport: sanitizeReport(report),
      files,
    }
    return { success: true, data: { ...data, json: `${JSON.stringify(data, null, 2)}\n` } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message.replace(/[A-Za-z]:[\\/][^\\s;,)]+/g, '[path]').slice(0, 2_000) : 'Generated Tool export failed' }
  }
}
