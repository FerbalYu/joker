import test from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModel } from 'ai'
import type { StreamEvent } from '../../shared/types'
import { runAgent } from './loop'

type FakeMode = 'normal' | 'error' | 'abort'

function fakeModel(mode: FakeMode, chunks = ['first ', 'second ', 'third']): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'test',
    modelId: 'stream-contract',
    defaultObjectGenerationMode: 'json',
    doGenerate: async () => ({
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      rawCall: { rawPrompt: null, rawSettings: {} },
      text: 'done'
    }),
    doStream: async ({ abortSignal }) => {
      if (mode === 'error') throw new Error('fake provider failure')
      return {
        stream: new ReadableStream({
          start(controller) {
            if (mode === 'abort') {
              const abort = (): void => {
                controller.error(abortSignal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
              }
              if (abortSignal?.aborted) {
                abort()
                return
              }
              abortSignal?.addEventListener('abort', abort, { once: true })
              return
            }
            controller.enqueue({ type: 'text-start', id: 'text-1' })
            for (const text of chunks) controller.enqueue({ type: 'text-delta', id: 'text-1', delta: text })
            controller.enqueue({ type: 'text-end', id: 'text-1' })
            controller.close()
          }
        }),
        rawCall: { rawPrompt: null, rawSettings: {} }
      }
    }
  } as unknown as LanguageModel
}

function runWith(model: LanguageModel, signal?: AbortSignal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  return runAgent({
    sessionId: 'session-loop-contract',
    runId: 'run-loop-contract',
    messages: [{ role: 'user', content: 'stream contract' }],
    reasoningLevel: 'auto',
    model,
    signal,
    onEvent: (event) => { events.push(event) }
  }).then(() => events)
}

void test('runAgent preserves long stream order and emits exactly one normal terminal sequence', async () => {
  const events = await runWith(fakeModel('normal', Array.from({ length: 256 }, (_, index) => `chunk-${index};`)))
  assert.equal(events[0]?.type, 'message-start')
  assert.equal(events.filter((event) => event.type === 'token').length, 256)
  assert.equal(events.filter((event) => event.type === 'message-end').length, 1)
  assert.equal(events.filter((event) => event.type === 'context-usage').length, 1)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
  assert.deepEqual(events.filter((event) => event.type === 'token').map((event) => event.type === 'token' ? event.text : ''), Array.from({ length: 256 }, (_, index) => `chunk-${index};`))
})

void test('runAgent emits one error and one done when the provider fails', async () => {
  const events = await runWith(fakeModel('error'))
  assert.equal(events.filter((event) => event.type === 'error').length, 1)
  assert.equal(events.filter((event) => event.type === 'abort').length, 0)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
})

void test('runAgent emits abort and done without normal completion events', async () => {
  const controller = new AbortController()
  const pending = runWith(fakeModel('abort'), controller.signal)
  setTimeout(() => controller.abort(new Error('cancelled by contract')), 20)
  const events = await pending
  assert.equal(events.filter((event) => event.type === 'abort').length, 1)
  assert.equal(events.filter((event) => event.type === 'error').length, 0)
  assert.equal(events.filter((event) => event.type === 'message-end').length, 0)
  assert.equal(events.filter((event) => event.type === 'context-usage').length, 0)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
})
