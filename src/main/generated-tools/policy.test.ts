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
import { readGeneratedToolRegistry } from './registry'
import { evaluateGeneratedToolPolicy } from './policy'

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
  scope?: 'project' | 'user'
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
    scope: options.scope ?? 'project',
    ...((options.scope ?? 'project') === 'project' ? { projectId: PROJECT_ID } : {}),
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

void test('policy always allows regardless of runtime qualification level', () => {
  for (const level of [undefined, 'L1', 'L2'] as const) {
    const fixture = createPolicyFixture(level ? { level } : {})
    try {
      const result = evaluate(fixture)
      assert.equal(result.decision.action, 'allow')
      assert.equal(result.decision.reasonCode, 'workspace-full-trust-authorized')
      assert.equal(result.decision.requiresApproval, false)
      assert.equal(result.decision.hardDeny, false)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }
})

void test('qualified L2 zero-permission project candidate is automatically allowed', () => {
  const permissions: GeneratedToolPermissionManifest = structuredClone(readOnlyPermissions)
  permissions.filesystem.read = []
  const fixture = createPolicyFixture({ level: 'L2', permissions })
  try {
    const result = evaluate(fixture, { operation: 'promote' })
    assert.equal(result.decision.action, 'allow')
    assert.equal(result.decision.requiresApproval, false)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

void test('policy ignores declared permissions', () => {
  for (const kind of ['write', 'network', 'process', 'environment', 'secret'] as const) {
    const fixture = createPolicyFixture({ level: 'L2', permissions: permissionsWith(kind) })
    try {
      const result = evaluate(fixture)
      assert.equal(result.decision.action, 'allow')
      assert.equal(result.decision.reasonCode, 'workspace-full-trust-authorized')
      assert.equal(result.decision.requiresApproval, false)
      assert.equal(result.decision.hardDeny, false)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  }
})

void test('policy ignores a stale expected registry revision', () => {
  const fixture = createPolicyFixture({ level: 'L2' })
  try {
    const registry = readGeneratedToolRegistry(fixture.home)
    const result = evaluate(fixture, { expectedRegistryRevision: registry.revision + 1 })
    assert.equal(result.decision.action, 'allow')
    assert.equal(result.decision.reasonCode, 'workspace-full-trust-authorized')
    assert.equal(result.decision.hardDeny, false)
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
