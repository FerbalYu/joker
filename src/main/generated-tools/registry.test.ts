import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GeneratedToolDescriptor, GeneratedToolValidationReport, GeneratedToolVersion } from '../../shared/generated-tools'
import { fingerprintGeneratedToolArtifact } from './fingerprint'
import {
  disableGeneratedTool,
  promoteGeneratedTool,
  readGeneratedToolRegistry,
  registerGeneratedToolVersion,
  rollbackGeneratedTool,
  ToolForgeCasError
} from './registry'
import { generatedToolsRoot, publishGeneratedToolBundle } from './store'

const manifest = {
  schemaVersion: 1 as const, toolId: 'tool-1', displayName: 'Tool One', description: 'Fixture.', sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm' as const, version: '0.32.0' }, entrypoint: 'dist/tool.js', inputSchema: {}, outputSchema: {}, errorContract: {},
  permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
  dependencies: [], limits: { timeoutMs: 1000, maxInputBytes: 1000, maxOutputBytes: 1000, maxMemoryBytes: 10_000_000 }
}

function stage(home: string, options: { versionId?: string; versionNumber?: number; source?: string } = {}): { version: GeneratedToolVersion; descriptor: GeneratedToolDescriptor } {
  const versionId = options.versionId ?? 'version-1'
  const versionNumber = options.versionNumber ?? 1
  const root = generatedToolsRoot(home)
  const artifactPath = `staging/${versionId}`
  const artifact = join(root, 'staging', versionId)
  mkdirSync(join(artifact, 'source'), { recursive: true })
  mkdirSync(join(artifact, 'dist'), { recursive: true })
  mkdirSync(join(artifact, 'evidence'), { recursive: true })
  mkdirSync(join(artifact, 'logs'), { recursive: true })
  writeFileSync(join(artifact, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(artifact, 'source', 'tool.js'), options.source ?? 'source')
  writeFileSync(join(artifact, 'dist', 'tool.js'), options.source ?? 'dist')
  writeFileSync(join(artifact, 'evidence', 'schema.json'), '{}')
  writeFileSync(join(artifact, 'logs', 'validate.log'), 'ok')
  const fingerprint = fingerprintGeneratedToolArtifact(root, artifactPath)
  const report: GeneratedToolValidationReport = {
    id: `report-${versionId}`, toolId: 'tool-1', versionId, artifactFingerprint: fingerprint.fingerprint,
    startedAt: 1, finishedAt: 2, status: 'passed', checks: [{ id: 'schema', category: 'schema', status: 'passed', evidencePath: 'evidence/schema.json', message: 'ok' }],
    declaredPermissions: manifest.permissions, observedCapabilities: [], logsPath: 'logs/validate.log'
  }
  const version: GeneratedToolVersion = {
    id: versionId, toolId: 'tool-1', version: versionNumber, ...fingerprint, artifactPath: `tools/tool-1/versions/${versionId}`,
    validationReportId: report.id, trustState: 'trusted', createdAt: 2
  }
  writeFileSync(join(artifact, 'validation-report.json'), JSON.stringify(report))
  writeFileSync(join(artifact, 'version.json'), JSON.stringify(version))
  const descriptor: GeneratedToolDescriptor = {
    id: 'tool-1', displayName: 'Tool One', description: 'Fixture.', scope: 'user', availability: 'building', createdBy: 'joker',
    permissionSummary: [], invocationCount: 0, createdAt: 1, updatedAt: 2
  }
  return { version, descriptor }
}

void test('cold registry identity is durable and operations enforce CAS/idempotency', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-registry-'))
  try {
    const initial = readGeneratedToolRegistry(home)
    assert.equal(readGeneratedToolRegistry(home).registryId, initial.registryId)
    const { version, descriptor } = stage(home)
    publishGeneratedToolBundle({ root: generatedToolsRoot(home), stagingRootRelativePath: `staging/${version.id}`, version })
    const registered = registerGeneratedToolVersion({ jokerHome: home, registryId: initial.registryId, expectedRevision: 0, operationId: 'register-1', createdAt: 3, descriptor, version })
    assert.equal(registered.state.revision, 1)
    const replay = registerGeneratedToolVersion({ jokerHome: home, registryId: initial.registryId, expectedRevision: 0, operationId: 'register-1', createdAt: 3, descriptor, version })
    assert.equal(replay.idempotent, true)
    assert.equal(replay.state.revision, 1)
    assert.throws(() => registerGeneratedToolVersion({ jokerHome: home, registryId: initial.registryId, expectedRevision: 0, operationId: 'register-2', createdAt: 3, descriptor, version }), ToolForgeCasError)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('registering v2 preserves the active v1 pointer and enforces contiguous version numbers', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-registry-'))
  try {
    const initial = readGeneratedToolRegistry(home)
    const first = stage(home)
    publishGeneratedToolBundle({ root: generatedToolsRoot(home), stagingRootRelativePath: `staging/${first.version.id}`, version: first.version })
    registerGeneratedToolVersion({ jokerHome: home, registryId: initial.registryId, expectedRevision: 0, operationId: 'register-1', createdAt: 3, descriptor: first.descriptor, version: first.version })
    promoteGeneratedTool({ jokerHome: home, registryId: initial.registryId, expectedRevision: 1, operationId: 'promote-1', createdAt: 4, toolId: 'tool-1', versionId: 'version-1' })

    const second = stage(home, { versionId: 'version-2', versionNumber: 2, source: 'second' })
    publishGeneratedToolBundle({ root: generatedToolsRoot(home), stagingRootRelativePath: `staging/${second.version.id}`, version: second.version })
    const registered = registerGeneratedToolVersion({ jokerHome: home, registryId: initial.registryId, expectedRevision: 2, operationId: 'register-2', createdAt: 5, descriptor: second.descriptor, version: second.version }).state
    assert.deepEqual(registered.entries[0].versionIds, ['version-1', 'version-2'])
    assert.equal(registered.entries[0].descriptor.activeVersionId, 'version-1')
    assert.equal(registered.activePointers[0].activeVersionId, 'version-1')
    assert.equal(registered.capabilityRevision.revision, 1)

    const skipped = stage(home, { versionId: 'version-3', versionNumber: 4, source: 'skipped' })
    publishGeneratedToolBundle({ root: generatedToolsRoot(home), stagingRootRelativePath: `staging/${skipped.version.id}`, version: skipped.version })
    assert.throws(() => registerGeneratedToolVersion({ jokerHome: home, registryId: initial.registryId, expectedRevision: 3, operationId: 'register-3', createdAt: 6, descriptor: skipped.descriptor, version: skipped.version }), /strictly append-only/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('promote and disable update descriptor, pointer, and capability revision atomically', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-registry-'))
  try {
    const initial = readGeneratedToolRegistry(home)
    const { version, descriptor } = stage(home)
    publishGeneratedToolBundle({ root: generatedToolsRoot(home), stagingRootRelativePath: `staging/${version.id}`, version })
    const registered = registerGeneratedToolVersion({ jokerHome: home, registryId: initial.registryId, expectedRevision: 0, operationId: 'register-1', createdAt: 3, descriptor, version })
    const promoted = promoteGeneratedTool({ jokerHome: home, registryId: initial.registryId, expectedRevision: 1, operationId: 'promote-1', createdAt: 4, toolId: 'tool-1', versionId: 'version-1' }).state
    assert.equal(promoted.entries[0].descriptor.availability, 'available')
    assert.equal(promoted.activePointers[0].activeVersionId, 'version-1')
    assert.equal(promoted.capabilityRevision.revision, 1)
    assert.equal(promoted.capabilityRevision.operationId, 'promote-1')
    const disabled = disableGeneratedTool({ jokerHome: home, registryId: initial.registryId, expectedRevision: 2, operationId: 'disable-1', createdAt: 5, toolId: 'tool-1' }).state
    assert.equal(disabled.entries[0].descriptor.availability, 'disabled')
    assert.equal(disabled.activePointers[0].activeVersionId, undefined)
    assert.equal(disabled.activePointers[0].lastStableVersionId, 'version-1')
    assert.equal(disabled.capabilityRevision.revision, 2)
    const rolledBack = rollbackGeneratedTool({ jokerHome: home, registryId: initial.registryId, expectedRevision: 3, operationId: 'rollback-1', createdAt: 6, toolId: 'tool-1', versionId: 'version-1' }).state
    assert.equal(rolledBack.entries[0].descriptor.availability, 'available')
    assert.equal(rolledBack.activePointers[0].activeVersionId, 'version-1')
    assert.equal(rolledBack.capabilityRevision.revision, 3)
    assert.equal(rolledBack.capabilityRevision.reason, 'tool-rolled-back')
    assert.equal(registered.state.capabilityRevision.revision, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
