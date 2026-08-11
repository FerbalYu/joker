import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ForgeJob } from '../../shared/generated-tools'
import { createForgeJob, hashGeneratedToolSpec, readForgeJob } from './forge-job-store'
import { ForgeService, type ForgeServiceMaker } from './forge-service'
import { ForgeWorkspaceBroker } from './forge-workspace'
import { installRuntimeQualificationFixture } from './test-fixtures'
import { PromotionService, PromotionServiceCrash } from './promotion-service'
import { ContinuationScheduler } from './continuation-scheduler'
import { setDefaultContinuationScheduler } from './continuation-scheduler-runtime'
import { readPromotionJournal, updatePromotionJournal } from './promotion-journal-store'
import { readGeneratedToolRegistry } from './registry'
import { readPromotionApprovalReceipt, writePromotionApprovalReceipt } from './promotion-approval-store'
import { evaluateGeneratedToolPolicy } from './policy'
import { readContinuationV2 } from './continuation-v2'
import {
  registerGeneratedToolValidationSuite,
  fingerprintGeneratedToolValidationSuite,
  type GeneratedToolValidationSuite
} from './validation-suite'
import { sealGeneratedToolCandidate } from './candidate-store'

const suite: GeneratedToolValidationSuite = {
  id: 'promotion-service-test-v1',
  toolId: 'promotion-service-test-tool',
  cases: [
    { id: 'success', input: {}, workspaceFiles: { 'fixtures/tasks.json': '[]' }, expected: { outcome: 'succeeded', output: 'ok' } },
    { id: 'failure', input: { fail: true }, workspaceFiles: { 'fixtures/tasks.json': '[]' }, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
  ]
}
registerGeneratedToolValidationSuite(suite)
assert.match(fingerprintGeneratedToolValidationSuite(suite), /^[a-f0-9]{64}$/)

const permissions = {
  filesystem: { read: ['fixtures/tasks.json'], write: [] },
  network: { hosts: [] },
  process: { commands: [] },
  environment: { keys: [] },
  secrets: { handles: [] }
}

const manifest = {
  schemaVersion: 1 as const,
  toolId: suite.toolId,
  displayName: 'PromotionServiceTestTool',
  description: 'Promotion service deterministic fixture.',
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

function createJob(home: string, id: string, scope: 'project' | 'user' = 'project'): ForgeJob {
  const spec: ForgeJob['spec'] = {
    id: suite.toolId,
    displayName: manifest.displayName,
    goal: 'Read the project task fixture and return a summary.',
    reason: 'Capability missing during the task.',
    requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' },
    scope,
    ...(scope === 'project' ? { projectId: 'project-1' } : {}),
    inputContract: manifest.inputSchema,
    outputContract: manifest.outputSchema,
    permissions,
    acceptance: ['Normal input returns ok.', 'Failure input uses explicit failure.'],
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

function maker(): ForgeServiceMaker {
  return async (input) => {
    const broker = new ForgeWorkspaceBroker(input.jokerHome, input.job.id)
    const source = 'if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("ok")'
    broker.writeFile('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
    broker.writeFile('source/tool.js', source)
    broker.writeFile('dist/tool.js', source)
    assert.equal(broker.runCheck().status, 'passed')
    const latest = readForgeJob(input.jokerHome, input.job.id)
    assert.ok(latest)
    sealGeneratedToolCandidate({
      jokerHome: input.jokerHome,
      jobId: input.job.id,
      expectedRevision: latest.revision,
      validationSuiteId: input.validationSuiteId,
      validationSuiteHash: input.validationSuiteHash,
      createdAt: 4,
      validationRunId: `validation-${input.job.id}`
    })
    return { output: 'submitted', usage: undefined, steps: 4 } as never
  }
}

async function setup(options: { scope?: 'project' | 'user' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'joker-promotion-service-'))
  installRuntimeQualificationFixture(home)
  const job = createJob(home, 'job-promotion-service', options.scope)
  const forge = new ForgeService({ jokerHome: home, maker: maker(), now: () => 5 })
  forge.start()
  await forge.waitForIdle()
  const awaiting = readForgeJob(home, job.id)
  assert.equal(awaiting?.status, 'awaiting-policy', awaiting?.error ?? JSON.stringify(awaiting))
  assert.ok(awaiting?.candidateFingerprint)
  return { home, job: awaiting! }
}

void test('PromotionService advance derives authoritative CAS inputs and binds explicit approval to GeneratedToolEnable', async () => {
  const { home, job } = await setup({ scope: 'user' })
  try {
    installRuntimeQualificationFixture(home, 'L1')
    const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 10, createId: () => 'advance-dispatch' })
    setDefaultContinuationScheduler(scheduler)
    const service = new PromotionService({ jokerHome: home, now: () => 10 })
    let request: { toolName: string } | undefined
    const result = await service.advance(job.id, {
      requestApproval: async (approvalRequest) => {
        request = approvalRequest
        return {
          requestId: 'advance-request',
          webContentsId: 17,
          sessionId: 'session-1',
          runId: 'run-1',
          toolName: 'GeneratedToolEnable',
          requestHash: 'e'.repeat(64),
          approvedAt: 11
        }
      }
    })
    assert.equal(request?.toolName, 'GeneratedToolEnable')
    assert.equal(result.action, 'promoted')
    assert.equal(result.job.status, 'completed')
  } finally {
    setDefaultContinuationScheduler(null)
    rmSync(home, { recursive: true, force: true })
  }
})

void test('PromotionService deny writes no receipt and remains retryable', async () => {
  const { home, job } = await setup({ scope: 'user' })
  try {
    installRuntimeQualificationFixture(home, 'L1')
    const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 10, createId: () => 'retry-dispatch' })
    setDefaultContinuationScheduler(scheduler)
    const service = new PromotionService({ jokerHome: home, now: () => 10 })
    let approvals = 0
    const denied = await service.promote({
      jobId: job.id,
      expectedJobRevision: job.revision,
      registryRevision: readGeneratedToolRegistry(home).revision,
      expectedCandidateFingerprint: job.candidateFingerprint!,
      requestApproval: async () => {
        approvals += 1
        return null
      }
    })
    assert.equal(denied.action, 'approval-required')
    assert.equal(readPromotionApprovalReceipt(home, denied.journal.id), null)
    assert.equal(readForgeJob(home, job.id)?.status, 'awaiting-policy')

    const retried = await service.promote({
      jobId: job.id,
      expectedJobRevision: job.revision,
      registryRevision: readGeneratedToolRegistry(home).revision,
      expectedCandidateFingerprint: job.candidateFingerprint!,
      promotionId: denied.journal.id,
      requestApproval: async () => ({
        requestId: 'retry-request',
        webContentsId: 17,
        sessionId: 'session-1',
        runId: 'run-1',
        toolName: 'GeneratedToolEnable',
        requestHash: 'd'.repeat(64),
        approvedAt: 11
      })
    })
    assert.equal(approvals, 1)
    assert.equal(retried.action, 'promoted')
    assert.equal(readPromotionApprovalReceipt(home, denied.journal.id)?.schemaVersion, 2)
  } finally {
    setDefaultContinuationScheduler(null)
    rmSync(home, { recursive: true, force: true })
  }
})

