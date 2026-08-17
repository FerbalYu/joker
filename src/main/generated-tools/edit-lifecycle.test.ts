import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { GeneratedToolDescriptor, GeneratedToolVersion, ForgeJob } from '../../shared/generated-tools'
import { GeneratedToolEditService } from './edit-service'
import { ForgeService, type ForgeServiceMaker } from './forge-service'
import { ForgeWorkspaceBroker } from './forge-workspace'
import { fingerprintGeneratedToolArtifact } from './fingerprint'
import { readForgeJob } from './forge-job-store'
import { installRuntimeQualificationFixture } from './test-fixtures'
import { readGeneratedToolRegistry, registerGeneratedToolVersion, promoteGeneratedTool } from './registry'
import { generatedToolsRoot, publishGeneratedToolBundle } from './store'
import { sealGeneratedToolCandidate } from './candidate-store'
import { PromotionService } from './promotion-service'
import { ContinuationScheduler } from './continuation-scheduler'
import { setDefaultContinuationScheduler } from './continuation-scheduler-runtime'
import { registerGeneratedToolValidationSuite, type GeneratedToolValidationSuite } from './validation-suite'

const toolId = 'edit-test-tool'
const permissions = {
  filesystem: { read: [], write: [] },
  network: { hosts: [] },
  process: { commands: [] },
  environment: { keys: [] },
  secrets: { handles: [] }
}

const manifest = {
  schemaVersion: 1 as const,
  toolId,
  displayName: 'Edit Test Tool',
  description: 'Stable edit lifecycle fixture.',
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm' as const, version: '0.32.0' },
  entrypoint: 'source/tool.js',
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'string' },
  errorContract: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  permissions,
  dependencies: [],
  limits: { timeoutMs: 1_000, maxInputBytes: 4_096, maxOutputBytes: 4_096, maxMemoryBytes: 32_000_000 }
}

const suite: GeneratedToolValidationSuite = {
  id: 'edit-lifecycle-v1',
  toolId,
  cases: [
    { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'v2' } },
    { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected-failure' } } }
  ]
}
registerGeneratedToolValidationSuite(suite)

const goodSource = 'if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("v2")'

function installBaseVersion(home: string): GeneratedToolVersion {
  const root = generatedToolsRoot(home)
  const staging = join(root, 'staging', 'base-version')
  mkdirSync(join(staging, 'source'), { recursive: true })
  mkdirSync(join(staging, 'dist'), { recursive: true })
  mkdirSync(join(staging, 'evidence'), { recursive: true })
  mkdirSync(join(staging, 'logs'), { recursive: true })
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest))
  const source = 'if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("v1")'
  writeFileSync(join(staging, 'source', 'tool.js'), source)
  writeFileSync(join(staging, 'dist', 'tool.js'), source)
  writeFileSync(join(staging, 'evidence', 'check.json'), '{"id":"check"}')
  writeFileSync(join(staging, 'logs', 'validate.log'), 'ok')
  const fingerprint = fingerprintGeneratedToolArtifact(root, 'staging/base-version')
  const report = {
    id: 'report-base-version',
    toolId,
    versionId: 'version-1',
    artifactFingerprint: fingerprint.fingerprint,
    startedAt: 1,
    finishedAt: 2,
    status: 'passed' as const,
    checks: [{ id: 'check', category: 'schema' as const, status: 'passed' as const, evidencePath: 'evidence/check.json', message: 'ok' }],
    declaredPermissions: permissions,
    observedCapabilities: [],
    logsPath: 'logs/validate.log'
  }
  const version: GeneratedToolVersion = {
    id: 'version-1',
    toolId,
    version: 1,
    ...fingerprint,
    artifactPath: `tools/${toolId}/versions/version-1`,
    validationReportId: report.id,
    trustState: 'trusted',
    createdAt: 2
  }
  writeFileSync(join(staging, 'validation-report.json'), JSON.stringify(report))
  writeFileSync(join(staging, 'version.json'), JSON.stringify(version))
  publishGeneratedToolBundle({ root, stagingRootRelativePath: 'staging/base-version', version })
  const registry = readGeneratedToolRegistry(home)
  const descriptor: GeneratedToolDescriptor = {
    id: toolId,
    displayName: manifest.displayName,
    description: manifest.description,
    scope: 'user',
    availability: 'building',
    createdBy: 'joker',
    permissionSummary: [],
    invocationCount: 0,
    createdAt: 1,
    updatedAt: 2
  }
  registerGeneratedToolVersion({ jokerHome: home, registryId: registry.registryId, expectedRevision: 0, operationId: 'register-base', createdAt: 2, descriptor, version })
  promoteGeneratedTool({ jokerHome: home, registryId: registry.registryId, expectedRevision: 1, operationId: 'promote-base', createdAt: 3, toolId, versionId: version.id })
  return version
}

