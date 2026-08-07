import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ForgeJob, GeneratedToolManifest, GeneratedToolPermissionManifest } from '../../shared/generated-tools'
import { parseGeneratedToolManifest } from '../../shared/generated-tools-schema'
import { createForgeJob, hashGeneratedToolSpec, updateForgeJob } from './forge-job-store'
import { sealGeneratedToolCandidate } from './candidate-store'
import { commitValidationReportBundle } from './validation-report-store'
import { generatedToolsRoot } from './store'
import { installRuntimeQualificationFixture } from './test-fixtures'
import { installSummarizeTaskJsonFixture } from './fixture'
import { disableGeneratedTool, readGeneratedToolRegistry, revalidateGeneratedTool } from './registry'
import { evaluateGeneratedToolPolicy } from './policy'
import { PromotionService } from './promotion-service'

const TOOL_ID = 'summarize-task-json'
const PROJECT_ID = 'policy-test-project'
const FIXTURE_ROOT = join(process.cwd(), 'scripts', 'fixtures', 'generated-tools', TOOL_ID)
const SUITE_HASH = 'a'.repeat(64)

const readOnlyPermissions: GeneratedToolPermissionManifest = {
  filesystem: { read: ['fixtures/tasks.json'], write: [] },
  network: { hosts: [], methods: [] },
  process: { commands: [] },
  environment: { keys: [] },
  secrets: { handles: [] }
}

function permissionsWith(kind: 'write' | 'network' | 'process' | 'environment' | 'secret'): GeneratedToolPermissionManifest {
  const permissions: GeneratedToolPermissionManifest = structuredClone(readOnlyPermissions)
  if (kind === 'write') permissions.filesystem.write = ['fixtures/output.json']
  if (kind === 'network') permissions.network.hosts = ['api.example.test']
  if (kind === 'process') permissions.process.commands = ['git']
  if (kind === 'environment') permissions.environment.keys = ['HOME']
  if (kind === 'secret') permissions.secrets.handles = ['token']
  return permissions
}

interface PolicyFixture {
  home: string
  job: ForgeJob
  stableVersionFingerprint: string
}