void test('PromotionService reads v1 receipt for recovery but requires a fresh v2 grant before pointer switch', async () => {
  const { home, job } = await setup({ scope: 'user' })
  try {
    installRuntimeQualificationFixture(home, 'L1')
    const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 10, createId: () => 'v1-dispatch' })
    setDefaultContinuationScheduler(scheduler)
    const service = new PromotionService({ jokerHome: home, now: () => 10 })
    const promotionId = `promotion-${job.id}-${job.candidateId}`
    const evaluation = evaluateGeneratedToolPolicy({ jokerHome: home, jobId: job.id, operation: 'promote', approvalMode: 'suggest', evaluatedAt: 10 })
    writePromotionApprovalReceipt(home, {
      schemaVersion: 1,
      id: `approval-${promotionId}`,
      promotionId,
      jobId: job.id,
      toolId: job.toolId,
      candidateId: evaluation.candidate.id,
      candidateFingerprint: evaluation.candidate.artifactFingerprint,
      validationReportId: evaluation.report.id,
      policyInputHash: evaluation.decision.inputHash,
      windowId: 17,
      sessionId: 'session-1',
      runId: 'run-1',
      approved: true,
      approvalMode: 'full-auto',
      approvedAt: 9,
      revision: 0
    })
    const result = await service.promote({
      jobId: job.id,
      expectedJobRevision: job.revision,
      registryRevision: readGeneratedToolRegistry(home).revision,
      expectedCandidateFingerprint: job.candidateFingerprint!,
      requestApproval: async () => null
    })
    assert.equal(result.action, 'approval-required')
    assert.equal(readGeneratedToolRegistry(home).activePointers.length, 0)
  } finally {
    setDefaultContinuationScheduler(null)
    rmSync(home, { recursive: true, force: true })
  }
})

