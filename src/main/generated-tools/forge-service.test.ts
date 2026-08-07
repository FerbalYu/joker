import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ForgeJob } from '../../shared/generated-tools'
import { sealGeneratedToolCandidate } from './candidate-store'
import { createForgeJob, hashGeneratedToolSpec, readForgeJob } from './forge-job-store'
import { ForgeWorkspaceBroker } from './forge-workspace'
import { readGeneratedToolRegistry } from './registry'
import { ForgeService, type ForgeServiceMaker } from './forge-service'
import { installRuntimeQualificationFixture } from './test-fixtures'
import {
  fingerprintGeneratedToolValidationSuite,
  registerGeneratedToolValidationSuite,
  type GeneratedToolValidationSuite
} from './validation-suite'

const suite: GeneratedToolValidationSuite = {
  id: 'forge-service-test-v1',
  toolId: 'forge-service-test-tool',
  cases: [
    { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } },
    { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
  ]
}
registerGeneratedToolValidationSuite(suite)

const permissions = {
  filesystem: { read: [], write: [] },
  network: { hosts: [] },
  process: { commands: [] },
  environment: { keys: [] },
  secrets: { handles: [] }
}

const manifest = {
  schemaVersion: 1 as const,
  toolId: suite.toolId,
  displayName: 'ForgeServiceTestTool',
  description: 'Forge service deterministic fixture.',
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm' as const, version: '0.32.0' },
  entrypoint: 'dist/tool.js',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'string' },
  errorContract: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  permissions,
  dependencies: [],
  limits: { timeoutMs: 500, maxInputBytes: 1024, maxOutputBytes: 4096, maxMemoryBytes: 32_000_000 }
}

function createJob(home: string, id: string): ForgeJob {
  const spec: ForgeJob['spec'] = {
    id: suite.toolId,
    displayName: manifest.displayName,
    goal: 'Pass host validation',
    reason: 'Capability missing',
    requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' },
    scope: 'project',
    projectId: 'project-1',
    inputContract: manifest.inputSchema,
    outputContract: manifest.outputSchema,
    permissions,
    acceptance: ['Pass success and explicit failure cases.'],
    examples: [{ input: {}, expected: 'ok' }]
  }
  return createForgeJob(home, {
    id,
    idempotencyKey: `idem-${id}`,
    specHash: hashGeneratedToolSpec(spec),
    toolId: spec.id,
    mode: 'create',
    status: 'queued',
    revision: 0,
    spec,
    attempt: 1,
    maxAttempts: 3,
    createdAt: 1,
    updatedAt: 1,
    artifactPath: `jobs/${id}/workspace`
  })
}

