import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ForgeJob } from '../../shared/generated-tools'
import { canonicalGeneratedToolJson } from '../../shared/generated-tools-schema'
import {
  readForgeAttemptRecord,
  readGeneratedToolCandidate,
  sealGeneratedToolCandidate,
  verifyGeneratedToolCandidate
} from './candidate-store'
import { createForgeJob, updateForgeJob } from './forge-job-store'
import { generatedToolsRoot } from './store'

const fixtureRoot = join(process.cwd(), 'scripts', 'fixtures', 'generated-tools', 'summarize-task-json')
const suiteHash = 'b'.repeat(64)

function specHash(spec: ForgeJob['spec']): string {
  return createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex')
}

function createBuildingJob(home: string): ForgeJob {
  const spec: ForgeJob['spec'] = {
    id: 'summarize-task-json',
    displayName: 'SummarizeTaskJson',
    goal: 'Summarize task counts.',
    reason: 'No existing capability.',
    requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' },
    scope: 'project',
    projectId: 'project-1',
    inputContract: {},
    outputContract: { type: 'string' },
    permissions: {
      filesystem: { read: ['fixtures/tasks.json'], write: [] },
      network: { hosts: [] },
      process: { commands: [] },
      environment: { keys: [] },
      secrets: { handles: [] }
    },
    acceptance: ['Returns deterministic counts.'],
    examples: [{ input: {}, expected: 'open: 4' }]
  }
  const job: ForgeJob = {
    id: 'job-candidate-1',
    idempotencyKey: 'idem-candidate-1',
    specHash: specHash(spec),
    toolId: spec.id,
    mode: 'create',
    status: 'queued',
    revision: 0,
    spec,
    attempt: 1,
    maxAttempts: 3,
    createdAt: 1,
    updatedAt: 1,
    artifactPath: 'jobs/job-candidate-1/workspace'
  }
  const draft = join(generatedToolsRoot(home), ...job.artifactPath.split('/'))
  mkdirSync(draft, { recursive: true })
  cpSync(fixtureRoot, draft, { recursive: true })
  const manifestPath = join(draft, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, entrypoint: 'dist/tool.js' }, null, 2)}\n`, 'utf8')
  mkdirSync(join(draft, 'dist'), { recursive: true })
  cpSync(join(draft, 'source', 'tool.js'), join(draft, 'dist', 'tool.js'))
  createForgeJob(home, job)
  updateForgeJob(home, job.id, 0, (current) => ({ ...current, revision: 1, status: 'planning', startedAt: 2, updatedAt: 2 }))
  return updateForgeJob(home, job.id, 1, (current) => ({ ...current, revision: 2, status: 'building', updatedAt: 3 }))
}

void test('candidate sealing snapshots one immutable candidate and attempt', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-candidate-store-'))
  try {
    const building = createBuildingJob(home)
    const sealed = sealGeneratedToolCandidate({
      jokerHome: home,
      jobId: building.id,
      expectedRevision: building.revision,
      validationSuiteId: 'summarize-task-json-v1',
      validationSuiteHash: suiteHash,
      createdAt: 4,
      validationRunId: 'validation-run-1'
    })
    assert.equal(sealed.job.status, 'validating')
    assert.equal(sealed.job.candidateId, sealed.candidate.id)
    assert.equal(sealed.job.attemptRecordId, sealed.attempt.id)
    assert.deepEqual(readGeneratedToolCandidate(home, building.id, sealed.candidate.id), sealed.candidate)
    assert.deepEqual(readForgeAttemptRecord(home, building.id, 1), sealed.attempt)
    assert.deepEqual(verifyGeneratedToolCandidate(home, sealed.candidate), sealed.candidate)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('sealed candidate fails closed after artifact mutation', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-candidate-store-'))
  try {
    const building = createBuildingJob(home)
    const sealed = sealGeneratedToolCandidate({
      jokerHome: home,
      jobId: building.id,
      expectedRevision: building.revision,
      validationSuiteId: 'summarize-task-json-v1',
      validationSuiteHash: suiteHash,
      createdAt: 4,
      validationRunId: 'validation-run-1'
    })
    const source = join(generatedToolsRoot(home), ...sealed.candidate.artifactPath.split('/'), 'source', 'tool.js')
    writeFileSync(source, 'tool.output("tampered")\n', 'utf8')
    assert.throws(() => verifyGeneratedToolCandidate(home, sealed.candidate), /changed after sealing/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
