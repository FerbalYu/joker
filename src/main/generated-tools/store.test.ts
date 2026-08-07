import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GeneratedToolValidationReport, GeneratedToolVersion } from '../../shared/generated-tools'
import { fingerprintGeneratedToolArtifact } from './fingerprint'
import { generatedToolsRoot, publishGeneratedToolBundle } from './store'

const manifest = {
  schemaVersion: 1 as const, toolId: 'tool-1', displayName: 'Tool One', description: 'Fixture.', sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm' as const, version: '0.32.0' }, entrypoint: 'dist/tool.js', inputSchema: {}, outputSchema: {}, errorContract: {},
  permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
  dependencies: [], limits: { timeoutMs: 1000, maxInputBytes: 1000, maxOutputBytes: 1000, maxMemoryBytes: 10_000_000 }
}

function staged(home: string): { root: string; artifact: string; version: GeneratedToolVersion } {
  const root = generatedToolsRoot(home)
  const artifact = join(root, 'staging', 'candidate')
  for (const dir of ['source', 'dist', 'evidence', 'logs']) mkdirSync(join(artifact, dir), { recursive: true })
  writeFileSync(join(artifact, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(artifact, 'source', 'tool.js'), 'source')
  writeFileSync(join(artifact, 'dist', 'tool.js'), 'dist')
  writeFileSync(join(artifact, 'evidence', 'schema.json'), '{}')
  writeFileSync(join(artifact, 'logs', 'validate.log'), 'ok')
  const fingerprint = fingerprintGeneratedToolArtifact(root, 'staging/candidate')
  const report: GeneratedToolValidationReport = {
    id: 'report-1', toolId: 'tool-1', versionId: 'version-1', artifactFingerprint: fingerprint.fingerprint,
    startedAt: 1, finishedAt: 2, status: 'passed', checks: [{ id: 'schema', category: 'schema', status: 'passed', evidencePath: 'evidence/schema.json', message: 'ok' }],
    declaredPermissions: manifest.permissions, observedCapabilities: [], logsPath: 'logs/validate.log'
  }
  const version: GeneratedToolVersion = {
    id: 'version-1', toolId: 'tool-1', version: 1, ...fingerprint, artifactPath: 'tools/tool-1/versions/version-1', validationReportId: 'report-1', trustState: 'trusted', createdAt: 2
  }
  writeFileSync(join(artifact, 'validation-report.json'), JSON.stringify(report))
  writeFileSync(join(artifact, 'version.json'), JSON.stringify(version))
  return { root, artifact, version }
}

void test('bundle publication verifies all staged metadata before immutable visibility and exact replay is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-publish-'))
  try {
    const { root, version } = staged(home)
    const result = publishGeneratedToolBundle({ root, stagingRootRelativePath: 'staging/candidate', version })
    assert.deepEqual(result, { artifactPath: version.artifactPath, idempotent: false })
    assert.equal(existsSync(join(root, ...version.artifactPath.split('/'))), true)
    assert.deepEqual(publishGeneratedToolBundle({ root, stagingRootRelativePath: 'staging/missing', version }), { artifactPath: version.artifactPath, idempotent: true })
    assert.throws(() => publishGeneratedToolBundle({ root, stagingRootRelativePath: 'staging/missing', version: { ...version, fingerprint: 'f'.repeat(64) } }))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('bundle publication rejects non-trusted versions', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-publish-'))
  try {
    const { root, version } = staged(home)
    assert.throws(() => publishGeneratedToolBundle({ root, stagingRootRelativePath: 'staging/candidate', version: { ...version, trustState: 'changed' } }), /trusted/)
    assert.equal(existsSync(join(root, ...version.artifactPath.split('/'))), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('bundle publication rejects report permissions that differ from the artifact manifest', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-publish-'))
  try {
    const { root, artifact, version } = staged(home)
    const reportPath = join(artifact, 'validation-report.json')
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as GeneratedToolValidationReport
    report.declaredPermissions = { ...report.declaredPermissions, network: { hosts: ['example.com'] } }
    writeFileSync(reportPath, JSON.stringify(report))
    assert.throws(() => publishGeneratedToolBundle({ root, stagingRootRelativePath: 'staging/candidate', version }), /permissions do not match/)
    assert.equal(existsSync(join(root, ...version.artifactPath.split('/'))), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('bundle publication rejects missing or symlinked artifact-local evidence before destination appears', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-publish-'))
  try {
    const { root, artifact, version } = staged(home)
    rmSync(join(artifact, 'evidence', 'schema.json'))
    assert.throws(() => publishGeneratedToolBundle({ root, stagingRootRelativePath: 'staging/candidate', version }), /evidence is missing/)
    assert.equal(existsSync(join(root, ...version.artifactPath.split('/'))), false)
    writeFileSync(join(artifact, 'evidence', 'schema.json'), '{}')
    const outside = join(home, 'outside.log')
    writeFileSync(outside, 'outside')
    rmSync(join(artifact, 'logs', 'validate.log'))
    try { symlinkSync(outside, join(artifact, 'logs', 'validate.log'), 'file') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    assert.throws(() => publishGeneratedToolBundle({ root, stagingRootRelativePath: 'staging/candidate', version }), /symlink/)
    assert.equal(existsSync(join(root, ...version.artifactPath.split('/'))), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
