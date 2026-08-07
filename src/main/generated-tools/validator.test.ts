import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ForgeJob, GeneratedToolManifest } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'
import { sealGeneratedToolCandidate } from './candidate-store'
import { createForgeJob, updateForgeJob } from './forge-job-store'
import { generatedToolsRoot } from './store'
import { installRuntimeQualificationFixture } from './test-fixtures'
import { validateGeneratedToolCandidate } from './validator'
import {
  fingerprintGeneratedToolValidationSuite,
  registerGeneratedToolValidationSuite,
  type GeneratedToolValidationSuite
} from './validation-suite'

const suite: GeneratedToolValidationSuite = {
  id: 'validator-test-v1',
  toolId: 'validator-test-tool',
  cases: [
    { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } },
    { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
  ]
}
registerGeneratedToolValidationSuite(suite)

const manifest: GeneratedToolManifest = {
  schemaVersion: 1,
  toolId: suite.toolId,
  displayName: 'ValidatorTestTool',
  description: 'Validator deterministic fixture.',
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm', version: '0.32.0' },
  entrypoint: 'dist/tool.js',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'string' },
  errorContract: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
  dependencies: [],
  limits: { timeoutMs: 500, maxInputBytes: 1024, maxOutputBytes: 4096, maxMemoryBytes: 32_000_000 }
}

function source(kind: 'success' | 'fake-success' | 'overreach'): string {
  if (kind === 'fake-success') return 'if (input.fail) tool.output("ERROR: expected-failure"); else tool.output("ok")'
  if (kind === 'overreach') return 'try { tool.readFile("undeclared.txt") } catch (_) {} if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'
  return 'if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'
}

function setup(home: string, kind: Parameters<typeof source>[0], level: 'L1' | 'L2' = 'L2'): ForgeJob {
  installRuntimeQualificationFixture(home, level)
  const spec: ForgeJob['spec'] = {
    id: manifest.toolId, displayName: manifest.displayName, goal: 'Pass host validation', reason: 'Capability missing',
    requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project', projectId: 'project-1',
    inputContract: manifest.inputSchema, outputContract: manifest.outputSchema, permissions: manifest.permissions,
    acceptance: ['Passes success and explicit failure cases.'], examples: [{ input: {}, expected: 'ok' }]
  }
  const job: ForgeJob = {
    id: `job-${kind}`, idempotencyKey: `idem-${kind}`,
    specHash: createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex'),
    toolId: spec.id, mode: 'create', status: 'queued', revision: 0, spec, attempt: 1, maxAttempts: 3,
    createdAt: 1, updatedAt: 1, artifactPath: `jobs/job-${kind}/workspace`
  }
  const workspace = join(generatedToolsRoot(home), ...job.artifactPath.split('/'))
  mkdirSync(join(workspace, 'source'), { recursive: true })
  mkdirSync(join(workspace, 'dist'), { recursive: true })
  writeFileSync(join(workspace, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(workspace, 'source', 'tool.js'), source(kind), 'utf8')
  writeFileSync(join(workspace, 'dist', 'tool.js'), source(kind), 'utf8')
  createForgeJob(home, job)
  updateForgeJob(home, job.id, 0, (current) => ({ ...current, revision: 1, status: 'planning', startedAt: 2, updatedAt: 2 }))
  const building = updateForgeJob(home, job.id, 1, (current) => ({ ...current, revision: 2, status: 'building', updatedAt: 3 }))
  return sealGeneratedToolCandidate({
    jokerHome: home,
    jobId: job.id,
    expectedRevision: building.revision,
    validationSuiteId: suite.id,
    validationSuiteHash: fingerprintGeneratedToolValidationSuite(suite),
    createdAt: 4,
    validationRunId: `validation-${kind}`
  }).job
}

void test('deterministic validator passes a truthful candidate and stops awaiting policy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-validator-'))
  try {
    const validating = setup(home, 'success')
    const result = await validateGeneratedToolCandidate(home, validating.id, validating.revision)
    assert.equal(result.report?.status, 'passed')
    assert.equal(result.job.status, 'awaiting-policy')
    assert.equal(result.job.validationReportId, result.report?.id)
    assert.equal(result.report?.checks.every((item) => item.status === 'passed'), true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('deterministic validator permits functional validation at L1 for supervised promotion', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-validator-l1-'))
  try {
    const validating = setup(home, 'success', 'L1')
    const result = await validateGeneratedToolCandidate(home, validating.id, validating.revision)
    assert.equal(result.report?.status, 'passed')
    assert.equal(result.job.status, 'awaiting-policy')
    assert.equal(result.report?.checks.find((item) => item.id === 'runtime-qualified')?.status, 'passed')
    assert.equal(result.report?.checks.find((item) => item.id === 'acceptance-success')?.status, 'passed')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('deterministic validator rejects misleading output as unexpected success', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-validator-'))
  try {
    const validating = setup(home, 'fake-success')
    const result = await validateGeneratedToolCandidate(home, validating.id, validating.revision)
    assert.equal(result.report?.status, 'failed')
    assert.equal(result.job.status, 'failed')
    assert.equal(result.report?.checks.find((item) => item.id === 'acceptance-explicit-failure')?.status, 'failed')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('deterministic validator quarantines caught undeclared capability attempts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-validator-'))
  try {
    const validating = setup(home, 'overreach')
    const result = await validateGeneratedToolCandidate(home, validating.id, validating.revision)
    assert.equal(result.report?.status, 'quarantined')
    assert.equal(result.job.status, 'failed')
    assert.equal(result.report?.checks.find((item) => item.id === 'capability-conformance')?.status, 'failed')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
