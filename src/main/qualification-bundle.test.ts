import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildQualificationBundle } from '../../scripts/qualification-bundle.mjs'

void test('qualification bundle indexes retained QA artifacts and stays conservative about missing claims', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-qualification-bundle-'))
  try {
    mkdirSync(join(root, '.qa'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3' }), 'utf8')
    writeFileSync(join(root, '.qa', 'qualification.json'), JSON.stringify({
      generatedAt: '2026-08-05T00:00:00.000Z',
      platform: 'win32',
      checks: [{ id: 'toolforge.validation', status: 'pass' }],
      statusSummary: { pass: 1, fail: 0, 'not-verified': 0 }
    }), 'utf8')

    const result = buildQualificationBundle({ sourceRoot: root, outputRoot: join(root, 'output', 'qualification'), runId: 'fixture-run', indexOnly: true })
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.manifest.outputFiles, ['manifest.json', 'claim-matrix.json', 'gaps.json', 'SHA256SUMS.json'])
    assert.equal(result.manifest.environment.package.name, 'fixture')
    assert.equal(result.manifest.git.available, false)
    assert.ok(result.gaps.gaps.some((gap) => gap.id === 'claim.isolated-manufacturing' && gap.status === 'not-verified'))
    assert.match(result.sums.files['manifest.json'], /^[a-f0-9]{64}$/)
    assert.equal(JSON.parse(readFileSync(join(result.runDir, 'SHA256SUMS.json'), 'utf8')).selfExcluded, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('qualification bundle scopes expected-negative, expected-failure, and release-signing artifacts without turning them into ToolForge blockers', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-qualification-bundle-scope-'))
  try {
    mkdirSync(join(root, '.qa', 'runtime', '.joker', 'qualification', 'evidence-dev'), { recursive: true })
    mkdirSync(join(root, '.qa', 'toolforge-gate4-package-run', 'home', 'failure', '.joker', 'generated-tools', 'jobs', 'job-1'), { recursive: true })
    mkdirSync(join(root, '.qa', 'signed-local'), { recursive: true })
    writeFileSync(join(root, '.qa', 'runtime', '.joker', 'qualification', 'evidence-dev', 'node-vm-workspace-boundary.json'), JSON.stringify({ status: 'fail' }), 'utf8')
    writeFileSync(join(root, '.qa', 'toolforge-gate4-package-run', 'home', 'failure', '.joker', 'generated-tools', 'jobs', 'job-1', 'job.json'), JSON.stringify({ status: 'failed' }), 'utf8')
    writeFileSync(join(root, '.qa', 'signed-local', 'signed-release-report.json'), JSON.stringify({ status: 'fail' }), 'utf8')
    const result = buildQualificationBundle({ sourceRoot: root, outputRoot: join(root, 'output', 'qualification'), runId: 'scope-run' })
    assert.equal(result.gaps.gaps.filter((gap) => gap.id.startsWith('artifact.')).every((gap) => gap.status === 'not-verified'), true)
    assert.equal(result.gaps.gaps.some((gap) => gap.scope === 'expected-negative-runtime-control' && gap.severity === 'info'), true)
    assert.equal(result.gaps.gaps.some((gap) => gap.scope === 'expected-failure-scenario' && gap.severity === 'info'), true)
    assert.equal(result.gaps.gaps.some((gap) => gap.scope === 'release-signing' && gap.severity === 'medium'), true)
    assert.equal(result.status, 'not-verified')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('qualification bundle keeps unexpected retained failures blocking', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-qualification-bundle-blocking-'))
  try {
    mkdirSync(join(root, '.qa'), { recursive: true })
    writeFileSync(join(root, '.qa', 'unexpected.json'), JSON.stringify({ status: 'fail' }), 'utf8')
    const result = buildQualificationBundle({ sourceRoot: root, outputRoot: join(root, 'output', 'qualification'), runId: 'blocking-run' })
    const failure = result.gaps.gaps.find((gap) => gap.id === 'artifact..qa/unexpected.json')
    assert.equal(failure?.status, 'fail')
    assert.equal(failure?.scope, 'blocking')
    assert.equal(result.status, 'fail')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('qualification bundle refuses to overwrite an existing run id', () => {
  const root = mkdtempSync(join(tmpdir(), 'joker-qualification-bundle-existing-'))
  try {
    mkdirSync(join(root, '.qa'), { recursive: true })
    assert.throws(() => {
      buildQualificationBundle({ sourceRoot: root, outputRoot: join(root, 'output', 'qualification'), runId: 'same-run' })
      buildQualificationBundle({ sourceRoot: root, outputRoot: join(root, 'output', 'qualification'), runId: 'same-run' })
    }, /already exists/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
