import test from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalRegistry } from './approval'

void test('approval registry scopes resolution by window, session, and run', async () => {
  const registry = new ApprovalRegistry()
  const results: boolean[] = []
  registry.add({ windowId: 1, sessionId: 's1', runId: 'r1' }, 'request-1', (value) => results.push(value))
  assert.equal(registry.resolve('request-1', { windowId: 2, sessionId: 's1', runId: 'r1' }, true), false)
  assert.equal(registry.resolve('request-1', { windowId: 1, sessionId: 's2', runId: 'r1' }, true), false)
  assert.equal(registry.resolve('request-1', { windowId: 1, sessionId: 's1', runId: 'r2' }, true), false)
  assert.equal(registry.resolve('request-1', { windowId: 1, sessionId: 's1', runId: 'r1' }, true), true)
  assert.deepEqual(results, [true])
})

void test('approval registry cancellation resolves pending approvals as denied', async () => {
  const registry = new ApprovalRegistry()
  const results: boolean[] = []
  registry.add({ windowId: 1, sessionId: 's1', runId: 'r1' }, 'request-1', (value) => results.push(value))
  registry.cancelRun({ windowId: 1, sessionId: 's1', runId: 'r1' })
  assert.deepEqual(results, [false])
  assert.equal(registry.size, 0)
})
