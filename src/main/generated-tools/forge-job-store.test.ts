import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ForgeJob } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'
import { createForgeJob, readForgeJob, recoverInterruptedForgeJobs, updateForgeJob } from './forge-job-store'
import { ToolForgeCasError } from './registry'

const spec = {
  id: 'tool-1', displayName: 'Tool One', goal: 'Goal', reason: 'Reason', requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' },
  scope: 'user' as const, inputContract: {}, outputContract: {}, permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
  acceptance: ['works'], examples: [{ input: {}, expected: 'ok' }]
}
const job: ForgeJob = {
  id: 'job-1', idempotencyKey: 'idem-job-1', specHash: createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex'), toolId: 'tool-1', mode: 'create', status: 'queued', revision: 0, spec, attempt: 1, maxAttempts: 3,
  createdAt: 1, updatedAt: 1, artifactPath: 'jobs/job-1/workspace'
}

void test('startup recovery preserves queued jobs and interrupts active work exactly once', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-job-'))
  try {
    createForgeJob(home, job)
    assert.equal(recoverInterruptedForgeJobs(home, 4).length, 0)
    updateForgeJob(home, job.id, 0, (current) => ({ ...current, revision: 1, status: 'planning', startedAt: 2, updatedAt: 2 }))
    const recovered = recoverInterruptedForgeJobs(home, 5)
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].status, 'interrupted')
    assert.equal(recovered[0].revision, 2)
    assert.equal(recovered[0].error, 'recovered-after-restart')
    assert.equal(recoverInterruptedForgeJobs(home, 6).length, 0)
    assert.equal(readForgeJob(home, job.id)?.revision, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('ForgeJob creation deduplicates exact requests and rejects active tool conflicts', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-job-'))
  try {
    assert.deepEqual(createForgeJob(home, job), job)
    assert.deepEqual(createForgeJob(home, { ...job, id: 'job-replay' }), job)
    assert.throws(() => createForgeJob(home, { ...job, id: 'job-conflict', idempotencyKey: 'idem-conflict' }), /already owns this tool/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('ForgeJob repair consumes one attempt and clears candidate bindings', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-job-'))
  try {
    createForgeJob(home, job)
    updateForgeJob(home, job.id, 0, (current) => ({ ...current, revision: 1, status: 'planning', startedAt: 2, updatedAt: 2 }))
    updateForgeJob(home, job.id, 1, (current) => ({ ...current, revision: 2, status: 'building', updatedAt: 3 }))
    const validating = updateForgeJob(home, job.id, 2, (current) => ({
      ...current,
      revision: 3,
      status: 'validating',
      updatedAt: 4,
      candidateId: 'candidate-1',
      candidateFingerprint: 'a'.repeat(64),
      attemptRecordId: 'attempt-1',
      validationRunId: 'validation-1'
    }))
    assert.throws(() => updateForgeJob(home, job.id, validating.revision, (current) => ({
      ...current, revision: current.revision + 1, status: 'building', updatedAt: 5, attempt: current.attempt + 1
    })), /clear current candidate/)
    const repair = updateForgeJob(home, job.id, validating.revision, (current) => ({
      ...current,
      revision: current.revision + 1,
      status: 'building',
      updatedAt: 5,
      attempt: current.attempt + 1,
      candidateId: undefined,
      candidateFingerprint: undefined,
      attemptRecordId: undefined,
      validationRunId: undefined,
      validationReportId: undefined
    }))
    assert.equal(repair.attempt, 2)
    assert.equal(repair.candidateId, undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('ForgeJob creation is exact-idempotent and updates require revision CAS', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-forge-job-'))
  try {
    assert.deepEqual(createForgeJob(home, job), job)
    assert.deepEqual(createForgeJob(home, job), job)
    assert.throws(() => createForgeJob(home, { ...job, id: 'job-2', maxAttempts: 2 }), ToolForgeCasError)
    const planning = updateForgeJob(home, job.id, 0, (current) => ({ ...current, revision: 1, status: 'planning', updatedAt: 2, startedAt: 2 }))
    const building = updateForgeJob(home, job.id, 1, (current) => ({ ...current, revision: 2, status: 'building', updatedAt: 3 }))
    assert.equal(planning.status, 'planning')
    assert.equal(building.status, 'building')
    assert.equal(readForgeJob(home, job.id)?.revision, 2)
    assert.throws(() => updateForgeJob(home, job.id, 1, (current) => ({ ...current, revision: 2 })), ToolForgeCasError)
    assert.throws(() => updateForgeJob(home, job.id, 2, (current) => ({ ...current, revision: 3, status: 'completed', finishedAt: 4, validationReportId: 'report-1', updatedAt: 4 })), /validation report requires candidate|Invalid ForgeJob transition/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