function createPolicyFixture(options: {
  level?: 'L1' | 'L2'
  permissions?: GeneratedToolPermissionManifest
  mode?: ForgeJob['mode']
  baseVersionId?: string
  baseFingerprint?: string
} = {}): PolicyFixture {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-tool-policy-'))
  const installedVersion = installSummarizeTaskJsonFixture(home, 1, { fixtureRoot: FIXTURE_ROOT })
  if (options.level) installRuntimeQualificationFixture(home, options.level)

  const permissions = options.permissions ?? readOnlyPermissions
  const sourceManifest = parseGeneratedToolManifest(JSON.parse(readFileSync(join(FIXTURE_ROOT, 'manifest.json'), 'utf8'))) as GeneratedToolManifest
  const manifest: GeneratedToolManifest = {
    ...sourceManifest,
    entrypoint: 'dist/tool.js',
    permissions
  }
  const spec: ForgeJob['spec'] = {
    id: TOOL_ID,
    displayName: manifest.displayName,
    goal: 'Read the project task fixture deterministically.',
    reason: 'Policy branch coverage fixture.',
    requestedBy: { sessionId: 'policy-session', runId: 'policy-run', userMessageId: 'policy-message' },
    scope: 'project',
    projectId: PROJECT_ID,
    inputContract: manifest.inputSchema,
    outputContract: manifest.outputSchema,
    permissions,
    acceptance: ['Returns deterministic task counts.'],
    examples: [{ input: {}, expected: 'open: 4' }]
  }
  const job: ForgeJob = {
    id: 'policy-job',
    idempotencyKey: `policy-${options.mode ?? 'create'}-${options.permissions ? 'custom' : 'read'}`,
    specHash: hashGeneratedToolSpec(spec),
    toolId: TOOL_ID,
    ...(options.baseVersionId ? { baseVersionId: options.baseVersionId, baseFingerprint: options.baseFingerprint ?? installedVersion.fingerprint } : {}),
    mode: options.mode ?? 'create',
    status: 'building',
    revision: 0,
    spec,
    attempt: 1,
    maxAttempts: 3,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    artifactPath: 'jobs/policy-job/workspace'
  }

  const workspace = join(generatedToolsRoot(home), ...job.artifactPath.split('/'))
  mkdirSync(join(workspace, 'source'), { recursive: true })
  mkdirSync(join(workspace, 'dist'), { recursive: true })
  writeFileSync(join(workspace, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  cpSync(join(FIXTURE_ROOT, 'source', 'tool.js'), join(workspace, 'source', 'tool.js'))
  cpSync(join(FIXTURE_ROOT, 'source', 'tool.js'), join(workspace, 'dist', 'tool.js'))
  createForgeJob(home, job)

  const sealed = sealGeneratedToolCandidate({
    jokerHome: home,
    jobId: job.id,
    expectedRevision: job.revision,
    validationSuiteId: 'policy-test-suite',
    validationSuiteHash: SUITE_HASH,
    createdAt: 2,
    validationRunId: 'policy-validation-run'
  })
  const report = commitValidationReportBundle({
    jokerHome: home,
    report: {
      toolId: TOOL_ID,
      versionId: sealed.candidate.id,
      artifactFingerprint: sealed.candidate.artifactFingerprint,
      startedAt: 3,
      finishedAt: 3,
      status: 'passed',
      checks: [{ id: 'policy-check', category: 'audit', status: 'passed', evidencePath: 'evidence/policy.json', message: 'policy fixture passed' }],
      declaredPermissions: permissions,
      observedCapabilities: []
    },
    evidence: [{ path: 'evidence/policy.json', bytes: '{"status":"passed"}\n' }],
    logs: 'policy fixture passed\n'
  })
  const awaiting = updateForgeJob(home, job.id, sealed.job.revision, (current) => ({
    ...current,
    revision: current.revision + 1,
    status: 'awaiting-policy',
    validationReportId: report.id,
    updatedAt: 4,
    currentPhase: 'awaiting-policy'
  }))
  return { home, job: awaiting, stableVersionFingerprint: installedVersion.fingerprint }
}

function evaluate(fixture: PolicyFixture, options: Omit<Partial<Parameters<typeof evaluateGeneratedToolPolicy>[0]>, 'jokerHome' | 'jobId'> = {}) {
  return evaluateGeneratedToolPolicy({
    jokerHome: fixture.home,
    jobId: fixture.job.id,
    evaluatedAt: 100,
    ...options
  })
}

void test('policy denies unqualified L0 runtime', () => {
  const fixture = createPolicyFixture()
  try {
    const result = evaluate(fixture)
    assert.equal(result.input.runtimeQualificationLevel, 'L0')
    assert.equal(result.decision.action, 'deny')
    assert.equal(result.decision.reasonCode, 'runtime-l0')
    assert.equal(result.decision.requiresApproval, false)
    assert.equal(result.decision.hardDeny, true)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

void test('policy requires approval at L1', () => {
  const fixture = createPolicyFixture({ level: 'L1' })
  try {
    const result = evaluate(fixture, { approvalMode: 'full-auto' })
    assert.equal(result.input.runtimeQualificationLevel, 'L1')
    assert.equal(result.input.approvalMode, 'full-auto')
    assert.equal(result.decision.action, 'ask')
    assert.equal(result.decision.reasonCode, 'runtime-l1-approval-required')
    assert.equal(result.decision.requiresApproval, true)
    assert.equal(result.decision.hardDeny, false)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

void test('qualified L2 project-read candidate is automatically allowed', () => {
  const fixture = createPolicyFixture({ level: 'L2' })
  try {
    const result = evaluate(fixture, { operation: 'execute' })
    assert.equal(result.input.runtimeQualificationLevel, 'L2')
    assert.equal(result.input.operation, 'execute')
    assert.equal(result.decision.action, 'allow')
    assert.equal(result.decision.reasonCode, 'runtime-l2-project-read')
    assert.equal(result.decision.requiresApproval, false)
    assert.equal(result.decision.hardDeny, false)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

for (const kind of ['write', 'network'] as const) {
  void test(`policy asks for approval for unsupported ${kind} permissions`, () => {
    const fixture = createPolicyFixture({ level: 'L2', permissions: permissionsWith(kind) })
    try {
      const result = evaluate(fixture)
      assert.equal(result.decision.action, 'ask')
      assert.equal(result.decision.reasonCode, 'permission-profile-unsupported')
      assert.equal(result.decision.requiresApproval, true)
      assert.equal(result.decision.hardDeny, false)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })
}

for (const kind of ['process', 'environment', 'secret'] as const) {
  void test(`policy hard-denies ${kind} permissions`, () => {
    const fixture = createPolicyFixture({ level: 'L2', permissions: permissionsWith(kind) })
    try {
      const result = evaluate(fixture)
      assert.equal(result.decision.action, 'deny')
      assert.equal(result.decision.reasonCode, 'permission-profile-hard-deny')
      assert.equal(result.decision.requiresApproval, false)
      assert.equal(result.decision.hardDeny, true)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })
}

void test('policy hard-denies a stale expected registry revision', () => {
  const fixture = createPolicyFixture({ level: 'L2' })
  try {
    const registry = readGeneratedToolRegistry(fixture.home)
    const result = evaluate(fixture, { expectedRegistryRevision: registry.revision + 1 })
    assert.equal(result.decision.action, 'deny')
    assert.equal(result.decision.reasonCode, 'stale-registry-revision')
    assert.equal(result.decision.hardDeny, true)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

void test('policy hard-denies an edit based on a version that is no longer active', () => {
  const initial = createPolicyFixture({ level: 'L2', mode: 'edit', baseVersionId: 'v1' })
  try {
    const fixture = { ...initial, job: initial.job }
    const registry = readGeneratedToolRegistry(fixture.home)
    disableGeneratedTool({
      jokerHome: fixture.home,
      registryId: registry.registryId,
      expectedRevision: registry.revision,
      operationId: 'policy-disable-stale-base',
      createdAt: 5,
      toolId: TOOL_ID
    })
    const result = evaluate(fixture)
    assert.equal(result.decision.action, 'deny')
    assert.equal(result.decision.reasonCode, 'stale-base-version')
    assert.equal(result.decision.hardDeny, true)
  } finally {
    rmSync(initial.home, { recursive: true, force: true })
  }
})

void test('promotion API rejects a durable policy whose registry input became stale', async () => {
  const fixture = createPolicyFixture({ level: 'L1' })
  try {
    const service = new PromotionService({ jokerHome: fixture.home, now: () => 100 })
    const first = await service.promote({
      jobId: fixture.job.id,
      expectedJobRevision: fixture.job.revision,
      registryRevision: readGeneratedToolRegistry(fixture.home).revision,
      expectedCandidateFingerprint: fixture.job.candidateFingerprint!,
      requestApproval: async () => null
    })
    assert.equal(first.action, 'approval-required')

    const registry = readGeneratedToolRegistry(fixture.home)
    revalidateGeneratedTool({
      jokerHome: fixture.home,
      registryId: registry.registryId,
      expectedRevision: registry.revision,
      operationId: 'policy-revalidate-for-approval-mismatch',
      createdAt: 101,
      toolId: TOOL_ID
    })

    await assert.rejects(
      service.promote({
        jobId: fixture.job.id,
        expectedJobRevision: fixture.job.revision,
        registryRevision: readGeneratedToolRegistry(fixture.home).revision,
        expectedCandidateFingerprint: fixture.job.candidateFingerprint!
      }),
      /Durable promotion policy no longer matches the current host input/
    )
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

void test('policy fixture keeps the installed stable version fingerprint bound', () => {
  const fixture = createPolicyFixture({ level: 'L2', mode: 'edit', baseVersionId: 'v1' })
  try {
    assert.match(fixture.stableVersionFingerprint, /^[a-f0-9]{64}$/)
    assert.equal(fixture.job.baseVersionId, 'v1')
    assert.equal(fixture.job.baseFingerprint, fixture.stableVersionFingerprint)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})
