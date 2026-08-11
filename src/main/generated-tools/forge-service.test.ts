import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ForgeJob } from '../../shared/generated-tools'
import { sealGeneratedToolCandidate } from './candidate-store'
import { createForgeJob, hashGeneratedToolSpec, readForgeJob } from './forge-job-store'
import { ForgeWorkspaceBroker } from './forge-workspace'
import { disableGeneratedTool, readGeneratedToolRegistry } from './registry'
import { buildGeneratedToolDefinitions, listGeneratedToolSnapshotBindings } from './adapter'
import { readGeneratedToolInvocations } from './invocation-store'
import { readValidationReport } from './validation-report-store'
import { listGeneratedToolsForManagement } from './management-read-model'
import { buildToolSet } from '../tools/registry'
import { buildToolForgeMetaTools } from '../tools/tool-forge'
import { PromotionService } from './promotion-service'
import { ContinuationScheduler } from './continuation-scheduler'
import { setDefaultContinuationScheduler } from './continuation-scheduler-runtime'
import { ForgeService, type ForgeServiceMaker } from './forge-service'
import { normalizeConfig, saveConfig, setToolForgeFullTrust } from '../store/config'
import { saveProjectState } from '../store/projects'
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

const fullTrustPermissions = {
  filesystem: { read: [], write: ['.project-memory/MEMORY.md'] },
  network: { hosts: [] },
  process: { commands: [] },
  environment: { keys: [] },
  secrets: { handles: [] }
}

const fullTrustManifest = {
  schemaVersion: 1 as const,
  toolId: 'persistent-project-memory',
  displayName: 'PersistentProjectMemory',
  description: 'Persists the declared project memory file.',
  sdkVersion: '1.0.0',
  runtime: { id: 'node-child-process' as const, version: '1' },
  entrypoint: 'dist/tool.js',
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'object', additionalProperties: false },
  errorContract: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  permissions: fullTrustPermissions,
  dependencies: [],
  limits: { timeoutMs: 1_000, maxInputBytes: 1_024, maxOutputBytes: 4_096, maxMemoryBytes: 32_000_000 }
}