void test('PromotionService rejects stale registry revision independently from job revision', async () => {
  const { home, job } = await setup()
  try {
    const result = await new PromotionService({ jokerHome: home, now: () => 10 }).promote({
      jobId: job.id,
      expectedJobRevision: job.revision,
      registryRevision: readGeneratedToolRegistry(home).revision + 1,
      expectedCandidateFingerprint: job.candidateFingerprint!
    })
    assert.equal(result.action, 'denied')
    assert.equal(result.journal.policy.reasonCode, 'stale-registry-revision')
    assert.equal(result.job.status, 'failed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('PromotionService promotes once and replays the same journal, registry operation, and capability revision', async () => {
  const { home, job } = await setup()
  try {
    const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 10, createId: () => 'dispatch' })
    setDefaultContinuationScheduler(scheduler)
    const service = new PromotionService({ jokerHome: home, now: () => 10 })
    const first = await service.promote({ jobId: job.id, expectedJobRevision: job.revision, registryRevision: readGeneratedToolRegistry(home).revision, expectedCandidateFingerprint: job.candidateFingerprint! })
    assert.equal(first.action, 'promoted')
    assert.equal(first.journal.phase, 'completed')
    assert.equal(first.capabilityRevision, 1)
    const registryAfter = readGeneratedToolRegistry(home)
    assert.equal(registryAfter.capabilityRevision.revision, 1)
    const replay = await service.promote({ jobId: job.id, expectedJobRevision: first.job.revision, registryRevision: readGeneratedToolRegistry(home).revision, expectedCandidateFingerprint: job.candidateFingerprint!, promotionId: first.journal.id })
    assert.equal(replay.journal.id, first.journal.id)
    assert.equal(replay.capabilityRevision, first.capabilityRevision)
    assert.equal(readGeneratedToolRegistry(home).capabilityRevision.revision, 1)
    assert.equal(readPromotionJournal(home, first.journal.id)?.phase, 'completed')
  } finally {
    setDefaultContinuationScheduler(null)
    rmSync(home, { recursive: true, force: true })
  }
})

void test('PromotionService leaves continuation ready while source session is owned and dispatches it after release', async () => {
  const { home, job } = await setup()
  try {
    const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 10, createId: () => 'dispatch' })
    setDefaultContinuationScheduler(scheduler)
    const service = new PromotionService({ jokerHome: home, now: () => 10 })
    let sourceRunning = true
    const dispatched: string[] = []
    scheduler.attach(1, {
      isSessionRunning: () => sourceRunning,
      dispatch: (continuation) => { dispatched.push(continuation.id) }
    })
    const result = await service.promote({ jobId: job.id, expectedJobRevision: job.revision, registryRevision: readGeneratedToolRegistry(home).revision, expectedCandidateFingerprint: job.candidateFingerprint! })
    assert.equal(result.action, 'promoted')
    const continuationId = `continuation-${result.journal.id}`
    assert.equal(readContinuationV2(home, continuationId)?.status, 'ready')
    assert.deepEqual(dispatched, [])
    sourceRunning = false
    await scheduler.dispatchReady()
    assert.deepEqual(dispatched, [continuationId])
    assert.equal(readContinuationV2(home, continuationId)?.status, 'dispatched')
  } finally {
    setDefaultContinuationScheduler(null)
    rmSync(home, { recursive: true, force: true })
  }
})

void test('PromotionService recovery finalizes a completed job journal without incrementing capability revision twice', async () => {
  const { home, job } = await setup()
  try {
    const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 10, createId: () => 'dispatch' })
    setDefaultContinuationScheduler(scheduler)
    const service = new PromotionService({ jokerHome: home, now: () => 10 })
    const first = await service.promote({ jobId: job.id, expectedJobRevision: job.revision, registryRevision: readGeneratedToolRegistry(home).revision, expectedCandidateFingerprint: job.candidateFingerprint! })
    const registryRevision = readGeneratedToolRegistry(home).capabilityRevision.revision
    const recovered = await service.recover()
    assert.equal(recovered.length, 0)
    assert.equal(readGeneratedToolRegistry(home).capabilityRevision.revision, registryRevision)
    assert.equal(readForgeJob(home, job.id)?.status, 'completed')
    assert.equal(readPromotionJournal(home, first.journal.id)?.phase, 'completed')
  } finally {
    setDefaultContinuationScheduler(null)
    rmSync(home, { recursive: true, force: true })
  }
})

