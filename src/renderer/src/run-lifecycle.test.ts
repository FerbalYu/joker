import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptsRunEvent, completeRunOnEvent, requestRunAbort } from './run-lifecycle'

void test('abort requests keep the active run until terminal done', () => {
  const requested = requestRunAbort({ runId: 'run-a', sessionId: 'session-a' })
  assert.deepEqual(requested, { runId: 'run-a', sessionId: 'session-a', abortRequested: true })
  assert.equal(acceptsRunEvent(requested, { type: 'abort', runId: 'run-a' }), true)
  assert.deepEqual(completeRunOnEvent(requested, { type: 'abort', runId: 'run-a' }), requested)
  assert.equal(completeRunOnEvent(requested, { type: 'done', runId: 'run-a' }), null)
})

void test('run event filtering rejects stale runs but permits unowned done cleanup', () => {
  const active = { runId: 'run-new', sessionId: 'session-a' }
  assert.equal(acceptsRunEvent(active, { type: 'token', runId: 'run-old' }), false)
  assert.equal(acceptsRunEvent(null, { type: 'abort', runId: 'run-old' }), false)
  assert.equal(acceptsRunEvent(null, { type: 'done', runId: 'run-old' }), true)
})