function fullTrustMemorySpec(): ForgeJob['spec'] {
  return {
    id: fullTrustManifest.toolId,
    displayName: fullTrustManifest.displayName,
    goal: 'Persist project memory',
    reason: 'Capability missing',
    requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' },
    scope: 'project',
    projectId: 'project-full-trust',
    validationProfile: 'user-owned-full-trust-v1',
    inputContract: fullTrustManifest.inputSchema,
    outputContract: fullTrustManifest.outputSchema,
    permissions: fullTrustPermissions,
    acceptance: ['Write the declared memory file.'],
    examples: [{ input: {}, expected: 'unused legacy example' }],
    validationCases: [
      { id: 'success', input: { value: 'remembered' }, workspaceFiles: {}, expected: { outcome: 'succeeded', output: { saved: true } } },
      { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
    ]
  }
}

function fullTrustMaker(): ForgeServiceMaker {
  return async (input) => {
    const broker = new ForgeWorkspaceBroker(input.jokerHome, input.job.id)
    const source = 'if (input.fail) tool.fail({ message: "expected-failure" }); else { tool.writeFile(".project-memory/MEMORY.md", input.value); tool.output({ saved: true }); }'
    broker.writeFile('manifest.json', `${JSON.stringify(fullTrustManifest, null, 2)}\n`)
    broker.writeFile('source/tool.js', source)
    broker.writeFile('dist/tool.js', source)
    assert.equal(broker.runCheck().status, 'passed')
    const latest = readForgeJob(input.jokerHome, input.job.id)
    assert.ok(latest)
    sealGeneratedToolCandidate({
      jokerHome: input.jokerHome,
      jobId: input.job.id,
      expectedRevision: latest.revision,
      validationPlan: input.validationPlan,
      validationPlanHash: input.validationPlanHash,
      createdAt: 4,
      validationRunId: `validation-service-${input.job.id}-${input.job.attempt}`
    })
    return { output: 'submitted', usage: undefined, steps: 4 } as never
  }
}

function installFullTrustProjectState(home: string, workspace: string): void {
  const priorHome = process.env['JOKER_HOME']
  process.env['JOKER_HOME'] = home
  try {
    saveProjectState({
      projects: [{ id: 'project-full-trust', name: 'workspace', path: workspace, lastUsedAt: 1 }],
      activeProjectId: 'project-full-trust'
    })
  } finally {
    if (priorHome === undefined) delete process.env['JOKER_HOME']
    else process.env['JOKER_HOME'] = priorHome
  }
}

function installFullTrustConfig(home: string, workspace: string): void {
  const priorHome = process.env['JOKER_HOME']
  process.env['JOKER_HOME'] = home
  try {
    saveConfig(setToolForgeFullTrust(normalizeConfig({}), workspace, true))
  } finally {
    if (priorHome === undefined) delete process.env['JOKER_HOME']
    else process.env['JOKER_HOME'] = priorHome
  }
}

async function withJokerHome<T>(home: string, callback: () => T | Promise<T>): Promise<T> {
  const priorHome = process.env['JOKER_HOME']
  process.env['JOKER_HOME'] = home
  try {
    return await callback()
  } finally {
    if (priorHome === undefined) delete process.env['JOKER_HOME']
    else process.env['JOKER_HOME'] = priorHome
  }
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

void test('ForgeService validates, promotes, and invokes a full-trust Memory Tool', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-service-full-trust-'))
  const workspace = join(home, 'workspace')
  try {
    mkdirSync(workspace, { recursive: true })
    installRuntimeQualificationFixture(home)
    installFullTrustProjectState(home, workspace)
    installFullTrustConfig(home, workspace)
    const expectedJobId = 'forge-full-trust'
    const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 10, createId: () => 'full-trust-continuation' })
    setDefaultContinuationScheduler(scheduler)
    const promotion = new PromotionService({ jokerHome: home, now: () => 10 })
    await withJokerHome(home, async () => {
      const service = new ForgeService({
        jokerHome: home,
        maker: fullTrustMaker(),
        activationDriver: (jobId) => promotion.advance(jobId),
        now: () => 5
      })
      const start = buildToolForgeMetaTools({
        jokerHome: home,
        controller: service,
        createId: () => 'full-trust',
        now: () => 1
      }).find((tool) => tool.name === 'ToolForgeStart')!
      const started = JSON.parse((await start.execute({
        idempotencyKey: 'idem-full-trust',
        mode: 'create',
        maxAttempts: 1,
        spec: fullTrustMemorySpec()
      }, {
        workspacePath: workspace,
        sessionId: 'session-1',
        runId: 'run-1',
        approvalGate: async () => ({ outcome: 'allow', risk: 'write_local', reason: 'active workspace trust' })
      })).output)
      assert.equal(started.status, 'queued')
      assert.equal(started.jobId, expectedJobId)
      await service.waitForIdle()
    })
    const completed = readForgeJob(home, expectedJobId)
    assert.equal(
      completed?.status,
      'completed',
      JSON.stringify(completed?.validationReportId
        ? readValidationReport(home, completed.validationReportId)
        : completed)
    )
    assert.equal(completed?.spec.validationProfile, 'user-owned-full-trust-v1')
    const continuation = scheduler.read(`continuation-promotion-${expectedJobId}-${completed?.candidateId}`)
    assert.equal(continuation?.status, 'ready')

    const bindings = listGeneratedToolSnapshotBindings({ jokerHome: home, projectId: 'project-full-trust' })
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0]?.validationProfile, 'user-owned-full-trust-v1')
    const definitions = buildGeneratedToolDefinitions(workspace, home, bindings, new Set(), 'project-full-trust')
    const toolSet = buildToolSet(definitions, {
      workspacePath: workspace,
      sessionId: 'session-memory',
      runId: 'run-memory',
      approvalGate: async () => ({ outcome: 'allow', risk: 'write_local', reason: 'active workspace trust' })
    })
    const result = await withJokerHome(home, () => (toolSet['persistent-project-memory'] as unknown as {
      execute: (input: Record<string, unknown>, options: { toolCallId: string }) => Promise<{ output: string }>
    }).execute({ value: 'remembered' }, { toolCallId: 'memory-call' }))
    assert.equal(result.output, JSON.stringify({ saved: true }))
    assert.equal(readFileSync(join(workspace, '.project-memory', 'MEMORY.md'), 'utf8'), 'remembered')
    const invocation = readGeneratedToolInvocations(home).invocations[0]
    assert.equal(invocation.status, 'finished')
    assert.equal(invocation.outcome, 'succeeded')
    const inventory = await withJokerHome(home, () => listGeneratedToolsForManagement(home))
    assert.equal(inventory.success, true)
    if (inventory.success) {
      assert.equal(inventory.data.tools[0]?.availability, 'available')
      assert.equal(inventory.data.tools[0]?.executionPolicy, 'auto-eligible')
      assert.equal(inventory.data.tools[0]?.invocationCount, 1)
    }

    await withJokerHome(home, () => {
      saveConfig(setToolForgeFullTrust(normalizeConfig({}), workspace, false))
    })
    const revokedGrantInventory = await withJokerHome(home, () => listGeneratedToolsForManagement(home))
    assert.equal(revokedGrantInventory.success, true)
    if (revokedGrantInventory.success) {
      assert.equal(revokedGrantInventory.data.tools[0]?.availability, 'permission-required')
      assert.equal(revokedGrantInventory.data.tools[0]?.executionPolicy, 'unavailable')
    }
    await assert.rejects(
      () => withJokerHome(home, () => definitions[0]!.execute({ value: 'must-not-write' }, {
        workspacePath: workspace,
        sessionId: 'session-memory',
        runId: 'run-after-revoke',
        approvalGate: async () => ({ outcome: 'allow', risk: 'write_local', reason: 'test' })
      })),
      /active workspace full-trust grant/
    )
    assert.equal(readFileSync(join(workspace, '.project-memory', 'MEMORY.md'), 'utf8'), 'remembered')

    await withJokerHome(home, () => {
      saveConfig(setToolForgeFullTrust(normalizeConfig({}), workspace, true))
    })
    const restoredInventory = await withJokerHome(home, () => listGeneratedToolsForManagement(home))
    assert.equal(restoredInventory.success, true)
    if (restoredInventory.success) {
      assert.equal(restoredInventory.data.tools[0]?.availability, 'available')
      assert.equal(restoredInventory.data.tools[0]?.executionPolicy, 'auto-eligible')
    }
    const activeRegistry = readGeneratedToolRegistry(home)
    disableGeneratedTool({
      jokerHome: home,
      registryId: activeRegistry.registryId,
      expectedRevision: activeRegistry.revision,
      operationId: 'disable-full-trust-memory',
      createdAt: 20,
      toolId: fullTrustManifest.toolId
    })
    await assert.rejects(
      () => definitions[0]!.execute({ value: 'still-must-not-write' }, {
        workspacePath: workspace,
        sessionId: 'session-memory',
        runId: 'run-after-disable',
        approvalGate: async () => ({ outcome: 'allow', risk: 'write_local', reason: 'test' })
      }),
      /no longer active/
    )
    assert.equal(readFileSync(join(workspace, '.project-memory', 'MEMORY.md'), 'utf8'), 'remembered')
  } finally {
    setDefaultContinuationScheduler(null)
    rmSync(home, { recursive: true, force: true })
  }
})

