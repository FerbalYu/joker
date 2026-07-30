import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { tool, type LanguageModel, type ModelMessage } from 'ai'
import type { StreamEvent } from '../../shared/types'
import { runAgent } from './loop'

function usage(inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: {
      noCacheTokens: Math.max(0, inputTokens - cacheReadTokens),
      cacheReadTokens,
      cacheWriteTokens
    },
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: 0
    }
  }
}

function v3Usage(inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: Math.max(0, inputTokens - cacheReadTokens),
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens
    },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 }
  }
}

type FakeMode = 'normal' | 'error' | 'abort' | 'empty'

function fakeModel(mode: FakeMode, chunks = ['first ', 'second ', 'third']): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'test',
    modelId: 'stream-contract',
    defaultObjectGenerationMode: 'json',
    doGenerate: async () => ({
      finishReason: 'stop',
      usage: usage(1, 1),
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
            controller.enqueue({ type: 'response-metadata', id: 'response-1', modelId: 'stream-contract', timestamp: new Date(0) })
            if (mode !== 'empty') {
              controller.enqueue({ type: 'text-start', id: 'text-1' })
              for (const text of chunks) controller.enqueue({ type: 'text-delta', id: 'text-1', delta: text })
              controller.enqueue({ type: 'text-end', id: 'text-1' })
            }
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: usage(1, mode === 'empty' ? 0 : 1) })
            controller.close()
          }
        }),
        rawCall: { rawPrompt: null, rawSettings: {} }
      }
    }
  } as unknown as LanguageModel
}

function multiStepModel(requests: ModelMessage[][]): LanguageModel {
  let call = 0
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'multi-step',
    supportedUrls: {},
    doGenerate: async () => ({
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: v3Usage(1, 1),
      response: { id: 'generate', modelId: 'multi-step', timestamp: new Date(0) },
      content: [{ type: 'text', text: 'done' }],
      warnings: []
    }),
    doStream: async ({ prompt }) => {
      requests.push(prompt as ModelMessage[])
      const step = call++
      const stepUsage = step === 0 ? v3Usage(100, 10, 20, 5) : v3Usage(250, 20, 125, 0)
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'response-metadata', id: `response-${step}`, modelId: 'multi-step', timestamp: new Date(0) })
            if (step === 0) {
              controller.enqueue({ type: 'tool-input-start', id: 'call-read', toolName: 'Read' })
              controller.enqueue({ type: 'tool-input-delta', id: 'call-read', delta: '{}' })
              controller.enqueue({ type: 'tool-input-end', id: 'call-read' })
              controller.enqueue({ type: 'tool-call', toolCallId: 'call-read', toolName: 'Read', input: '{}' })
              controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: stepUsage })
            } else {
              controller.enqueue({ type: 'text-start', id: 'text-final' })
              controller.enqueue({ type: 'text-delta', id: 'text-final', delta: 'finished' })
              controller.enqueue({ type: 'text-end', id: 'text-final' })
              controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: stepUsage })
            }
            controller.close()
          }
        }),
        response: { headers: {} }
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

void test('runAgent preserves long stream order and emits measured context updates', async () => {
  const events = await runWith(fakeModel('normal', Array.from({ length: 256 }, (_, index) => `chunk-${index};`)))
  assert.equal(events[0]?.type, 'message-start')
  assert.equal(events.filter((event) => event.type === 'token').length, 256)
  assert.equal(events.filter((event) => event.type === 'message-end').length, 1)
  const contextEvents = events.filter((event) => event.type === 'context-usage')
  assert.equal(contextEvents.length, 3)
  assert.deepEqual(contextEvents.map((event) => event.type === 'context-usage' ? event.usage.source : null), ['estimate', 'provider', 'provider'])
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
  const contextEvents = events.filter((event) => event.type === 'context-usage')
  assert.equal(contextEvents.length, 1)
  assert.equal(contextEvents[0]?.type === 'context-usage' ? contextEvents[0].usage.source : null, 'estimate')
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
})

void test('runAgent converts an empty provider completion into a visible error and done', async () => {
  const events = await runWith(fakeModel('empty'))
  assert.equal(events.filter((event) => event.type === 'message-end').length, 0)
  const error = events.find((event) => event.type === 'error')
  assert.ok(error?.type === 'error')
  assert.match(error.error, /empty response/i)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
})

void test('runAgent emits error and done when startup fails before message-start', async () => {
  const events: StreamEvent[] = []
  await runAgent({
    sessionId: 'session-startup-error',
    runId: 'run-startup-error',
    messages: [{ role: 'user', content: 'startup' }],
    reasoningLevel: 'auto',
    model: fakeModel('normal'),
    onEvent: (event) => {
      if (event.type === 'message-start') throw new Error('transport failed before stream')
      events.push(event)
    }
  })
  const error = events.find((event) => event.type === 'error')
  assert.ok(error?.type === 'error')
  assert.match(error.error, /transport failed before stream/)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
})

