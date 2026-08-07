import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'
import { createForgeJob } from '../generated-tools/forge-job-store'
import { installRuntimeQualificationFixture } from '../generated-tools/test-fixtures'
import { buildToolForgeMetaTools } from './tool-forge'
import { searchTools } from './tool-search'

void test('ToolSearch reports exact builtin and in-progress ForgeJob capabilities deterministically', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-tool-search-'))
  try {
    const spec = {
      id: 'candidate-tool', displayName: 'CandidateTool', goal: 'Summarize candidate files', reason: 'Missing capability',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project' as const, projectId: 'project-1',
      inputContract: {}, outputContract: { type: 'string' },
      permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
      acceptance: ['works'], examples: [{ input: {}, expected: 'ok' }]
    }
    createForgeJob(home, {
      id: 'job-search', idempotencyKey: 'idem-search',
      specHash: createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex'),
      toolId: spec.id, mode: 'create', status: 'queued', revision: 0, spec, attempt: 1, maxAttempts: 3,
      createdAt: 1, updatedAt: 1, artifactPath: 'jobs/job-search/workspace'
    })
    assert.equal(searchTools('Read', { jokerHome: home, builtinTools: [{ name: 'Read', description: 'Read project files' }] })[0]?.match, 'exact')
    const building = searchTools('candidate-tool', { jokerHome: home })[0]
    assert.equal(building?.match, 'building')
    assert.equal(building?.jobId, 'job-search')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('ToolPromote schema rejects spoofed approval and propagates host approval plumbing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-tool-promote-'))
  try {
    const calls: unknown[] = []
    const promotionService = {
      promote: async (input: unknown) => {
        calls.push(input)
        return {
          job: { id: 'job-1', toolId: 'tool-1', status: 'awaiting-policy', revision: 4 },
          journal: { id: 'promotion-1', phase: 'intent' },
          action: 'approval-required',
          reason: 'approval required'
        }
      }
    }
    const promote = buildToolForgeMetaTools({ jokerHome: home, promotionService: promotionService as never }).find((item) => item.name === 'ToolPromote')!
    const valid = {
      jobId: 'job-1',
      expectedJobRevision: 4,
      registryRevision: 9,
      expectedCandidateFingerprint: 'a'.repeat(64)
    }
    assert.throws(() => promote.inputSchema.parse({ ...valid, approval: { approved: true } }))
    const requestHostApproval = async () => null
    const output = JSON.parse((await promote.execute(valid, {
      workspacePath: null,
      sessionId: 'session-1',
      runId: 'run-1',
      approvalGate: async () => ({ outcome: 'allow', risk: 'write_local', reason: 'test' }),
      requestHostApproval
    })).output)
    assert.equal(output.jobRevision, 4)
    assert.equal('revision' in output, false)
    assert.equal((calls[0] as { expectedJobRevision: number }).expectedJobRevision, 4)
    assert.equal((calls[0] as { registryRevision: number }).registryRevision, 9)
    assert.equal((calls[0] as { requestApproval: unknown }).requestApproval, requestHostApproval)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('ToolForge meta tools create, inspect, and cancel durable jobs without claiming task completion', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-tool-forge-'))
  try {
    installRuntimeQualificationFixture(home, 'L1')
    const enqueued: string[] = []
    const cancelled: Array<{ jobId: string; expectedRevision: number }> = []
    const controller = {
      enqueue: (jobId: string) => { enqueued.push(jobId) },
      cancel: async (jobId: string, expectedRevision: number) => {
        cancelled.push({ jobId, expectedRevision })
        const { updateForgeJob } = await import('../generated-tools/forge-job-store')
        return updateForgeJob(home, jobId, expectedRevision, (current) => ({
          ...current, revision: current.revision + 1, status: 'cancelled', updatedAt: 5, finishedAt: 5,
          candidateId: undefined, candidateFingerprint: undefined, attemptRecordId: undefined,
          validationRunId: undefined, validationReportId: undefined, error: 'cancelled-by-user'
        }))
      }
    }
    const tools = buildToolForgeMetaTools({ jokerHome: home, now: () => 5, createId: () => 'job-1', controller })
    const start = tools.find((item) => item.name === 'ToolForgeStart')!
    const spec = {
      id: 'new-tool', displayName: 'NewTool', goal: 'Return ok', reason: 'Missing capability',
      requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' }, scope: 'project' as const, projectId: 'project-1',
      inputContract: {}, outputContract: { type: 'string' },
      permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
      acceptance: ['works'], examples: [{ input: {}, expected: 'ok' }]
    }
    const context = { workspacePath: null, sessionId: 'session-1', approvalGate: async () => ({ outcome: 'allow' as const, risk: 'write_local' as const, reason: 'test' }) }
    const started = JSON.parse((await start.execute({ idempotencyKey: 'idem-new', mode: 'create', maxAttempts: 3, spec }, context)).output)
    assert.equal(started.status, 'queued')
    assert.deepEqual(enqueued, [started.jobId])
    assert.equal(started.originalTaskComplete, false)
    const status = tools.find((item) => item.name === 'ToolForgeStatus')!
    const observed = JSON.parse((await status.execute({ jobId: started.jobId }, context)).output)
    assert.equal(observed.status, 'queued')
    assert.equal(observed.jobRevision, 0)
    assert.equal(observed.registryRevision, 0)
    const cancel = tools.find((item) => item.name === 'ToolForgeCancel')!
    const cancelledResult = JSON.parse((await cancel.execute({ jobId: started.jobId, expectedRevision: 0 }, context)).output)
    assert.deepEqual(cancelled, [{ jobId: started.jobId, expectedRevision: 0 }])
    assert.equal(cancelledResult.status, 'cancelled')
    assert.equal(cancelledResult.originalTaskComplete, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
