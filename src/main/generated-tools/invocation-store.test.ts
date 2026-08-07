import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { proposeGeneratedToolInvocation, readGeneratedToolInvocations, updateGeneratedToolInvocation } from './invocation-store'
import { ToolForgeCasError } from './registry'

const proposal = {
  id: 'invocation-1', idempotencyKey: 'idem-1', toolId: 'tool-1', versionId: 'version-1', fingerprint: 'a'.repeat(64),
  sessionId: 'session-1', runId: 'run-1', toolCallId: 'call-1', capabilityRevision: 3, request: { value: 1 }, proposedAt: 1
}

void test('invocation proposals are durable, hash-only, and exactly idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-invocations-'))
  try {
    const first = proposeGeneratedToolInvocation(home, proposal)
    assert.equal(proposeGeneratedToolInvocation(home, proposal).id, first.id)
    assert.equal(proposeGeneratedToolInvocation(home, {
      ...proposal,
      id: 'replacement-id',
      proposedAt: 99
    }).id, first.id)
    assert.equal('request' in first, false)
    assert.equal(readGeneratedToolInvocations(home).invocations[0].requestHash.length, 64)
    assert.throws(() => proposeGeneratedToolInvocation(home, { ...proposal, sessionId: 'session-2' }), ToolForgeCasError)
    assert.throws(() => proposeGeneratedToolInvocation(home, { ...proposal, fingerprint: 'b'.repeat(64) }), ToolForgeCasError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.throws(() => proposeGeneratedToolInvocation(home, { ...proposal, id: 'invocation-2', idempotencyKey: 'idem-2', request: cyclic }))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('denied invocation finishes cancelled without starting and illegal jumps are rejected', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-invocations-'))
  try {
    const first = proposeGeneratedToolInvocation(home, proposal)
    assert.throws(() => updateGeneratedToolInvocation(home, first.id, 0, (current) => ({ ...current, revision: 1, status: 'started', startedAt: 2 })), /Invalid invocation lifecycle/)
    const denied = updateGeneratedToolInvocation(home, first.id, 0, (current) => ({ ...current, revision: 1, status: 'policy', policyAt: 2, policyDecision: 'deny' }))
    const finished = updateGeneratedToolInvocation(home, first.id, 1, (current) => ({ ...current, revision: 2, status: 'finished', finishedAt: 3, outcome: 'cancelled' }))
    assert.equal(denied.policyDecision, 'deny')
    assert.equal(finished.startedAt, undefined)
    assert.equal(finished.outcome, 'cancelled')
    assert.throws(() => updateGeneratedToolInvocation(home, first.id, 2, (current) => ({ ...current, revision: 3, status: 'started', startedAt: 4 })), /Invalid invocation lifecycle/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

void test('invocation lifecycle uses CAS and preserves immutable bindings', () => {
  const home = mkdtempSync(join(tmpdir(), 'joker-invocations-'))
  try {
    const first = proposeGeneratedToolInvocation(home, proposal)
    const policy = updateGeneratedToolInvocation(home, first.id, 0, (current) => ({ ...current, revision: 1, status: 'policy', policyAt: 2, policyDecision: 'allow' }))
    const started = updateGeneratedToolInvocation(home, first.id, 1, (current) => ({ ...current, revision: 2, status: 'started', startedAt: 3 }))
    const finished = updateGeneratedToolInvocation(home, first.id, 2, (current) => ({ ...current, revision: 3, status: 'finished', finishedAt: 4, outcome: 'succeeded', outputHash: 'b'.repeat(64) }))
    assert.equal(policy.policyDecision, 'allow')
    assert.equal(started.startedAt, 3)
    assert.equal(finished.outcome, 'succeeded')
    assert.throws(() => updateGeneratedToolInvocation(home, first.id, 2, (current) => ({ ...current, revision: 3 })), ToolForgeCasError)
    assert.throws(() => updateGeneratedToolInvocation(home, first.id, 3, (current) => ({ ...current, revision: 4, sessionId: 'other' })))
  } finally { rmSync(home, { recursive: true, force: true }) }
})
