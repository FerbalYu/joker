import test from 'node:test'
import assert from 'node:assert/strict'
import type { GeneratedToolCandidate, GeneratedToolManifest, GeneratedToolValidationReport, GeneratedToolVersion } from '../../shared/generated-tools'
import { buildGeneratedToolEditDiff, permissionDiff } from './edit-diff'

const permissions = (read: string[] = []) => ({ filesystem: { read, write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } })
const manifest = (_source: string, read: string[] = []): GeneratedToolManifest => ({ schemaVersion: 1, toolId: 'edit-diff-tool', displayName: 'Edit Diff Tool', description: 'Fixture', sdkVersion: '1', runtime: { id: 'quickjs-wasm', version: '1' }, entrypoint: 'dist/tool.js', inputSchema: { type: 'object' }, outputSchema: { type: 'string' }, errorContract: {}, permissions: permissions(read), dependencies: [], limits: { timeoutMs: 1, maxInputBytes: 1, maxOutputBytes: 1, maxMemoryBytes: 1 } })
const report = (id: string, status: 'passed' | 'failed'): GeneratedToolValidationReport => ({ id, toolId: 'edit-diff-tool', versionId: id, artifactFingerprint: 'a'.repeat(64), startedAt: 1, finishedAt: 2, status, checks: [{ id: 'check', category: 'schema', status: status === 'passed' ? 'passed' : 'failed', message: status }], declaredPermissions: permissions(), observedCapabilities: [], logsPath: 'logs/check' })

void test('edit diff identifies schema, source and permission expansion', () => {
  const baseManifest = manifest('v1', ['fixtures/a.json'])
  const candidateManifest = manifest('v2', ['fixtures/a.json', 'fixtures/b.json'])
  const base: GeneratedToolVersion = { id: 'version-1', toolId: 'edit-diff-tool', version: 1, fingerprint: '1'.repeat(64), manifestHash: '2'.repeat(64), sourceHash: '3'.repeat(64), distHash: '4'.repeat(64), manifest: baseManifest, artifactPath: 'tools/edit-diff-tool/versions/version-1', validationReportId: 'report-1', trustState: 'trusted', createdAt: 1 }
  const candidate: GeneratedToolCandidate = { schemaVersion: 1, id: 'candidate-2', jobId: 'job-1', toolId: 'edit-diff-tool', attempt: 1, attemptRecordId: 'attempt-1', artifactPath: 'jobs/job-1/candidates/candidate-2/artifact', artifactFingerprint: '5'.repeat(64), manifestHash: '6'.repeat(64), sourceHash: '7'.repeat(64), distHash: '8'.repeat(64), manifest: candidateManifest, specHash: '9'.repeat(64), validationProfile: 'gate2-project-read-v1', validationPlan: { schemaVersion: 1, id: 'host-compiled-validation-plan-v1', cases: [{ id: 'legacy-example-1', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } }] }, validationPlanHash: 'a'.repeat(64), createdAt: 2 }
  const diff = buildGeneratedToolEditDiff(base, candidate, report('report-1', 'passed'), report('candidate-2', 'failed'))
  assert.equal(diff.sourceChanged, true)
  assert.equal(diff.permissions.expanded, true)
  assert.deepEqual(diff.permissions.added, ['filesystem.read:fixtures/b.json'])
  assert.deepEqual(diff.validation.failed, ['check'])
})

void test('permission diff reports removals without treating them as expansion', () => {
  const before = manifest('v1', ['a'])
  const after = manifest('v2')
  assert.deepEqual(permissionDiff(before, after), { added: [], removed: ['filesystem.read:a'], expanded: false, categories: [] })
})
