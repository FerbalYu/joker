import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { RuntimeQualificationService } from './runtime-qualification-service'
import {
  readQualificationOperation,
  writeQualificationOperation,
  type QualificationOperationRecord
} from './qualification-operation-store'
import {
  getQualificationPath,
  qualificationReportFingerprint,
  readRuntimeQualificationReport
} from './qualification'
import { installRuntimeQualificationFixture } from './test-fixtures'

const fixtureRoot = resolve(process.cwd(), 'scripts', 'fixtures', 'generated-tools', 'summarize-task-json')

function home(): string {
  return mkdtempSync(join(tmpdir(), 'joker-runtime-qualification-service-'))
}

async function waitForTerminal(jokerHome: string): Promise<NonNullable<ReturnType<typeof readQualificationOperation>>> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const operation = readQualificationOperation(jokerHome)
    if (operation && !['queued', 'running'].includes(operation.status)) return operation
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  throw new Error('qualification operation did not reach a terminal state')
}

function record(status: QualificationOperationRecord['status']): QualificationOperationRecord {
  return {
    schemaVersion: 1,
    attemptId: 'qualification-existing',
    status,
    phase: status,
    completedChecks: 0,
    totalChecks: 8,
    updatedAt: 100
  }
}

void test('runtime qualification service completes host verification as L1 and retains evidence', async () => {
  const jokerHome = home()
  const service = new RuntimeQualificationService({ jokerHome, fixtureRoot, createId: () => 'attempt-1', now: () => Date.now() })
  try {
    const queued = service.start()
    assert.equal(queued.status, 'queued')
    assert.equal(queued.totalChecks, 8)
    const terminal = await waitForTerminal(jokerHome)
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.completedChecks, 8)
    assert.equal(terminal.phase, 'completed')
    const report = readRuntimeQualificationReport(jokerHome)
    assert.equal(report?.level, 'L1')
    assert.equal(report?.environments.dev.status, 'passed')
    assert.equal(report?.environments.packaged.status, 'incomplete')
    assert.equal(report?.candidates[0]?.cases.length, 8)
    assert.ok(existsSync(getQualificationPath(jokerHome)))
    for (const item of report?.candidates[0]?.cases ?? []) {
      assert.equal(item.status, 'pass')
      assert.ok(item.evidence?.path.startsWith(`evidence/${queued.attemptId}/`))
    }
  } finally {
    service.stop()
  }
})

void test('runtime qualification start is idempotent while an attempt is active', async () => {
  const jokerHome = home()
  const service = new RuntimeQualificationService({ jokerHome, fixtureRoot, createId: (() => {
    let count = 0
    return () => `attempt-${++count}`
  })() })
  try {
    const first = service.start()
    const second = service.start()
    assert.equal(second.attemptId, first.attemptId)
    assert.ok(['queued', 'running'].includes(second.status))
    const terminal = await waitForTerminal(jokerHome)
    assert.equal(terminal.status, 'completed')
    const next = service.start()
    assert.notEqual(next.attemptId, first.attemptId)
  } finally {
    service.stop()
  }
})

void test('cancellation reaches a terminal cancelled state without replacing a valid report', async () => {
  const jokerHome = home()
  installRuntimeQualificationFixture(jokerHome, 'L1')
  const before = readRuntimeQualificationReport(jokerHome)
  assert.ok(before)
  const service = new RuntimeQualificationService({ jokerHome, fixtureRoot })
  try {
    service.start()
    const cancelled = service.cancel()
    assert.equal(cancelled?.status, 'cancelled')
    const terminal = await waitForTerminal(jokerHome)
    assert.equal(terminal.status, 'cancelled')
    assert.equal(terminal.error, 'cancelled-by-user')
    assert.deepEqual(readRuntimeQualificationReport(jokerHome), before)
    assert.equal(qualificationReportFingerprint(readRuntimeQualificationReport(jokerHome)!), qualificationReportFingerprint(before))
  } finally {
    service.stop()
  }
})

void test('recover marks queued and running attempts interrupted but preserves terminal records', () => {
  for (const status of ['queued', 'running'] as const) {
    const jokerHome = home()
    writeQualificationOperation(record(status), jokerHome)
    const service = new RuntimeQualificationService({ jokerHome, now: () => 200 })
    const recovered = service.recover()
    assert.equal(recovered?.status, 'interrupted')
    assert.equal(recovered?.phase, 'interrupted')
    assert.equal(recovered?.error, 'qualification-service-stopped')
    assert.equal(recovered?.finishedAt, 200)
  }
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
    const jokerHome = home()
    const existing = record(status)
    writeQualificationOperation(existing, jokerHome)
    const recovered = new RuntimeQualificationService({ jokerHome, now: () => 200 }).recover()
    assert.deepEqual(recovered, existing)
  }
})

void test('qualification failure is durable, sanitized, and preserves the last valid report', async () => {
  const jokerHome = home()
  installRuntimeQualificationFixture(jokerHome, 'L1')
  const before = readRuntimeQualificationReport(jokerHome)
  assert.ok(before)
  const service = new RuntimeQualificationService({ jokerHome, fixtureRoot: join(jokerHome, 'missing-fixture-root') })
  try {
    service.start()
    const terminal = await waitForTerminal(jokerHome)
    assert.equal(terminal.status, 'failed')
    assert.match(terminal.error ?? '', /manifest|ENOENT|fixture/i)
    assert.doesNotMatch(terminal.error ?? '', new RegExp(jokerHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.deepEqual(readRuntimeQualificationReport(jokerHome), before)
  } finally {
    service.stop()
  }
})
