import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { GeneratedToolDescriptor, GeneratedToolVersion } from '../../shared/generated-tools'
import { GeneratedToolEditRequestSchema } from '../../shared/generated-tools-management'
import { readGeneratedToolRegistry, registerGeneratedToolVersion, promoteGeneratedTool } from './registry'
import { generatedToolsRoot, publishGeneratedToolBundle } from './store'
import { fingerprintGeneratedToolArtifact } from './fingerprint'
import { readForgeJob, updateForgeJob } from './forge-job-store'
import { ForgeWorkspaceBroker } from './forge-workspace'
import { GeneratedToolEditService } from './edit-service'
import { registerGeneratedToolValidationSuite } from './validation-suite'

const manifest = {
  schemaVersion: 1 as const,
  toolId: 'edit-test-tool',
  displayName: 'Edit Test Tool',
  description: 'Stable test tool.',
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm' as const, version: '0.32.0' },
  entrypoint: 'source/tool.js',
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'string' },
  errorContract: { type: 'object' },
  permissions: { filesystem: { read: [], write: [] }, network: { hosts: [], methods: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
  dependencies: [],
  limits: { timeoutMs: 1000, maxInputBytes: 4096, maxOutputBytes: 4096, maxMemoryBytes: 32_000_000 }
}

function installVersion(home: string): GeneratedToolVersion {
  const root = generatedToolsRoot(home)
  const staging = join(root, 'staging', 'version-1')
  mkdirSync(join(staging, 'source'), { recursive: true })
  mkdirSync(join(staging, 'dist'), { recursive: true })
  mkdirSync(join(staging, 'evidence'), { recursive: true })
  mkdirSync(join(staging, 'logs'), { recursive: true })
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(staging, 'source', 'tool.js'), 'tool.output("v1")')
  writeFileSync(join(staging, 'dist', 'tool.js'), 'tool.output("v1")')
  writeFileSync(join(staging, 'evidence', 'check.json'), '{"id":"check"}')
  writeFileSync(join(staging, 'logs', 'validate.log'), 'ok')
  const fingerprint = fingerprintGeneratedToolArtifact(root, 'staging/version-1')
  const report = { id: 'report-version-1', toolId: manifest.toolId, versionId: 'version-1', artifactFingerprint: fingerprint.fingerprint, startedAt: 1, finishedAt: 2, status: 'passed', checks: [{ id: 'check', category: 'schema', status: 'passed', evidencePath: 'evidence/check.json', message: 'ok' }], declaredPermissions: manifest.permissions, observedCapabilities: [], logsPath: 'logs/validate.log' }
  const version: GeneratedToolVersion = { id: 'version-1', toolId: manifest.toolId, version: 1, ...fingerprint, artifactPath: 'tools/edit-test-tool/versions/version-1', validationReportId: report.id, trustState: 'trusted', createdAt: 2 }
  writeFileSync(join(staging, 'validation-report.json'), JSON.stringify(report))
  writeFileSync(join(staging, 'version.json'), JSON.stringify(version))
  publishGeneratedToolBundle({ root, stagingRootRelativePath: 'staging/version-1', version })
  const registry = readGeneratedToolRegistry(home)
  const descriptor: GeneratedToolDescriptor = { id: manifest.toolId, displayName: manifest.displayName, description: manifest.description, scope: 'user', availability: 'building', createdBy: 'joker', permissionSummary: [], invocationCount: 0, createdAt: 1, updatedAt: 2 }
  registerGeneratedToolVersion({ jokerHome: home, registryId: registry.registryId, expectedRevision: 0, operationId: 'register-version-1', createdAt: 2, descriptor, version })
  promoteGeneratedTool({ jokerHome: home, registryId: registry.registryId, expectedRevision: 1, operationId: 'promote-version-1', createdAt: 3, toolId: manifest.toolId, versionId: version.id })
  return version
}

void test('GeneratedToolEditRequest is strict and binds stable base identity', () => {
  assert.deepEqual(GeneratedToolEditRequestSchema.parse({ toolId: 'edit-test-tool', baseVersionId: 'version-1', baseFingerprint: 'a'.repeat(64), instruction: 'Change output wording', requestedFrom: 'settings' }).requestedFrom, 'settings')
  assert.throws(() => GeneratedToolEditRequestSchema.parse({ toolId: 'edit-test-tool', baseVersionId: 'version-1', baseFingerprint: 'a'.repeat(64), instruction: 'x', requestedFrom: 'settings', extra: true }))
})

void test('edit service creates mode edit job and rejects stale version or fingerprint', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-edit-service-'))
  try {
    const version = installVersion(home)
    registerGeneratedToolValidationSuite({
      id: 'edit-test-tool-v1',
      toolId: manifest.toolId,
      cases: [
        { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'v1' } },
        { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
      ]
    })
    const service = new GeneratedToolEditService({ jokerHome: home, createId: () => 'edit-job', now: () => 10, controller: { enqueue: () => true, cancel: async () => { throw new Error('not used') } } })
    const valid = service.start({ toolId: manifest.toolId, baseVersionId: version.id, baseFingerprint: version.fingerprint, instruction: 'Change output wording', requestedFrom: 'settings' }, 'session-1', 'run-1')
    assert.equal(valid.success, true)
    if (!valid.success) return
    assert.equal(valid.data.status, 'queued')
    const latest = JSON.parse(readFileSync(join(home, '.joker', 'generated-tools', 'jobs', valid.data.jobId, 'job.json'), 'utf8'))
    assert.equal(latest.mode, 'edit')
    assert.equal(latest.baseVersionId, version.id)
    const job = readForgeJob(home, valid.data.jobId)!
    updateForgeJob(home, job.id, job.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      status: 'planning',
      currentPhase: 'planning'
    }))
    const broker = new ForgeWorkspaceBroker(home, valid.data.jobId)
    assert.deepEqual(broker.listFiles().map((entry) => entry.path).sort(), ['dist/tool.js', 'manifest.json', 'source/tool.js'])
    assert.equal(broker.readFile('source/tool.js'), 'tool.output("v1")')
    assert.equal(readGeneratedToolRegistry(home).activePointers.find((pointer) => pointer.toolId === manifest.toolId)?.activeVersionId, version.id)
    const staleFingerprint = service.start({ toolId: manifest.toolId, baseVersionId: version.id, baseFingerprint: 'b'.repeat(64), instruction: 'x', requestedFrom: 'settings' }, 'session-1')
    assert.equal(staleFingerprint.success, false)
    const staleVersion = service.start({ toolId: manifest.toolId, baseVersionId: 'version-2', baseFingerprint: version.fingerprint, instruction: 'x', requestedFrom: 'settings' }, 'session-1')
    assert.equal(staleVersion.success, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
