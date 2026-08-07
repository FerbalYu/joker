import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertCaseFoldUniqueArtifactPaths, fingerprintGeneratedToolArtifact } from './fingerprint'

const manifest = {
  schemaVersion: 1 as const,
  toolId: 'tool-1',
  displayName: 'Tool One',
  description: 'Fixture tool.',
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm' as const, version: '0.32.0' },
  entrypoint: 'dist/tool.js',
  inputSchema: {}, outputSchema: {}, errorContract: {},
  permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
  dependencies: [],
  limits: { timeoutMs: 1000, maxInputBytes: 1000, maxOutputBytes: 1000, maxMemoryBytes: 10_000_000 }
}

function fixture(): { home: string; root: string; artifact: string } {
  const home = mkdtempSync(join(tmpdir(), 'joker-toolforge-fingerprint-'))
  const root = join(home, '.joker', 'generated-tools')
  const artifact = join(root, 'staging', 'candidate')
  mkdirSync(join(artifact, 'source'), { recursive: true })
  mkdirSync(join(artifact, 'dist'), { recursive: true })
  writeFileSync(join(artifact, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  writeFileSync(join(artifact, 'source', 'tool.js'), 'source-one', 'utf8')
  writeFileSync(join(artifact, 'dist', 'tool.js'), 'dist-one', 'utf8')
  return { home, root, artifact }
}

void test('fingerprint binds canonical manifest and raw source/dist bytes with separate domains', () => {
  const { home, root, artifact } = fixture()
  try {
    const first = fingerprintGeneratedToolArtifact(root, 'staging/candidate')
    writeFileSync(join(artifact, 'source', 'tool.js'), 'source-two', 'utf8')
    const sourceChanged = fingerprintGeneratedToolArtifact(root, 'staging/candidate')
    assert.notEqual(sourceChanged.sourceHash, first.sourceHash)
    assert.equal(sourceChanged.distHash, first.distHash)
    assert.notEqual(sourceChanged.fingerprint, first.fingerprint)
    writeFileSync(join(artifact, 'source', 'tool.js'), 'source-one', 'utf8')
    writeFileSync(join(artifact, 'dist', 'tool.js'), 'source-one', 'utf8')
    const equalBytesDifferentDomain = fingerprintGeneratedToolArtifact(root, 'staging/candidate')
    assert.notEqual(equalBytesDifferentDomain.sourceHash, equalBytesDifferentDomain.distHash)
    writeFileSync(join(artifact, 'manifest.json'), JSON.stringify({ ...manifest, description: 'Changed.' }), 'utf8')
    assert.notEqual(fingerprintGeneratedToolArtifact(root, 'staging/candidate').manifestHash, first.manifestHash)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('fingerprint is stable across manifest key order and directory enumeration order', () => {
  const { home, root, artifact } = fixture()
  try {
    writeFileSync(join(artifact, 'source', 'z.js'), 'z', 'utf8')
    writeFileSync(join(artifact, 'source', 'a.js'), 'a', 'utf8')
    const first = fingerprintGeneratedToolArtifact(root, 'staging/candidate')
    const parsed = JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(artifact, 'manifest.json'), JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())), 'utf8')
    assert.deepEqual(fingerprintGeneratedToolArtifact(root, 'staging/candidate'), first)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('fingerprint rejects symlinked artifact entries', () => {
  const { home, root, artifact } = fixture()
  try {
    const target = join(home, 'outside.txt')
    writeFileSync(target, 'outside', 'utf8')
    try {
      symlinkSync(target, join(artifact, 'source', 'link.txt'), 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    assert.throws(() => fingerprintGeneratedToolArtifact(root, 'staging/candidate'), /symlink/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('case-fold duplicate detection is platform-independent at the logical path layer', () => {
  assert.throws(() => assertCaseFoldUniqueArtifactPaths(['Case/file.js', 'case/file.js']), /Case-folded duplicate/)
  assert.doesNotThrow(() => assertCaseFoldUniqueArtifactPaths(['one/file.js', 'two/file.js']))
})