function maker(source: string, options: { barrier?: Promise<void> } = {}): ForgeServiceMaker {
  return async (input) => {
    const broker = new ForgeWorkspaceBroker(input.jokerHome, input.job.id)
    broker.writeFile('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
    broker.writeFile('source/tool.js', source)
    broker.writeFile('dist/tool.js', source)
    assert.equal(broker.runCheck().status, 'passed')
    await options.barrier
    if (input.toolContext.abortSignal?.aborted) throw input.toolContext.abortSignal.reason
    const latest = readForgeJob(input.jokerHome, input.job.id)
    assert.ok(latest)
    sealGeneratedToolCandidate({
      jokerHome: input.jokerHome,
      jobId: input.job.id,
      expectedRevision: latest.revision,
      validationSuiteId: input.validationSuiteId,
      validationSuiteHash: input.validationSuiteHash,
      createdAt: 4,
      validationRunId: `validation-service-${input.job.id}-${input.job.attempt}`
    })
    return { output: 'submitted', usage: undefined, steps: 4 } as never
  }
}

void test('ForgeService advances a queued truthful candidate to awaiting-policy without registration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-service-'))
  try {
    installRuntimeQualificationFixture(home)
    const job = createJob(home, 'job-service-success')
    const registryBefore = readGeneratedToolRegistry(home)
    const service = new ForgeService({
      jokerHome: home,
      maker: maker('if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'),
      now: () => 5
    })
    service.start()
    await service.waitForIdle()
    const completed = readForgeJob(home, job.id)
    assert.equal(completed?.status, 'awaiting-policy')
    assert.ok(completed?.candidateId)
    assert.ok(completed?.validationReportId)
    const registryAfter = readGeneratedToolRegistry(home)
    assert.equal(registryAfter.revision, registryBefore.revision)
    assert.equal(registryAfter.capabilityRevision.revision, registryBefore.capabilityRevision.revision)
    assert.equal(registryAfter.entries.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('ForgeService cannot be fooled by fake explicit failure or caught overreach', async () => {
  for (const scenario of [
    {
      id: 'fake',
      source: 'if (input.fail) tool.output("ERROR: expected-failure"); else tool.output("ok")'
    },
    {
      id: 'overreach',
      source: 'try { tool.readFile("undeclared.txt") } catch (_) {} if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'
    }
  ]) {
    const home = mkdtempSync(join(tmpdir(), `joker-forge-service-${scenario.id}-`))
    try {
      installRuntimeQualificationFixture(home)
      const job = createJob(home, `job-service-${scenario.id}`)
      const service = new ForgeService({ jokerHome: home, maker: maker(scenario.source), now: () => 5 })
      service.start()
      await service.waitForIdle()
      const failed = readForgeJob(home, job.id)
      assert.equal(failed?.status, 'failed')
      assert.match(failed?.error ?? '', scenario.id === 'fake'
        ? /no artifact or spec changes/
        : /validation-quarantined/)
      assert.equal(readGeneratedToolRegistry(home).entries.length, 0)
    } finally { rmSync(home, { recursive: true, force: true }) }
  }
})

void test('ForgeService uses bounded repair for ordinary validation failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-service-repair-'))
  let calls = 0
  const repairingMaker: ForgeServiceMaker = async (input) => {
    calls += 1
    const candidateSource = calls === 1
      ? 'if (input.fail) tool.output("ERROR: expected-failure"); else tool.output("ok")'
      : 'if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'
    return maker(candidateSource)(input)
  }
  try {
    installRuntimeQualificationFixture(home)
    const job = createJob(home, 'job-service-repair')
    const service = new ForgeService({ jokerHome: home, maker: repairingMaker, now: () => 5 })
    service.start()
    await service.waitForIdle()
    const repaired = readForgeJob(home, job.id)
    assert.equal(calls, 2, JSON.stringify(repaired))
    assert.equal(repaired?.attempt, 2)
    assert.equal(repaired?.status, 'awaiting-policy')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('ForgeService user cancellation is durable and is not resumed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-service-cancel-'))
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  try {
    installRuntimeQualificationFixture(home)
    const job = createJob(home, 'job-service-cancel')
    const service = new ForgeService({ jokerHome: home, maker: maker('tool.output("ok")', { barrier }), now: () => 5 })
    service.start()
    while (readForgeJob(home, job.id)?.status !== 'building') await new Promise((resolve) => setTimeout(resolve, 0))
    const building = readForgeJob(home, job.id)!
    const cancelled = await service.cancel(job.id, building.revision)
    assert.equal(cancelled.status, 'cancelled')
    release()
    await service.waitForIdle()
    const restarted = new ForgeService({ jokerHome: home, maker: maker('tool.output("unexpected")'), now: () => 6 })
    restarted.start()
    await restarted.waitForIdle()
    assert.equal(readForgeJob(home, job.id)?.status, 'cancelled')
  } finally {
    release?.()
    rmSync(home, { recursive: true, force: true })
  }
})

void test('ForgeService stop persists interruption and a new service resumes building', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-service-interrupt-'))
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  try {
    installRuntimeQualificationFixture(home)
    const job = createJob(home, 'job-service-interrupt')
    const first = new ForgeService({ jokerHome: home, maker: maker('tool.output("old")', { barrier }), now: () => 5 })
    first.start()
    while (readForgeJob(home, job.id)?.status !== 'building') await new Promise((resolve) => setTimeout(resolve, 0))
    const stopped = first.stop()
    release()
    await stopped
    const interrupted = readForgeJob(home, job.id)
    assert.equal(interrupted?.status, 'interrupted')
    assert.match(interrupted?.resumeHint ?? '', /building/)

    const second = new ForgeService({
      jokerHome: home,
      maker: maker('if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'),
      now: () => 6
    })
    second.start()
    await second.waitForIdle()
    assert.equal(readForgeJob(home, job.id)?.status, 'awaiting-policy')
  } finally {
    release?.()
    rmSync(home, { recursive: true, force: true })
  }
})

void test('validation suite resolution remains host-owned and content-bound', () => {
  const resolved = fingerprintGeneratedToolValidationSuite(suite)
  assert.match(resolved, /^[a-f0-9]{64}$/)
})
