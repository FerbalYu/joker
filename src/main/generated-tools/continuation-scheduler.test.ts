import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ContinuationScheduler } from './continuation-scheduler'
import { updateContinuationV2 } from './continuation-v2'

const hash = 'a'.repeat(64)

function input() {
  return {
    jobId: 'job-1',
    toolId: 'tool-1',
    versionId: 'version-1',
    fingerprint: hash,
    validationReportId: 'report-1',
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceUserMessageId: 'message-1',
    specHash: hash,
    fromCapabilityRevision: 0,
    toCapabilityRevision: 1,
    userIntentRevision: 1,
    request: { reasoningLevel: 'auto', runMode: 'chat' as const }
  }
}

void test('continuation scheduler creates an idempotent ready record and claims dispatch once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-continuation-v2-'))
  try {
    const scheduler = new ContinuationScheduler({ jokerHome: home, createId: () => 'fixed', now: () => 10 })
    const first = scheduler.ensureReady(input())
    const second = scheduler.ensureReady({ ...input(), continuationId: first.id })
    assert.equal(second.id, first.id)
    const dispatched: string[] = []
    scheduler.attach(1, {
      isSessionRunning: () => false,
      dispatch: (continuation) => { dispatched.push(continuation.continuationRunId ?? '') }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(dispatched, ['continuation-run-fixed'])
    const current = scheduler.read(first.id)
    assert.equal(current?.status, 'dispatched')
    assert.equal(current?.continuationRunId, 'continuation-run-fixed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('continuation scheduler marks interrupted dispatches for restart reconciliation', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-continuation-v2-recovery-'))
  try {
    const scheduler = new ContinuationScheduler({ jokerHome: home, now: () => 20 })
    const created = scheduler.ensureReady(input())
    const dispatched = updateContinuationV2(home, created.id, created.revision, (current) => ({
      ...current,
      status: 'dispatched',
      continuationRunId: 'continuation-run-1',
      updatedAt: 21,
      revision: current.revision + 1
    }))
    assert.equal(dispatched.status, 'dispatched')
    const recovered = scheduler.recover()
    assert.equal(recovered[0]?.status, 'ready')
    assert.equal(recovered[0]?.attempt, 2)
    assert.equal(recovered[0]?.error, 'recovered-after-restart')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
