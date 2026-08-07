import test from 'node:test'
import assert from 'node:assert/strict'
import type { StreamEventEnvelope } from '../shared/types'
import { StreamBridge, type StreamPortLike } from './stream-bridge'

class FakePort implements StreamPortLike {
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly posted: unknown[] = []
  started = 0
  closed = 0

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  start(): void {
    this.started += 1
  }

  close(): void {
    this.closed += 1
  }

  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

void test('caches a stream port that arrives before renderer subscription', () => {
  const bridge = new StreamBridge(12)
  const port = new FakePort()
  bridge.acceptPort(port)

  let received: StreamPortLike | null = null
  bridge.onPort((value) => { received = value })

  assert.equal(received, port)
  assert.equal(port.started, 1)
  assert.deepEqual(port.posted[0], { type: 'stream:ready', credit: 12 })
})

void test('supports remounting port and event subscribers without losing the cached port', () => {
  const bridge = new StreamBridge(8)
  const port = new FakePort()
  bridge.acceptPort(port)
  const ports: StreamPortLike[] = []
  const removeFirst = bridge.onPort((value) => ports.push(value))
  removeFirst()
  bridge.onPort((value) => ports.push(value))

  const events: string[] = []
  const removeEvent = bridge.onEvent((event) => events.push(`old:${event.type}`))
  removeEvent()
  bridge.onEvent((event) => events.push(`new:${event.type}:${event.runId}`))
  const envelope: StreamEventEnvelope = {
    type: 'stream:event',
    seq: 3,
    runId: 'run-cached',
    event: { type: 'done', sessionId: 'session-a' }
  }
  port.receive(envelope)

  assert.deepEqual(ports, [port, port])
  assert.deepEqual(events, ['new:done:run-cached'])
  assert.deepEqual(port.posted.at(-1), { type: 'stream:ack', seq: 3, runId: 'run-cached' })
})

void test('replacement closes and unbinds the old port while ACKing the source port', () => {
  const bridge = new StreamBridge(4)
  const oldPort = new FakePort()
  const replacement = new FakePort()
  const events: string[] = []
  bridge.onEvent((event) => events.push(`${event.type}:${event.runId}`))
  bridge.acceptPort(oldPort)
  const oldHandler = oldPort.onmessage
  bridge.acceptPort(replacement)

  assert.equal(oldPort.closed, 1)
  assert.equal(oldPort.onmessage, null)
  assert.equal(replacement.started, 1)
  const staleEnvelope: StreamEventEnvelope = {
    type: 'stream:event', seq: 9, runId: 'run-old', event: { type: 'done', sessionId: 'session-old' }
  }
  oldHandler?.({ data: staleEnvelope } as MessageEvent)
  assert.deepEqual(events, [])
  assert.deepEqual(oldPort.posted.at(-1), { type: 'stream:ack', seq: 9, runId: 'run-old' })
  assert.equal(replacement.posted.some((message) => (message as { type?: string }).type === 'stream:ack'), false)
})

void test('forwards queue and steer commands through the active port', () => {
  const bridge = new StreamBridge(4)
  const port = new FakePort()
  bridge.acceptPort(port)
  const message = { id: 'pending-a', role: 'user', content: 'next', createdAt: 1 }

  assert.equal(bridge.send({ type: 'chat:enqueue', sessionId: 'session-a', mode: 'queue', message }), true)
  assert.equal(bridge.send({ type: 'chat:enqueue', sessionId: 'session-a', mode: 'steer', expectedRunId: 'run-a', message }), true)
  assert.equal(bridge.send({ type: 'chat:steer-pending', sessionId: 'session-a', expectedRunId: 'run-a', pendingMessageId: 'pending-a' }), true)
  assert.equal(bridge.send({ type: 'chat:cancel-pending', sessionId: 'session-a', pendingMessageId: 'pending-a' }), true)
  assert.deepEqual(port.posted.slice(-4), [
    { type: 'chat:enqueue', sessionId: 'session-a', mode: 'queue', message },
    { type: 'chat:enqueue', sessionId: 'session-a', mode: 'steer', expectedRunId: 'run-a', message },
    { type: 'chat:steer-pending', sessionId: 'session-a', expectedRunId: 'run-a', pendingMessageId: 'pending-a' },
    { type: 'chat:cancel-pending', sessionId: 'session-a', pendingMessageId: 'pending-a' }
  ])
})

void test('reports send failure before a port is available', () => {
  const bridge = new StreamBridge(4)
  assert.equal(bridge.send({ type: 'chat:send' }), false)
  const port = new FakePort()
  bridge.acceptPort(port)
  assert.equal(bridge.send({ type: 'chat:send' }), true)
})
