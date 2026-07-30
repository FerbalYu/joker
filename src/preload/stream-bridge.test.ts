import test from 'node:test'
import assert from 'node:assert/strict'
import type { StreamEventEnvelope } from '../shared/types'
import { StreamBridge, type StreamPortLike } from './stream-bridge'

class FakePort implements StreamPortLike {
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly posted: unknown[] = []
  started = 0

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  start(): void {
    this.started += 1
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

void test('reports send failure before a port is available', () => {
  const bridge = new StreamBridge(4)
  assert.equal(bridge.send({ type: 'chat:send' }), false)
  const port = new FakePort()
  bridge.acceptPort(port)
  assert.equal(bridge.send({ type: 'chat:send' }), true)
})
