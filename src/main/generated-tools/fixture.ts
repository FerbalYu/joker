import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GeneratedToolDescriptor, GeneratedToolManifest, GeneratedToolValidationReport, GeneratedToolVersion } from '../../shared/generated-tools'
import { parseGeneratedToolManifest } from '../../shared/generated-tools-schema'
import { fingerprintGeneratedToolArtifact } from './fingerprint'
import { promoteGeneratedTool, readGeneratedToolRegistry, registerGeneratedToolVersion } from './registry'
import { canonicalVersionPath, generatedToolsRoot, publishGeneratedToolBundle } from './store'

const FIXTURE_TOOL_ID = 'summarize-task-json'
const FIXTURE_VERSION_ID = 'v1'
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export interface InstallSummarizeTaskJsonFixtureOptions {
  fixtureRoot?: string
}

function defaultFixtureRoot(): string {
  return process.env['JOKER_TOOLFORGE_FIXTURE_ROOT']?.trim()
    || join(process.cwd(), 'scripts', 'fixtures', 'generated-tools', FIXTURE_TOOL_ID)
}

export function installSummarizeTaskJsonFixture(
  jokerHome: string,
  installedAt = Date.now(),
  options: InstallSummarizeTaskJsonFixtureOptions = {}
): GeneratedToolVersion {
  const existingRegistry = readGeneratedToolRegistry(jokerHome)
  const existingEntry = existingRegistry.entries.find((entry) => entry.toolId === FIXTURE_TOOL_ID)
  if (existingEntry?.versionIds.includes(FIXTURE_VERSION_ID)) {
    const path = join(generatedToolsRoot(jokerHome), ...canonicalVersionPath(FIXTURE_TOOL_ID, FIXTURE_VERSION_ID).split('/'), 'version.json')
    const version = JSON.parse(readFileSync(path, 'utf8')) as GeneratedToolVersion
    const pointer = existingRegistry.activePointers.find((item) => item.toolId === FIXTURE_TOOL_ID)
    if (pointer?.activeVersionId !== FIXTURE_VERSION_ID || existingEntry.descriptor.availability !== 'available') {
      promoteGeneratedTool({
        jokerHome,
        registryId: existingRegistry.registryId,
        expectedRevision: existingRegistry.revision,
        operationId: `${FIXTURE_TOOL_ID}-${FIXTURE_VERSION_ID}-bootstrap-promote-${existingRegistry.revision}`,
        createdAt: installedAt,
        toolId: FIXTURE_TOOL_ID,
        versionId: FIXTURE_VERSION_ID
      })
    }
    return version
  }

  const root = generatedToolsRoot(jokerHome)
  const stagingRelative = `staging/fixture-${FIXTURE_TOOL_ID}-${FIXTURE_VERSION_ID}`
  const staging = join(root, ...stagingRelative.split('/'))
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(staging, 'source'), { recursive: true })
  mkdirSync(join(staging, 'dist'), { recursive: true })
  mkdirSync(join(staging, 'evidence'), { recursive: true })
  mkdirSync(join(staging, 'logs'), { recursive: true })
  const sourceRoot = options.fixtureRoot ?? defaultFixtureRoot()
  const manifest = parseGeneratedToolManifest(JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8'))) as GeneratedToolManifest
  const sourcePath = join(sourceRoot, 'source', 'tool.js')
  cpSync(sourcePath, join(staging, 'source', 'tool.js'))
  cpSync(sourcePath, join(staging, 'dist', 'tool.js'))
  writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify({ ...manifest, entrypoint: 'dist/tool.js' }, null, 2)}\n`, 'utf8')
  const fingerprint = fingerprintGeneratedToolArtifact(root, stagingRelative)
  const reportId = `${FIXTURE_TOOL_ID}-${FIXTURE_VERSION_ID}-report`
  const checkIds = ['schema', 'build', 'unit', 'contract', 'permission', 'timeout', 'recovery', 'audit'] as const
  const checks = checkIds.map((category) => {
    const evidencePath = `evidence/${category}.json`
    writeFileSync(join(staging, ...evidencePath.split('/')), `${JSON.stringify({ toolId: FIXTURE_TOOL_ID, versionId: FIXTURE_VERSION_ID, category, status: 'passed' }, null, 2)}\n`, 'utf8')
    return {
      id: `${category}-check`,
      category,
      status: 'passed' as const,
      evidencePath,
      evidenceHash: sha256(readFileSync(join(staging, ...evidencePath.split('/')), 'utf8')),
      message: `${category} fixture qualification passed`
    }
  })
  const report: GeneratedToolValidationReport = {
    id: reportId,
    toolId: FIXTURE_TOOL_ID,
    versionId: FIXTURE_VERSION_ID,
    artifactFingerprint: fingerprint.fingerprint,
    startedAt: installedAt,
    finishedAt: installedAt,
    status: 'passed',
    checks,
    declaredPermissions: fingerprint.manifest.permissions,
    observedCapabilities: ['filesystem.read'],
    logsPath: 'logs/validator.log'
  }
  writeFileSync(join(staging, 'logs', 'validator.log'), 'fixture validation passed\n', 'utf8')
  const version: GeneratedToolVersion = {
    id: FIXTURE_VERSION_ID,
    toolId: FIXTURE_TOOL_ID,
    version: 1,
    ...fingerprint,
    artifactPath: canonicalVersionPath(FIXTURE_TOOL_ID, FIXTURE_VERSION_ID),
    validationReportId: reportId,
    trustState: 'trusted',
    createdAt: installedAt
  }
  writeFileSync(join(staging, 'validation-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(join(staging, 'version.json'), `${JSON.stringify(version, null, 2)}\n`, 'utf8')
  publishGeneratedToolBundle({ root, stagingRootRelativePath: stagingRelative, version })
  const descriptor: GeneratedToolDescriptor = {
    id: FIXTURE_TOOL_ID,
    displayName: fingerprint.manifest.displayName,
    description: fingerprint.manifest.description,
    scope: 'project',
    projectId: 'qualification-p0',
    availability: 'building',
    createdBy: 'joker',
    permissionSummary: ['project read: fixtures/tasks.json'],
    invocationCount: 0,
    createdAt: installedAt,
    updatedAt: installedAt
  }
  const registry = readGeneratedToolRegistry(jokerHome)
  const registered = registerGeneratedToolVersion({
    jokerHome,
    registryId: registry.registryId,
    expectedRevision: registry.revision,
    operationId: `${FIXTURE_TOOL_ID}-${FIXTURE_VERSION_ID}-register`,
    createdAt: installedAt,
    descriptor,
    version
  }).state
  const pointer = registered.activePointers.find((item) => item.toolId === FIXTURE_TOOL_ID)
  if (pointer?.activeVersionId !== FIXTURE_VERSION_ID) {
    promoteGeneratedTool({
      jokerHome,
      registryId: registered.registryId,
      expectedRevision: registered.revision,
      operationId: `${FIXTURE_TOOL_ID}-${FIXTURE_VERSION_ID}-promote`,
      createdAt: installedAt,
      toolId: FIXTURE_TOOL_ID,
      versionId: FIXTURE_VERSION_ID
    })
  }
  return version
}

export function fixtureIsInstalled(jokerHome: string): boolean {
  return existsSync(join(generatedToolsRoot(jokerHome), ...canonicalVersionPath(FIXTURE_TOOL_ID, FIXTURE_VERSION_ID).split('/'), 'version.json'))
}