function makerFor(source: string): ForgeServiceMaker {
  return async (input) => {
    const broker = new ForgeWorkspaceBroker(input.jokerHome, input.job.id)
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
      validationRunId: `validation-${input.job.id}-${input.job.attempt}`
    })
    return { output: 'submitted', usage: undefined, steps: 4 } as never
  }
}

const deferredController = {
  enqueue: () => true,
  cancel: async () => { throw new Error('not used') }
}

async function startEdit(home: string, source: string): Promise<{ job: ForgeJob; service: ForgeService }> {
  installRuntimeQualificationFixture(home)
  const base = installBaseVersion(home)
  const edit = new GeneratedToolEditService({ jokerHome: home, createId: () => 'edit-lifecycle-job', now: () => 10, controller: deferredController })
  const started = edit.start({ toolId, baseVersionId: base.id, baseFingerprint: base.fingerprint, instruction: 'Change the output', requestedFrom: 'settings' }, 'session-1', 'run-1')
  assert.equal(started.success, true)
  if (!started.success) throw new Error('edit job creation failed')
  const forge = new ForgeService({ jokerHome: home, maker: makerFor(source), now: () => 20 })
  forge.start()
  await forge.waitForIdle()
  return { job: readForgeJob(home, started.data.jobId)!, service: forge }
}

void test('successful edit validates and promotes v2 while preserving immutable v1 until the switch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-edit-lifecycle-success-'))
  try {
    const { job } = await startEdit(home, goodSource)
    assert.equal(job.status, 'awaiting-policy')
    assert.equal(readGeneratedToolRegistry(home).activePointers.find((pointer) => pointer.toolId === toolId)?.activeVersionId, 'version-1')

    const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 30, createId: () => 'continuation' })
    setDefaultContinuationScheduler(scheduler)
    const promoted = await new PromotionService({ jokerHome: home, now: () => 30 }).promote({
      jobId: job.id,
      expectedJobRevision: job.revision,
      registryRevision: readGeneratedToolRegistry(home).revision,
      expectedCandidateFingerprint: job.candidateFingerprint!,
      approvalGrant: { requestId: 'approval-request', webContentsId: 1, sessionId: 'session-1', runId: 'run-1', toolName: 'GeneratedToolEnable', requestHash: 'a'.repeat(64), approvedAt: 30 }
    })
    assert.equal(promoted.action, 'promoted')
    const after = readGeneratedToolRegistry(home)
    const pointer = after.activePointers.find((item) => item.toolId === toolId)
    assert.equal(pointer?.activeVersionId, job.candidateId)
    assert.equal(pointer?.lastStableVersionId, job.candidateId)
    assert.equal(after.capabilityRevision.revision, 2)
    assert.equal(readGeneratedToolVersionSource(home, 'version-1'), 'if (input.fail) tool.fail({message:"expected-failure"}); else tool.output("v1")')
  } finally {
    setDefaultContinuationScheduler(null)
    rmSync(home, { recursive: true, force: true })
  }
})

void test('edit workspace rejects a base version whose fingerprint changes before manufacturing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-edit-lifecycle-stale-base-'))
  try {
    installRuntimeQualificationFixture(home)
    const base = installBaseVersion(home)
    const edit = new GeneratedToolEditService({ jokerHome: home, createId: () => 'stale-base-job', now: () => 10, controller: deferredController })
    const started = edit.start({ toolId, baseVersionId: base.id, baseFingerprint: base.fingerprint, instruction: 'Change the output', requestedFrom: 'settings' }, 'session-1', 'run-1')
    assert.equal(started.success, true)
    if (!started.success) return
    const job = readForgeJob(home, started.data.jobId)!
    const versionPath = join(generatedToolsRoot(home), 'tools', toolId, 'versions', base.id, 'source', 'tool.js')
    writeFileSync(versionPath, 'tampered')
    const forge = new ForgeService({ jokerHome: home, maker: makerFor(goodSource), now: () => 20 })
    forge.start()
    await forge.waitForIdle()
    const failed = readForgeJob(home, job.id)
    assert.equal(failed?.status, 'failed')
    assert.match(failed?.error ?? '', /fingerprint|artifact|validation/i)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

function readGeneratedToolVersionSource(home: string, versionId: string): string {
  return readFileSync(join(generatedToolsRoot(home), 'tools', toolId, 'versions', versionId, 'source', 'tool.js'), 'utf8')
}
