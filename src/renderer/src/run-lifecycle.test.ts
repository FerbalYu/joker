import test from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptsRunEvent,
  activeRunForSession,
  adoptQueuedRunOnEvent,
  clearActiveRun,
  completeRunOnEvent,
  requestRunAbort,
  setActiveRun
} from './run-lifecycle'

void test('abort requests only mark the target session run until terminal done', () => {
  const runs = setActiveRun(
    setActiveRun({}, { runId: 'run-a', sessionId: 'session-a' }),
    { runId: 'run-b', sessionId: 'session-b' }
  )
  const requested = requestRunAbort(runs, 'session-a')
  assert.deepEqual(activeRunForSession(requested, 'session-a'), { runId: 'run-a', sessionId: 'session-a', abortRequested: true })
  assert.deepEqual(activeRunForSession(requested, 'session-b'), { runId: 'run-b', sessionId: 'session-b' })
  assert.equal(acceptsRunEvent(requested, { type: 'abort', runId: 'run-a', sessionId: 'session-a' }), true)
  assert.equal(activeRunForSession(completeRunOnEvent(requested, { type: 'done', runId: 'run-a', sessionId: 'session-a' }), 'session-a'), null)
})

void test('run event filtering is isolated by session and run identity', () => {
  const runs = {
    'session-a': { runId: 'run-a', sessionId: 'session-a' },
    'session-b': { runId: 'run-b', sessionId: 'session-b' }
  }
  assert.equal(acceptsRunEvent(runs, { type: 'token', runId: 'run-a', sessionId: 'session-a' }), true)
  assert.equal(acceptsRunEvent(runs, { type: 'token', runId: 'run-a', sessionId: 'session-b' }), false)
  assert.equal(acceptsRunEvent(runs, { type: 'done', runId: 'run-old', sessionId: 'session-a' }), false)
  assert.equal(acceptsRunEvent({}, { type: 'done', runId: 'run-old', sessionId: 'session-a' }), true)
})

void test('queued run adoption and completion only mutate the event session', () => {
  const existing = setActiveRun({}, { runId: 'run-b', sessionId: 'session-b' })
  const adopted = adoptQueuedRunOnEvent(existing, {
    type: 'message-applied',
    runId: 'run-a',
    sessionId: 'session-a',
    disposition: 'queue'
  })
  assert.deepEqual(activeRunForSession(adopted, 'session-a'), { runId: 'run-a', sessionId: 'session-a' })
  assert.deepEqual(activeRunForSession(adopted, 'session-b'), { runId: 'run-b', sessionId: 'session-b' })
  assert.deepEqual(clearActiveRun(adopted, 'session-a', 'run-old'), adopted)
  const completed = completeRunOnEvent(adopted, { type: 'done', runId: 'run-a', sessionId: 'session-a' })
  assert.equal(activeRunForSession(completed, 'session-a'), null)
  assert.deepEqual(activeRunForSession(completed, 'session-b'), { runId: 'run-b', sessionId: 'session-b' })
  assert.deepEqual(adoptQueuedRunOnEvent(existing, {
    type: 'message-applied',
    runId: 'run-steer',
    sessionId: 'session-a',
    disposition: 'steer'
  }), existing)
})