void test('PromotionService startup recovery resumes an interrupted post-pointer promotion exactly once', async () => {
  const { home, job } = await setup()
  try {
    const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 10, createId: () => 'interrupted-dispatch' })
    setDefaultContinuationScheduler(scheduler)
    const service = new PromotionService({ jokerHome: home, now: () => 10 })
    const promoted = await service.promote({ jobId: job.id, expectedJobRevision: job.revision, registryRevision: readGeneratedToolRegistry(home).revision, expectedCandidateFingerprint: job.candidateFingerprint! })
    const interruptedJob = readForgeJob(home, job.id)
    assert.equal(interruptedJob?.status, 'completed')
    const interruptedJournal = updatePromotionJournal(home, promoted.journal.id, promoted.journal.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      phase: 'interrupted',
      error: 'simulated-post-pointer-runtime-error',
      updatedAt: 11
    }))
    assert.equal(interruptedJournal.capabilityRevision, 1)

    const before = readGeneratedToolRegistry(home)
    const recovered = await new PromotionService({ jokerHome: home, now: () => 12 }).recover()
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].phase, 'completed', recovered[0].error)
    assert.equal(readForgeJob(home, job.id)?.status, 'completed')
    assert.equal(readGeneratedToolRegistry(home).capabilityRevision.revision, before.capabilityRevision.revision)
    assert.equal(readGeneratedToolRegistry(home).operations.filter((operation) => operation.kind === 'register-version').length, 1)
    assert.equal(readGeneratedToolRegistry(home).operations.filter((operation) => operation.kind === 'promote').length, 1)
    assert.ok(readContinuationV2(home, `continuation-${promoted.journal.id}`))
  } finally {
    setDefaultContinuationScheduler(null)
    rmSync(home, { recursive: true, force: true })
  }
})

for (const crashPhase of ['policy-resolved', 'assembled', 'published', 'registered', 'pointer-switched', 'continuation-ready'] as const) {
  void test(`PromotionService recovers an exact-once promotion after a ${crashPhase} crash`, async () => {
    const { home, job } = await setup()
    try {
      const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 10, createId: () => `dispatch-${crashPhase}` })
      setDefaultContinuationScheduler(scheduler)
      const crashing = new PromotionService({
        jokerHome: home,
        now: () => 10,
        phaseCheckpoint: (phase) => {
          if (phase === crashPhase) throw new PromotionServiceCrash(phase)
        }
      })
      await assert.rejects(
        crashing.promote({
          jobId: job.id,
          expectedJobRevision: job.revision,
          registryRevision: readGeneratedToolRegistry(home).revision,
          expectedCandidateFingerprint: job.candidateFingerprint!
        }),
        (error: unknown) => error instanceof PromotionServiceCrash && error.phase === crashPhase
      )

      const crashedJournal = readPromotionJournal(home, `promotion-${job.id}-${job.candidateId}`)
      assert.equal(crashedJournal?.phase, crashPhase)
      assert.equal(readForgeJob(home, job.id)?.status, 'promoting')
      const registryAfterCrash = readGeneratedToolRegistry(home)
      const switchedBeforeCrash = ['pointer-switched', 'continuation-ready'].includes(crashPhase)
      assert.equal(registryAfterCrash.capabilityRevision.revision, switchedBeforeCrash ? 1 : 0)
      assert.equal(
        registryAfterCrash.activePointers.find((pointer) => pointer.toolId === job.toolId)?.activeVersionId,
        switchedBeforeCrash ? job.candidateId : undefined
      )

      const recovered = await new PromotionService({ jokerHome: home, now: () => 11 }).recover()
      assert.equal(recovered.length, 1)
      assert.equal(recovered[0].phase, 'completed', recovered[0].error)
      const finalJob = readForgeJob(home, job.id)
      const finalJournal = readPromotionJournal(home, crashedJournal!.id)
      const finalRegistry = readGeneratedToolRegistry(home)
      assert.equal(finalJob?.status, 'completed')
      assert.equal(finalJournal?.phase, 'completed')
      assert.equal(finalRegistry.capabilityRevision.revision, 1)
      assert.equal(finalRegistry.activePointers.find((pointer) => pointer.toolId === job.toolId)?.activeVersionId, job.candidateId)
      assert.equal(finalRegistry.operations.filter((operation) => operation.kind === 'register-version').length, 1)
      assert.equal(finalRegistry.operations.filter((operation) => operation.kind === 'promote').length, 1)
      const continuation = readContinuationV2(home, `continuation-${finalJournal!.id}`)
      assert.ok(continuation)
      assert.equal(continuation.toCapabilityRevision, 1)
      assert.ok(['ready', 'dispatched'].includes(continuation.status))
      assert.equal(readGeneratedToolRegistry(home).capabilityRevision.revision, 1)
    } finally {
      setDefaultContinuationScheduler(null)
      rmSync(home, { recursive: true, force: true })
    }
  })
}
