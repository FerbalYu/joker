import test from 'node:test'
import assert from 'node:assert/strict'
import { EndpointGenerationRegistry, RunRegistry, type RunActivityEvent } from './run-registry'

void test('endpoint generations fence reload replacements and stale retirement', () => {
  const endpoints = new EndpointGenerationRegistry<{ name: string }>()
  const first = endpoints.activate(4, { name: 'first' })
  const second = endpoints.activate(4, { name: 'second' })
  assert.equal(first.generation, 1)
  assert.equal(second.generation, 2)
  assert.equal(endpoints.isCurrent(first), false)
  assert.equal(endpoints.isCurrent(second), true)
  assert.equal(endpoints.retire(4, first.generation), undefined)
  assert.equal(endpoints.current(4)?.value.name, 'second')
  assert.equal(endpoints.retire(4, second.generation)?.value.name, 'second')
  assert.equal(endpoints.current(4), undefined)
  assert.equal(endpoints.activate(4, { name: 'third' }).generation, 3)
})

void test('different sessions share a window while one session remains single-owner', () => {
  const registry = new RunRegistry<{ marker: string }>()
  assert.ok(registry.register({ windowId: 7, sessionId: 'session-a', runId: 'run-a', kind: 'chat', startedAt: 10 }, { marker: 'a' }))
  assert.ok(registry.register({ windowId: 7, sessionId: 'session-b', runId: 'run-b', kind: 'goal', startedAt: 20 }, { marker: 'b' }))
  assert.equal(registry.register({ windowId: 8, sessionId: 'session-a', runId: 'run-c', kind: 'chat' }, { marker: 'c' }), null)
  assert.deepEqual(registry.list(7).map(({ sessionId, runId, kind }) => ({ sessionId, runId, kind })), [
    { sessionId: 'session-a', runId: 'run-a', kind: 'chat' },
    { sessionId: 'session-b', runId: 'run-b', kind: 'goal' }
  ])
  assert.equal(registry.isSessionRunning('session-a'), true)
  assert.equal(registry.isSessionRunning('session-b'), true)
})

void test('exact run release cannot disturb a replacement owner or leak indexes', () => {
  const registry = new RunRegistry<object>()
  assert.ok(registry.register({ windowId: 1, sessionId: 'session-a', runId: 'run-old', kind: 'chat' }, {}))
  assert.equal(registry.release('wrong-run', 'aborted'), undefined)
  assert.equal(registry.isSessionRunning('session-a'), true)
  assert.ok(registry.release('run-old', 'aborted'))
  assert.equal(registry.isSessionRunning('session-a'), false)
  assert.ok(registry.register({ windowId: 2, sessionId: 'session-a', runId: 'run-new', kind: 'chat' }, {}))
  assert.equal(registry.release('run-old', 'completed'), undefined)
  assert.equal(registry.getForSession('session-a')?.runId, 'run-new')
  assert.deepEqual(registry.list(1), [])
  assert.equal(registry.list(2).length, 1)
})

void test('activity subscribers receive start, phase, and terminal snapshots', () => {
  const registry = new RunRegistry<object>()
  const events: RunActivityEvent[] = []
  const unsubscribe = registry.subscribe((event) => events.push(event))
  registry.register({ windowId: 3, sessionId: 'session-a', runId: 'run-a', kind: 'goal', startedAt: 123 }, {})
  assert.equal(registry.updatePhase('run-a', 'goal-execution'), true)
  assert.equal(registry.updatePhase('run-a', 'goal-execution'), false)
  registry.release('run-a', 'completed')
  unsubscribe()
  assert.deepEqual(events, [
    { type: 'start', run: { windowId: 3, sessionId: 'session-a', runId: 'run-a', kind: 'goal', phase: 'starting', startedAt: 123 } },
    { type: 'phase', run: { windowId: 3, sessionId: 'session-a', runId: 'run-a', kind: 'goal', phase: 'goal-execution', startedAt: 123 } },
    { type: 'terminal', run: { windowId: 3, sessionId: 'session-a', runId: 'run-a', kind: 'goal', phase: 'goal-execution', startedAt: 123 }, reason: 'completed' }
  ])
})
