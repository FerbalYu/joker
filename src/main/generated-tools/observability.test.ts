import test from 'node:test'
import assert from 'node:assert/strict'
import { GeneratedToolsEventBus } from './event-bus'
import { assertForgeJobTransition, canTransitionForgeJob } from './forge-state-machine'
import { MemoryTraceSink, startTraceSpan } from './trace'

void test('Generated Tools event bus supports typed unsubscribe and isolates listener errors', () => {
  const bus = new GeneratedToolsEventBus()
  const seen: string[] = []
  const dispose = bus.on('forge.job.queued', (event) => seen.push(event.jobId))
  bus.on('forge.job.queued', () => { throw new Error('listener failure') })
  bus.emit('forge.job.queued', { jobId: 'job-1', toolId: 'tool-1', status: 'queued' })
  assert.deepEqual(seen, ['job-1'])
  dispose()
  bus.emit('forge.job.queued', { jobId: 'job-2', toolId: 'tool-1', status: 'queued' })
  assert.deepEqual(seen, ['job-1'])
})

void test('Forge state machine rejects terminal regressions', () => {
  assert.equal(canTransitionForgeJob('queued', 'planning'), true)
  assert.equal(canTransitionForgeJob('completed', 'building'), false)
  assert.throws(() => assertForgeJobTransition('completed', 'building'), /Invalid ForgeJob transition/)
})

void test('Trace span records bounded structured completion data', () => {
  const sink = new MemoryTraceSink()
  const span = startTraceSpan(sink, 'forge.job', { jobId: 'job-1' })
  span.end('ok')
  assert.equal(sink.spans.length, 1)
  assert.equal(sink.spans[0]?.name, 'forge.job')
  assert.equal(sink.spans[0]?.status, 'ok')
  assert.ok(sink.spans[0]?.endedAt)
})