void test('ForgeService advances a passed low-risk candidate through activation automatically', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-service-'))
  try {
    installRuntimeQualificationFixture(home)
    const job = createJob(home, 'job-service-success')
    const activated: string[] = []
    const service = new ForgeService({
      jokerHome: home,
      maker: maker('if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'),
      activationDriver: async (jobId) => {
        activated.push(jobId)
        const current = readForgeJob(home, jobId)!
        return {
          job: current,
          journal: { id: 'promotion-test', phase: 'completed' } as never,
          action: 'promoted',
          reason: 'test activation'
        }
      },
      now: () => 5
    })
    service.start()
    await service.waitForIdle()
    const awaiting = readForgeJob(home, job.id)
    assert.equal(awaiting?.status, 'awaiting-policy')
    assert.deepEqual(activated, [job.id])
    assert.equal(readGeneratedToolRegistry(home).entries.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('ForgeService reconciles awaiting-policy jobs through the activation driver on restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-service-reconcile-'))
  try {
    installRuntimeQualificationFixture(home)
    const job = createJob(home, 'job-service-reconcile')
    const first = new ForgeService({
      jokerHome: home,
      maker: maker('if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'),
      now: () => 5
    })
    first.start()
    await first.waitForIdle()
    assert.equal(readForgeJob(home, job.id)?.status, 'awaiting-policy')

    const activated: string[] = []
    const restarted = new ForgeService({
      jokerHome: home,
      activationDriver: async (jobId) => {
        activated.push(jobId)
        return {
          job: readForgeJob(home, jobId)!,
          journal: { id: 'promotion-reconcile', phase: 'completed' } as never,
          action: 'promoted',
          reason: 'restart activation'
        }
      },
      now: () => 6
    })
    restarted.start()
    await restarted.waitForIdle()
    assert.deepEqual(activated, [job.id])
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
