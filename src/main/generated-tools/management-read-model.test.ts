import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'
import { installSummarizeTaskJsonFixture } from './fixture'
import { listGeneratedToolsForManagement, getGeneratedToolForManagement } from './management-read-model'
import { proposeGeneratedToolInvocation, updateGeneratedToolInvocation } from './invocation-store'
import { disableGeneratedTool, readGeneratedToolRegistry } from './registry'
import { canonicalVersionPath, generatedToolsRoot } from './store'
import { installRuntimeQualificationFixture } from './test-fixtures'

void test('management read model exposes verified fixture without host paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const listed = listGeneratedToolsForManagement(home)
    assert.equal(listed.success, true)
    if (!listed.success) return
    assert.equal(listed.data.registryRevision, 2)
    assert.equal(listed.data.capabilityRevision, 1)
    assert.equal(listed.data.tools.length, 1)
    assert.equal(listed.data.tools[0].availability, 'available')
    assert.equal(listed.data.tools[0].executable, true)
    assert.equal(listed.data.tools[0].integrity, 'verified')

    const detail = getGeneratedToolForManagement('summarize-task-json', home)
    assert.equal(detail.success, true)
    if (!detail.success) return
    assert.equal(detail.data.versions[0].validationReport?.checks.length, 8)
    const serialized = JSON.stringify(detail)
    assert.doesNotMatch(serialized, /artifactPath|logsPath|evidencePath/)
    assert.doesNotMatch(serialized, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('management read model derives invocation statistics from started records only', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  try {
    installRuntimeQualificationFixture(home)
    const version = installSummarizeTaskJsonFixture(home, 1)
    const denied = proposeGeneratedToolInvocation(home, {
      id: 'invocation-denied', idempotencyKey: 'denied', toolId: version.toolId, versionId: version.id,
      fingerprint: version.fingerprint, sessionId: 'session-1', runId: 'run-1', toolCallId: 'call-denied',
      capabilityRevision: 1, request: {}, proposedAt: 2
    })
    updateGeneratedToolInvocation(home, denied.id, 0, (current) => ({ ...current, revision: 1, status: 'policy', policyAt: 3, policyDecision: 'deny' }))
    updateGeneratedToolInvocation(home, denied.id, 1, (current) => ({ ...current, revision: 2, status: 'finished', finishedAt: 4, outcome: 'cancelled' }))
    const allowed = proposeGeneratedToolInvocation(home, {
      id: 'invocation-allowed', idempotencyKey: 'allowed', toolId: version.toolId, versionId: version.id,
      fingerprint: version.fingerprint, sessionId: 'session-1', runId: 'run-2', toolCallId: 'call-allowed',
      capabilityRevision: 1, request: {}, proposedAt: 5
    })
    updateGeneratedToolInvocation(home, allowed.id, 0, (current) => ({ ...current, revision: 1, status: 'policy', policyAt: 6, policyDecision: 'allow' }))
    updateGeneratedToolInvocation(home, allowed.id, 1, (current) => ({ ...current, revision: 2, status: 'started', startedAt: 7 }))
    updateGeneratedToolInvocation(home, allowed.id, 2, (current) => ({ ...current, revision: 3, status: 'finished', finishedAt: 8, outcome: 'failed', error: 'fixture failure' }))

    const listed = listGeneratedToolsForManagement(home)
    assert.equal(listed.success, true)
    if (!listed.success) return
    assert.equal(listed.data.tools[0].invocationCount, 1)
    assert.equal(listed.data.tools[0].lastInvokedAt, 8)
    assert.equal(listed.data.tools[0].lastOutcome, 'failed')
    assert.equal(listed.data.tools[0].lastError, 'fixture failure')

    const detail = getGeneratedToolForManagement(version.toolId, home)
    assert.equal(detail.success, true)
    if (detail.success) assert.deepEqual(detail.data.recentInvocations.map((item) => item.id), ['invocation-allowed', 'invocation-denied'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('management read model reports disabled and changed artifacts as non-executable', () => {
  const disabledHome = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  const changedHome = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  try {
    installRuntimeQualificationFixture(disabledHome)
    installRuntimeQualificationFixture(changedHome)
    installSummarizeTaskJsonFixture(disabledHome, 1)
    const registry = readGeneratedToolRegistry(disabledHome)
    disableGeneratedTool({ jokerHome: disabledHome, registryId: registry.registryId, expectedRevision: registry.revision, operationId: 'disable-management', createdAt: 2, toolId: 'summarize-task-json' })
    const disabled = listGeneratedToolsForManagement(disabledHome)
    assert.equal(disabled.success, true)
    if (disabled.success) {
      assert.equal(disabled.data.tools[0].availability, 'disabled')
      assert.equal(disabled.data.tools[0].executable, false)
    }

    installSummarizeTaskJsonFixture(changedHome, 1)
    const artifactRoot = join(generatedToolsRoot(changedHome), ...canonicalVersionPath('summarize-task-json', 'v1').split('/'))
    mkdirSync(join(artifactRoot, 'dist'), { recursive: true })
    writeFileSync(join(artifactRoot, 'dist', 'tool.js'), 'export default 1\n')
    const changed = listGeneratedToolsForManagement(changedHome)
    assert.equal(changed.success, true)
    if (changed.success) {
      assert.equal(changed.data.tools[0].availability, 'changed')
      assert.equal(changed.data.tools[0].executable, false)
      assert.equal(changed.data.tools[0].integrity, 'degraded')
    }
  } finally {
    rmSync(disabledHome, { recursive: true, force: true })
    rmSync(changedHome, { recursive: true, force: true })
  }
})

void test('management read model exposes failed, quarantined and missing host states', () => {
  const failedHome = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  const quarantinedHome = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  const missingHome = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  const setReportStatus = (home: string, status: 'failed' | 'quarantined'): void => {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const artifactRoot = join(generatedToolsRoot(home), ...canonicalVersionPath('summarize-task-json', 'v1').split('/'))
    const reportPath = join(artifactRoot, 'validation-report.json')
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
    writeFileSync(reportPath, `${JSON.stringify({ ...report, status }, null, 2)}\n`)
  }
  try {
    installRuntimeQualificationFixture(failedHome)
    installRuntimeQualificationFixture(quarantinedHome)
    installRuntimeQualificationFixture(missingHome)
    setReportStatus(failedHome, 'failed')
    const failed = listGeneratedToolsForManagement(failedHome)
    assert.equal(failed.success, true)
    if (failed.success) {
      assert.equal(failed.data.tools[0].availability, 'failed')
      assert.equal(failed.data.tools[0].executable, false)
    }

    setReportStatus(quarantinedHome, 'quarantined')
    const quarantined = listGeneratedToolsForManagement(quarantinedHome)
    assert.equal(quarantined.success, true)
    if (quarantined.success) {
      assert.equal(quarantined.data.tools[0].availability, 'quarantined')
      assert.equal(quarantined.data.tools[0].executable, false)
    }

    installSummarizeTaskJsonFixture(missingHome, 1)
    const artifactRoot = join(generatedToolsRoot(missingHome), ...canonicalVersionPath('summarize-task-json', 'v1').split('/'))
    rmSync(artifactRoot, { recursive: true, force: true })
    const missing = listGeneratedToolsForManagement(missingHome)
    assert.equal(missing.success, true)
    if (missing.success) {
      assert.equal(missing.data.tools[0].availability, 'missing')
      assert.equal(missing.data.tools[0].executable, false)
    }
  } finally {
    rmSync(failedHome, { recursive: true, force: true })
    rmSync(quarantinedHome, { recursive: true, force: true })
    rmSync(missingHome, { recursive: true, force: true })
  }
})

void test('management read model preserves stable availability alongside candidate job state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const { createForgeJob, updateForgeJob } = await import('./forge-job-store')
    const spec = {
      id: 'summarize-task-json', displayName: 'SummarizeTaskJson', goal: 'Edit tool', reason: 'Test candidate state',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project' as const,
      projectId: 'qualification-p0', inputContract: {}, outputContract: {},
      permissions: { filesystem: { read: ['fixtures/tasks.json'], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
      acceptance: ['works'], examples: [{ input: {}, expected: 'ok' }]
    }
    const job = createForgeJob(home, {
      id: 'job-candidate', idempotencyKey: 'idem-job-candidate', specHash: createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex'), toolId: 'summarize-task-json', baseVersionId: 'v1', baseFingerprint: 'a'.repeat(64), mode: 'edit', status: 'queued', revision: 0,
      spec, attempt: 1, maxAttempts: 3, createdAt: 2, updatedAt: 2, artifactPath: 'jobs/job-candidate/workspace'
    })
    updateForgeJob(home, job.id, 0, (current) => ({ ...current, revision: 1, status: 'planning', startedAt: 3, updatedAt: 3 }))
    updateForgeJob(home, job.id, 1, (current) => ({ ...current, revision: 2, status: 'building', updatedAt: 4 }))
    updateForgeJob(home, job.id, 2, (current) => ({ ...current, revision: 3, status: 'failed', error: 'candidate failed', finishedAt: 5, updatedAt: 5 }))
    const listed = listGeneratedToolsForManagement(home)
    assert.equal(listed.success, true)
    if (listed.success) {
      assert.equal(listed.data.tools[0].availability, 'available')
      assert.equal(listed.data.tools[0].executable, true)
      assert.equal(listed.data.tools[0].candidate?.status, 'failed')
    }
    const detail = getGeneratedToolForManagement('summarize-task-json', home)
    assert.equal(detail.success, true)
    if (detail.success) {
      assert.equal(detail.data.recentJobs[0]?.jobRevision, 3)
      assert.equal('revision' in detail.data.recentJobs[0], false)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('management read model lists candidate-only create jobs without registry publication', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  try {
    const { createForgeJob } = await import('./forge-job-store')
    const spec = {
      id: 'candidate-only-tool', displayName: 'Candidate Only Tool', goal: 'Read one project fixture', reason: 'Capability missing',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project' as const,
      projectId: 'project-1', inputContract: {}, outputContract: { type: 'string' },
      permissions: { filesystem: { read: ['fixtures/input.txt'], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
      acceptance: ['works'], examples: [{ input: {}, expected: 'ok' }]
    }
    createForgeJob(home, {
      id: 'job-candidate-only', idempotencyKey: 'idem-candidate-only',
      specHash: createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex'),
      toolId: spec.id, mode: 'create', status: 'queued', revision: 0, spec, attempt: 1, maxAttempts: 3,
      createdAt: 1, updatedAt: 1, artifactPath: 'jobs/job-candidate-only/workspace'
    })
    const listed = listGeneratedToolsForManagement(home)
    assert.equal(listed.success, true)
    if (listed.success) {
      assert.equal(listed.data.tools.length, 1)
      assert.equal(listed.data.tools[0].toolId, spec.id)
      assert.equal(listed.data.tools[0].availability, 'building')
      assert.equal(listed.data.tools[0].executable, false)
      assert.equal(listed.data.tools[0].candidate?.jobId, 'job-candidate-only')
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('management read model gates execution by runtime qualification level', () => {
  const missingHome = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  const l1Home = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  try {
    installSummarizeTaskJsonFixture(missingHome, 1)
    const missing = listGeneratedToolsForManagement(missingHome)
    assert.equal(missing.success, true)
    if (missing.success) {
      assert.equal(missing.data.qualification, null)
      assert.equal(missing.data.tools[0].availability, 'available')
      assert.equal(missing.data.tools[0].executable, false)
      assert.equal(missing.data.tools[0].executionPolicy, 'unavailable')
    }

    installRuntimeQualificationFixture(l1Home, 'L1')
    installSummarizeTaskJsonFixture(l1Home, 1)
    const l1 = listGeneratedToolsForManagement(l1Home)
    assert.equal(l1.success, true)
    if (l1.success) {
      assert.equal(l1.data.qualification?.level, 'L1')
      assert.equal(l1.data.tools[0].executable, true)
      assert.equal(l1.data.tools[0].executionPolicy, 'approval-required')
    }
  } finally {
    rmSync(missingHome, { recursive: true, force: true })
    rmSync(l1Home, { recursive: true, force: true })
  }
})

void test('management read model rejects tampered version metadata and sanitizes persisted diagnostics', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  try {
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const artifactRoot = join(generatedToolsRoot(home), ...canonicalVersionPath('summarize-task-json', 'v1').split('/'))
    const versionPath = join(artifactRoot, 'version.json')
    const version = JSON.parse(readFileSync(versionPath, 'utf8')) as Record<string, unknown>
    const manifest = structuredClone(version['manifest']) as Record<string, unknown>
    manifest['permissions'] = {
      filesystem: { read: ['C:/private/secret.txt'], write: [] },
      network: { hosts: [] },
      process: { commands: [] },
      environment: { keys: [] },
      secrets: { handles: [] }
    }
    writeFileSync(versionPath, `${JSON.stringify({ ...version, manifest }, null, 2)}\n`, 'utf8')
    const changed = listGeneratedToolsForManagement(home)
    assert.equal(changed.success, true)
    if (changed.success) {
      assert.equal(changed.data.tools[0].availability, 'changed')
      assert.equal(changed.data.tools[0].executable, false)
    }

    writeFileSync(versionPath, `${JSON.stringify(version, null, 2)}\n`, 'utf8')
    const reportPath = join(artifactRoot, 'validation-report.json')
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { checks: Array<Record<string, unknown>>; observedCapabilities: string[] }
    report.checks[0] = { ...report.checks[0], message: 'failed at C:\\Users\\alice\\private\\secret.txt' }
    report.observedCapabilities = ['filesystem.read:/Users/alice/private/secret.txt']
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    const detail = getGeneratedToolForManagement('summarize-task-json', home)
    assert.equal(detail.success, true)
    if (detail.success) {
      const serialized = JSON.stringify(detail)
      assert.doesNotMatch(serialized, /C:\\\\Users\\\\alice|\/Users\/alice\/private/)
      assert.match(serialized, /\[path\]/)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('management detail rejects invalid and unknown tool ids', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-generated-management-'))
  try {
    assert.equal(getGeneratedToolForManagement('../escape', home).success, false)
    installRuntimeQualificationFixture(home)
    installSummarizeTaskJsonFixture(home, 1)
    const result = getGeneratedToolForManagement('unknown-tool', home)
    assert.deepEqual(result, { success: false, error: { code: 'not-found', message: 'Generated Tool was not found' } })
  } finally { rmSync(home, { recursive: true, force: true }) }
})
