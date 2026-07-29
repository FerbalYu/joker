import test from 'node:test'
import assert from 'node:assert/strict'
import { StreamTransport } from './stream-transport'
import type { StreamEvent, StreamEventEnvelope, StreamFlowState } from '../shared/types'

function token(runId: string, index: number): StreamEvent {
  return { type: 'token', sessionId: 'transport-session', runId, text: `stream-token-${index};` }
}

function done(runId: string): StreamEvent {
  return { type: 'done', sessionId: 'transport-session', runId }
}

function createTransport(hwm = 4, reserve = 1): { transport: StreamTransport; sent: StreamEventEnvelope[]; flows: StreamFlowState[] } {
  const sent: StreamEventEnvelope[] = []
  const flows: StreamFlowState[] = []
  const transport = new StreamTransport({
    highWaterMark: hwm,
    terminalReserve: reserve,
    postMessage: (message) => {
      if (message.type === 'stream:event') sent.push(message)
    },
    onFlow: (flow) => flows.push(flow)
  })
  transport.ready(hwm)
  return { transport, sent, flows }
}

void test('ACK window bounds in-flight events and resumes blocked sends in FIFO order', async () => {
  const { transport, sent, flows } = createTransport(4, 1)
  const runId = 'run-flow'
  const sends = Array.from({ length: 6 }, (_, index) => transport.send(token(runId, index)))
  await Promise.resolve()
  assert.equal(sent.length, 3)
  assert.equal(transport.snapshot().inFlight, 3)
  assert.equal(transport.snapshot().blockedPending, 3)
  assert.ok(transport.snapshot().maxQueueDepth <= 4)
  assert.ok(transport.snapshot().blockedSends >= 3)

  for (const envelope of sent.slice()) assert.equal(transport.ack(envelope.seq, runId), true)
  await Promise.all(sends)
  assert.deepEqual(sent.map((item) => item.event.type === 'token' ? item.event.text : ''), Array.from({ length: 6 }, (_, index) => `stream-token-${index};`))
  assert.equal(transport.snapshot().sentCount, 6)
  assert.equal(transport.snapshot().ackCount, 3)
  assert.ok(flows.some((flow) => flow.event === 'resumed'))

  for (const envelope of sent.slice(3)) assert.equal(transport.ack(envelope.seq, runId), true)
  assert.equal(transport.snapshot().queueDepth, 0)
  assert.equal(transport.snapshot().drainCount, 1)
  assert.ok(flows.some((flow) => flow.event === 'drain'))
})

void test('duplicate and wrong-run ACKs do not release credit', async () => {
  const { transport, sent } = createTransport(3, 1)
  const runId = 'run-ack'
  const pending = transport.send(token(runId, 0))
  await pending
  const envelope = sent[0]
  assert.equal(transport.ack(envelope.seq, 'wrong-run'), false)
  assert.equal(transport.snapshot().inFlight, 1)
  assert.equal(transport.ack(envelope.seq, runId), true)
  assert.equal(transport.ack(envelope.seq, runId), false)
})

void test('terminal reserve allows done after abort while normal sends are blocked', async () => {
  const { transport, sent } = createTransport(4, 1)
  const runId = 'run-terminal'
  const normal = Array.from({ length: 4 }, (_, index) => transport.send(token(runId, index)))
  await Promise.resolve()
  assert.equal(sent.length, 3)
  const terminal = transport.send(done(runId))
  await terminal
  assert.equal(sent.at(-1)?.event.type, 'done')
  assert.equal(sent.filter((item) => item.event.type === 'done').length, 1)
  transport.cancelRun(runId)
  for (const envelope of sent) transport.ack(envelope.seq, runId)
  await Promise.allSettled(normal)
})

void test('aborted pending sends reject and close unblocks all waiters', async () => {
  const { transport } = createTransport(2, 1)
  const controller = new AbortController()
  const first = transport.send(token('run-abort', 0))
  await first
  const blocked = transport.send(token('run-abort', 1), controller.signal)
  controller.abort(new Error('cancelled'))
  await assert.rejects(blocked, /cancelled/)
  const waiting = transport.send(token('run-close', 0))
  transport.close('window closed')
  await assert.rejects(waiting, /closed/)
  assert.equal(transport.snapshot().closed, true)
})