void test('runAgent includes runMode in message-start', async () => {
  const events: StreamEvent[] = []
  await runAgent({
    sessionId: 'session-research-mode',
    runId: 'run-research-mode',
    messages: [{ role: 'user', content: 'research' }],
    reasoningLevel: 'auto',
    runMode: 'research',
    model: fakeModel('normal', ['done']),
    onEvent: (event) => { events.push(event) }
  })
  const start = events.find((event) => event.type === 'message-start')
  assert.ok(start?.type === 'message-start')
  assert.equal(start.runMode, 'research')
})

void test('prepareStep compresses a giant tool result before the next model call', async () => {
  const requests: ModelMessage[][] = []
  const events: StreamEvent[] = []
  const originalOutput = 'large-tool-result-' + 'x'.repeat(1_000_000)
  const readTool = tool({
    description: 'Return a giant deterministic result',
    inputSchema: z.object({}),
    execute: async () => ({ output: originalOutput })
  })

  await runAgent({
    sessionId: 'session-compression-step',
    runId: 'run-compression-step',
    messages: [{ role: 'user', content: 'read the giant result' }],
    reasoningLevel: 'auto',
    model: multiStepModel(requests),
    tools: { Read: readTool },
    onEvent: (event) => { events.push(event) }
  })

  assert.equal(requests.length, 2)
  const sentToolMessage = requests[1].find((message) => message.role === 'tool')
  assert.ok(sentToolMessage?.role === 'tool')
  const sentToolResult = sentToolMessage.content.find((part) => part.type === 'tool-result')
  assert.ok(sentToolResult?.type === 'tool-result')
  const projectedValue = sentToolResult.output.type === 'text'
    ? sentToolResult.output.value
    : JSON.stringify(sentToolResult.output)
  assert.match(projectedValue, /truncated for context/)
  assert.ok(projectedValue.length < originalOutput.length)

  const originalEvent = events.find((event) => event.type === 'tool-result')
  assert.ok(originalEvent?.type === 'tool-result')
  assert.equal(originalEvent.output, originalOutput)
  const compressedContext = events.filter((event) => event.type === 'context-usage').find((event) => event.type === 'context-usage' && (event.usage.compressionCount ?? 0) > 0)
  assert.ok(compressedContext?.type === 'context-usage')
  assert.ok((compressedContext.usage.compressionBeforeTokens ?? 0) > (compressedContext.usage.compressionAfterTokens ?? 0))
})

void test('multi-step usage is cumulative while current context uses the final step', async () => {
  const requests: ModelMessage[][] = []
  const events: StreamEvent[] = []
  const readTool = tool({
    description: 'Return a deterministic large result',
    inputSchema: z.object({}),
    execute: async () => ({
      output: 'tool-result-' + 'x'.repeat(2_000),
      metadata: {
        usage: {
          inputTokens: 40,
          outputTokens: 8,
          totalTokens: 48,
          noCacheTokens: 40,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          stepCount: 1
        }
      }
    })
  })

  await runAgent({
    sessionId: 'session-multi-step',
    runId: 'run-multi-step',
    messages: [{ role: 'user', content: 'read then answer' }],
    reasoningLevel: 'auto',
    model: multiStepModel(requests),
    tools: { Read: readTool },
    onEvent: (event) => { events.push(event) }
  })

  assert.equal(requests.length, 2)
  assert.ok(requests[1].some((message) => message.role === 'tool'))
  const messageEnd = events.find((event) => event.type === 'message-end')
  assert.ok(messageEnd?.type === 'message-end')
  assert.deepEqual(messageEnd.usage, {
    inputTokens: 390,
    outputTokens: 38,
    totalTokens: 428,
    noCacheTokens: 245,
    cacheReadTokens: 145,
    cacheWriteTokens: 5,
    stepCount: 3
  })

  const contextEvents = events.filter((event) => event.type === 'context-usage')
  assert.equal(contextEvents.length, 5)
  assert.deepEqual(contextEvents.map((event) => event.type === 'context-usage' ? event.usage.stepNumber : 0), [1, 1, 2, 2, 2])
  const finalContext = contextEvents.at(-1)
  assert.ok(finalContext?.type === 'context-usage')
  assert.equal(finalContext.usage.inputTokens, 250)
  assert.equal(finalContext.usage.cacheHitRate, 50)
  assert.equal(finalContext.usage.source, 'provider')
})
