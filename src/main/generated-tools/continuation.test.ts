import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { claimToolForgeContinuation, readToolForgeContinuations, updateToolForgeContinuation } from './continuation'
import { ToolForgeCasError } from './registry'

const claim = {
  schemaVersion: 1 as const, id: 'continuation-1', jobId: 'job-1', capabilityRevision: 2,
  sessionId: 'session-1', sourceRunId: 'run-1', status: 'claimed' as const, revision: 0, claimedAt: 1, updatedAt: 1
}

void test('continuation claim is unique per job and capability revision with exact replay', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-continuation-'))
  try {
    assert.equal(claimToolForgeContinuation(home, claim).idempotent, false)
    assert.equal(claimToolForgeContinuation(home, claim).idempotent, true)
    assert.throws(() => claimToolForgeContinuation(home, { ...claim, id: 'continuation-2' }), ToolForgeCasError)
    assert.equal(readToolForgeContinuations(home).claims.length, 1)
    assert.throws(() => claimToolForgeContinuation(home, { ...claim, jobId: 'job-2', capabilityRevision: 0 }))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('continuation cancellation is durable and terminal', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-continuation-'))
  try {
    claimToolForgeContinuation(home, claim)
    const cancelled = updateToolForgeContinuation(home, claim.id, 0, (current) => ({
      ...current, revision: 1, status: 'cancelled', updatedAt: 2
    }))
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.continuationRunId, undefined)
    assert.throws(() => updateToolForgeContinuation(home, claim.id, 1, (current) => ({ ...current, revision: 2, status: 'completed', continuationRunId: 'run-2', updatedAt: 3 })), ToolForgeCasError)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('continuation terminal transition is CAS-protected and one-way', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-continuation-'))
  try {
    claimToolForgeContinuation(home, claim)
    const completed = updateToolForgeContinuation(home, claim.id, 0, (current) => ({
      ...current, revision: 1, status: 'completed', continuationRunId: 'run-2', updatedAt: 2
    }))
    assert.equal(completed.status, 'completed')
    assert.throws(() => updateToolForgeContinuation(home, claim.id, 0, (current) => ({ ...current, revision: 1 })), ToolForgeCasError)
    assert.throws(() => updateToolForgeContinuation(home, claim.id, 1, (current) => ({ ...current, revision: 2, status: 'cancelled', continuationRunId: undefined, updatedAt: 3 })), ToolForgeCasError)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
