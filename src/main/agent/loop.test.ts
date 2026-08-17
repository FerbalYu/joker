import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { tool, type LanguageModel, type ModelMessage } from 'ai'
import type { ChatMessage, StreamEvent } from '../../shared/types'
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

interface ExecutionCallSnapshot {
  toolChoice: unknown
  toolNames: string[]
  prompt: unknown
}

function textOnlyExecutionModel(calls: ExecutionCallSnapshot[]): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'text-only-execution',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('not used') },
    doStream: async ({ toolChoice, tools, prompt }) => {
      calls.push({
        toolChoice,
        toolNames: (tools ?? []).map((tool) => tool.name),
        prompt
      })
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'response-metadata', id: 'response-text-only', modelId: 'text-only-execution', timestamp: new Date(0) })
            controller.enqueue({ type: 'text-start', id: 'text-only' })
            controller.enqueue({ type: 'text-delta', id: 'text-only', delta: 'Everything is complete.' })
            controller.enqueue({ type: 'text-end', id: 'text-only' })
            controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: v3Usage(10, 3) })
            controller.close()
          }
        }),
        response: { headers: {} }
      }
    }
  } as unknown as LanguageModel
}

function exactGeneratedToolModel(toolName: string, input: unknown = {}): LanguageModel {
  let call = 0
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'exact-generated-tool',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('not used') },
    doStream: async () => {
      const step = call++
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'response-metadata', id: `response-${step}`, modelId: 'exact-generated-tool', timestamp: new Date(0) })
            if (step === 0) {
              controller.enqueue({ type: 'tool-input-start', id: 'call-generated', toolName })
              controller.enqueue({ type: 'tool-input-delta', id: 'call-generated', delta: JSON.stringify(input) })
              controller.enqueue({ type: 'tool-input-end', id: 'call-generated' })
              controller.enqueue({ type: 'tool-call', toolCallId: 'call-generated', toolName, input: JSON.stringify(input) })
              controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: v3Usage(10, 2) })
            } else {
              controller.enqueue({ type: 'text-start', id: 'text-final' })
              controller.enqueue({ type: 'text-delta', id: 'text-final', delta: 'continued' })
              controller.enqueue({ type: 'text-end', id: 'text-final' })
              controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: v3Usage(10, 2) })
            }
            controller.close()
          }
        }),
        response: { headers: {} }
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

function thinkingToolChoiceModel(calls: ExecutionCallSnapshot[]): LanguageModel {
  let call = 0
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'thinking-tool-choice',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('not used') },
    doStream: async ({ toolChoice, tools, prompt }) => {
      const step = call++
      calls.push({ toolChoice, toolNames: (tools ?? []).map((tool) => tool.name), prompt })
      if (step === 0) {
        throw new Error('API 调用错误 (HTTP 400)：Thinking mode does not support this tool_choice')
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'response-metadata', id: `response-${step}`, modelId: 'thinking-tool-choice', timestamp: new Date(0) })
            if (step === 1) {
              controller.enqueue({ type: 'tool-input-start', id: 'call-read', toolName: 'Read' })
              controller.enqueue({ type: 'tool-input-delta', id: 'call-read', delta: '{}' })
              controller.enqueue({ type: 'tool-input-end', id: 'call-read' })
              controller.enqueue({ type: 'tool-call', toolCallId: 'call-read', toolName: 'Read', input: '{}' })
              controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: v3Usage(10, 2) })
            } else {
              controller.enqueue({ type: 'text-start', id: 'text-done' })
              controller.enqueue({ type: 'text-delta', id: 'text-done', delta: 'finished' })
              controller.enqueue({ type: 'text-end', id: 'text-done' })
              controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: v3Usage(20, 3) })
            }
            controller.close()
          }
        }),
        response: { headers: {} }
      }
    }
  } as unknown as LanguageModel
}

function failingThenTextModel(firstError: Error, calls: ExecutionCallSnapshot[]): LanguageModel {
  let call = 0
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'failing-then-text',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('not used') },
    doStream: async ({ toolChoice, tools, prompt }) => {
      const step = call++
      calls.push({ toolChoice, toolNames: (tools ?? []).map((tool) => tool.name), prompt })
      if (step === 0) throw firstError
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'response-metadata', id: `response-${step}`, modelId: 'failing-then-text', timestamp: new Date(0) })
            controller.enqueue({ type: 'text-start', id: 'text-1' })
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'recovered' })
            controller.enqueue({ type: 'text-end', id: 'text-1' })
            controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: v3Usage(5, 2) })
            controller.close()
          }
        }),
        response: { headers: {} }
      }
    }
  } as unknown as LanguageModel
}

function stepLimitModel(): LanguageModel {
  let call = 0
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'step-limit',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('not used') },
    doStream: async () => {
      const step = call++
      const toolCallId = `call-${step}`
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'response-metadata', id: `response-${step}`, modelId: 'step-limit', timestamp: new Date(0) })
            controller.enqueue({ type: 'tool-input-start', id: toolCallId, toolName: 'Again' })
            controller.enqueue({ type: 'tool-input-delta', id: toolCallId, delta: '{}' })
            controller.enqueue({ type: 'tool-input-end', id: toolCallId })
            controller.enqueue({ type: 'tool-call', toolCallId, toolName: 'Again', input: '{}' })
            controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: v3Usage(2, 1) })
            controller.close()
          }
        }),
        response: { headers: {} }
      }
    }
  } as unknown as LanguageModel
}

function repeatedToolReminderModel(prompts: unknown[]): LanguageModel {
  let call = 0
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'repeated-tool-reminder',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('not used') },
    doStream: async ({ prompt }) => {
      prompts.push(prompt)
      const step = call++
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'response-metadata', id: `repeat-${step}`, modelId: 'repeated-tool-reminder', timestamp: new Date(0) })
            if (step < 3) {
              const toolCallId = `repeat-call-${step}`
              const input = step % 2 === 0 ? { b: 2, nested: { y: null, x: 1 } } : { nested: { x: 1, y: null }, b: 2 }
              controller.enqueue({ type: 'tool-input-start', id: toolCallId, toolName: 'Again' })
              controller.enqueue({ type: 'tool-input-delta', id: toolCallId, delta: JSON.stringify(input) })
              controller.enqueue({ type: 'tool-input-end', id: toolCallId })
              controller.enqueue({ type: 'tool-call', toolCallId, toolName: 'Again', input: JSON.stringify(input) })
              controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: v3Usage(2, 1) })
            } else {
              controller.enqueue({ type: 'text-start', id: 'repeat-done' })
              controller.enqueue({ type: 'text-delta', id: 'repeat-done', delta: 'done' })
              controller.enqueue({ type: 'text-end', id: 'repeat-done' })
              controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: v3Usage(2, 1) })
            }
            controller.close()
          }
        }),
        response: { headers: {} }
      }
    }
  } as unknown as LanguageModel
}

function runWith(model: LanguageModel, signal?: AbortSignal): Promise<{ events: StreamEvent[]; result: Awaited<ReturnType<typeof runAgent>> }> {
  const events: StreamEvent[] = []
  return runAgent({
    sessionId: 'session-loop-contract',
    runId: 'run-loop-contract',
    messages: [{ role: 'user', content: 'stream contract' }],
    reasoningLevel: 'auto',
    model,
    signal,
    onEvent: (event) => { events.push(event) }
  }).then((result) => ({ events, result }))
}

void test('runAgent injects an advisory reminder after three canonical identical tool calls', async () => {
  const prompts: unknown[] = []
  const tools = {
    Again: tool({
      description: 'repeat fixture',
      inputSchema: z.object({ b: z.number(), nested: z.object({ x: z.number(), y: z.null() }) }),
      execute: async () => 'same-result'
    })
  }
  const result = await runAgent({
    sessionId: 'session-tool-repeat-reminder',
    runId: 'run-tool-repeat-reminder',
    messages: [{ role: 'user', content: 'repeat fixture' }],
    tools,
    reasoningLevel: 'auto',
    model: repeatedToolReminderModel(prompts),
    onEvent: () => undefined
  })
  assert.equal(result.status, 'completed')
  assert.equal(prompts.length, 4)
  assert.match(JSON.stringify(prompts[3]), /repeating the exact same tool call with identical arguments/i)
  assert.doesNotMatch(JSON.stringify(prompts[2]), /repeating the exact same tool call with identical arguments/i)
})

void test('runAgent preserves denied status from the AI SDK json output envelope', async () => {
  const events: StreamEvent[] = []
  const tools = {
    Denied: tool({
      description: 'denied fixture',
      inputSchema: z.object({}),
      execute: async () => ({ output: 'Tool call was denied.', metadata: { terminalStatus: 'denied' } })
    })
  }
  let step = 0
  const model = {
    specificationVersion: 'v3', provider: 'test', modelId: 'denied-envelope', supportedUrls: {},
    doGenerate: async () => { throw new Error('not used') },
    doStream: async () => ({
      stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'response-metadata', id: `denied-${step}`, modelId: 'denied-envelope', timestamp: new Date(0) })
        if (step++ === 0) {
          controller.enqueue({ type: 'tool-input-start', id: 'denied-call', toolName: 'Denied' })
          controller.enqueue({ type: 'tool-input-delta', id: 'denied-call', delta: '{}' })
          controller.enqueue({ type: 'tool-input-end', id: 'denied-call' })
          controller.enqueue({ type: 'tool-call', toolCallId: 'denied-call', toolName: 'Denied', input: '{}' })
          controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: v3Usage(2, 1) })
        } else {
          controller.enqueue({ type: 'text-start', id: 'denied-done' })
          controller.enqueue({ type: 'text-delta', id: 'denied-done', delta: 'denied handled' })
          controller.enqueue({ type: 'text-end', id: 'denied-done' })
          controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: v3Usage(2, 1) })
        }
        controller.close()
      } }), response: { headers: {} }
    })
  } as unknown as LanguageModel
  const result = await runAgent({ sessionId: 'denied-session', runId: 'denied-run', messages: [{ role: 'user', content: 'deny' }], tools, reasoningLevel: 'auto', model, onEvent: (event) => { events.push(event) } })
  assert.equal(result.status, 'completed')
  assert.equal(result.toolCalls[0]?.status, 'denied')
  assert.equal(events.find((event) => event.type === 'tool-result')?.type, 'tool-result')
})

void test('runAgent preserves long stream order and emits measured context updates', async () => {
  const { events, result } = await runWith(fakeModel('normal', Array.from({ length: 256 }, (_, index) => `chunk-${index};`)))
  assert.equal(events[0]?.type, 'message-start')
  assert.equal(events.filter((event) => event.type === 'token').length, 256)
  assert.equal(events.filter((event) => event.type === 'message-end').length, 1)
  const contextEvents = events.filter((event) => event.type === 'context-usage')
  assert.equal(contextEvents.length, 3)
  assert.deepEqual(contextEvents.map((event) => event.type === 'context-usage' ? event.usage.source : null), ['estimate', 'provider', 'provider'])
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
  assert.deepEqual(events.filter((event) => event.type === 'token').map((event) => event.type === 'token' ? event.text : ''), Array.from({ length: 256 }, (_, index) => `chunk-${index};`))
  assert.equal(result.status, 'completed')
  assert.equal(result.messageId, events[0]?.type === 'message-start' ? events[0].messageId : undefined)
  assert.equal(result.text, Array.from({ length: 256 }, (_, index) => `chunk-${index};`).join(''))
  assert.deepEqual(result.segments, [{ type: 'text', text: result.text }])
  assert.equal(result.steps.count, 1)
  assert.equal(result.steps.limit, 50)
  assert.equal(result.finishReason, 'stop')
})

void test('runAgent emits one error and one done when the provider fails', async () => {
  const { events, result } = await runWith(fakeModel('error'))
  assert.equal(events.filter((event) => event.type === 'error').length, 1)
  assert.equal(events.filter((event) => event.type === 'abort').length, 0)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(result.status, 'error')
  assert.ok(result.messageId)
  assert.match(result.status === 'error' ? result.error : '', /fake provider failure/)
})

void test('runAgent emits abort and done without normal completion events', async () => {
  const controller = new AbortController()
  const pending = runWith(fakeModel('abort'), controller.signal)
  setTimeout(() => controller.abort(new Error('cancelled by contract')), 20)
  const { events, result } = await pending
  assert.equal(events.filter((event) => event.type === 'abort').length, 1)
  assert.equal(events.filter((event) => event.type === 'error').length, 0)
  assert.equal(events.filter((event) => event.type === 'message-end').length, 0)
  const contextEvents = events.filter((event) => event.type === 'context-usage')
  assert.equal(contextEvents.length, 1)
  assert.equal(contextEvents[0]?.type === 'context-usage' ? contextEvents[0].usage.source : null, 'estimate')
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(result.status, 'aborted')
  assert.ok(result.messageId)
})

void test('runAgent converts an empty provider completion into a visible error and done', async () => {
  const { events, result } = await runWith(fakeModel('empty'))
  assert.equal(events.filter((event) => event.type === 'message-end').length, 0)
  const error = events.find((event) => event.type === 'error')
  assert.ok(error?.type === 'error')
  assert.match(error.error, /empty response/i)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(result.status, 'empty')
})

void test('runAgent stops and preserves output when the model enters a repetition loop', async () => {
  const events: StreamEvent[] = []
  const committed: ChatMessage[] = []
  const repeatedChunks = Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? '继续。\n' : '下一步。\n')
  const result = await runAgent({
    sessionId: 'session-repetition-loop',
    runId: 'run-repetition-loop',
    messages: [{ role: 'user', content: '继续开发项目' }],
    reasoningLevel: 'auto',
    model: fakeModel('normal', repeatedChunks),
    onStepCommitted: (message) => { committed.push(message) },
    onEvent: (event) => { events.push(event) }
  })

  assert.equal(result.status, 'repetition')
  assert.match(result.text, /检测到重复输出，已自动停止/)
  assert.ok(events.filter((event) => event.type === 'token').length < repeatedChunks.length + 1)
  assert.equal(events.filter((event) => event.type === 'abort').length, 0)
  assert.equal(events.filter((event) => event.type === 'error').length, 0)
  assert.equal(events.filter((event) => event.type === 'message-end').length, 1)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(committed.length, 1)
  assert.match(committed[0]?.content ?? '', /检测到重复输出/)
})

void test('runAgent converts invoke-prose into a real tool call', async () => {
  const executed: string[] = []
  const events: StreamEvent[] = []
  let streamCalls = 0
  const model = {
    specificationVersion: 'v2', provider: 'test', modelId: 'invoke-fallback', defaultObjectGenerationMode: 'json',
    doGenerate: async () => { throw new Error('unused') },
    doStream: async () => {
      streamCalls += 1
      const streamText = streamCalls === 1 ? 'invoke TodoWrite with todos is [{"content":"写报告"}]' : 'done'
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'response-metadata', id: 'r', modelId: 'invoke-fallback', timestamp: new Date(0) })
            controller.enqueue({ type: 'text-start', id: 't' })
            controller.enqueue({ type: 'text-delta', id: 't', delta: streamText })
            controller.enqueue({ type: 'text-end', id: 't' })
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
            controller.close()
          }
        }),
        rawCall: { rawPrompt: null, rawSettings: {} }
      }
    }
  } as unknown as LanguageModel

  const committedSteps: ChatMessage[] = []
  const result = await runAgent({
    sessionId: 'session-invoke',
    runId: 'run-invoke',
    messages: [{ role: 'user', content: '帮我列待办' }],
    reasoningLevel: 'auto',
    model,
    tools: {
      TodoWrite: tool({
        description: 'Create a task list',
        inputSchema: z.object({ todos: z.array(z.object({ content: z.string() })) }),
        execute: async ({ todos }) => { executed.push(JSON.stringify(todos)); return { output: 'saved' } }
      })
    },
    onStepCommitted: (message) => { committedSteps.push(message) },
    onEvent: (event) => { events.push(event) }
  })

  assert.equal(streamCalls, 2)
  assert.deepEqual(executed, ['[{"content":"写报告"}]'])
  assert.equal(result.status, 'completed')
  assert.match(result.text, /done/)
  assert.ok(events.some((event) => event.type === 'tool-call' && event.toolName === 'TodoWrite'))
  assert.ok(events.some((event) => event.type === 'tool-result' && event.toolName === 'TodoWrite'))
  const fallbackToolMessage = committedSteps.find((message) => message.segments?.some((segment) => segment.type === 'tools'))
  assert.ok(fallbackToolMessage, 'invoke fallback must commit a durable tool-segment message')
  assert.equal(fallbackToolMessage.segments?.[0]?.type, 'tools')
  assert.equal(fallbackToolMessage.segments?.[0]?.type === 'tools' ? fallbackToolMessage.segments[0].tools[0]?.status : undefined, 'done')
})

void test('execution contract requires a real first-step tool call and rejects text-only completion', async () => {
  const calls: ExecutionCallSnapshot[] = []
  const events: StreamEvent[] = []
  const committed: ChatMessage[] = []
  const result = await runAgent({
    sessionId: 'session-execution-contract',
    runId: 'run-execution-contract',
    messages: [{ role: 'user', content: '进行下一步' }],
    reasoningLevel: 'auto',
    model: textOnlyExecutionModel(calls),
    tools: {
      Read: tool({ description: 'Read', inputSchema: z.object({}), execute: async () => ({ output: 'read' }) }),
      Bash: tool({ description: 'Run', inputSchema: z.object({}), execute: async () => ({ output: 'ran' }) }),
      TodoWrite: tool({ description: 'Plan', inputSchema: z.object({}), execute: async () => ({ output: 'planned' }) })
    },
    executionContract: {
      taskKind: 'continuation',
      requireToolCall: true,
      activeToolNames: ['Read', 'Bash'],
      reason: 'test contract'
    },
    onStepCommitted: (message) => { committed.push(message) },
    onEvent: (event) => { events.push(event) }
  })

  assert.deepEqual(calls[0]?.toolChoice, { type: 'required' })
  assert.deepEqual(calls[0]?.toolNames, ['Bash', 'Read'])
  assert.match(JSON.stringify(calls[0]?.prompt), /HOST_EXECUTION_CONTRACT/)
  assert.equal(result.status, 'error')
  assert.match(result.status === 'error' ? result.error : '', /required a real tool call/i)
  assert.equal(committed.length, 0)
  assert.equal(events.filter((event) => event.type === 'message-end').length, 0)
  assert.equal(events.filter((event) => event.type === 'error').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
})

void test('execution contract accepts exact generated-tool invocation metadata', async () => {
  const generatedTool = {
    toolId: 'tool-1',
    versionId: 'version-1',
    fingerprint: 'a'.repeat(64),
    validationReportId: 'report-1',
    pointerRevision: 4,
    capabilityRevision: 7
  }
  const result = await runAgent({
    sessionId: 'session-exact-generated-tool',
    runId: 'run-exact-generated-tool',
    messages: [{ role: 'user', content: 'continue with the promoted tool' }],
    reasoningLevel: 'auto',
    model: exactGeneratedToolModel('GeneratedTool', {}),
    tools: { GeneratedTool: tool({ description: 'generated', inputSchema: z.object({}), execute: async () => ({ output: 'ok', metadata: { generatedTool } }) }) },
    executionContract: {
      taskKind: 'tool-forge-continuation',
      requireToolCall: true,
      activeToolNames: ['GeneratedTool'],
      requiredFirstTool: { toolName: 'GeneratedTool', ...generatedTool },
      reason: 'exact generated tool test'
    },
    onEvent: () => undefined
  })
  assert.equal(result.status, 'completed', JSON.stringify(result))
  const generatedMetadata = result.toolCalls[0]?.metadata?.generatedTool as Record<string, unknown> | undefined
  assert.equal(generatedMetadata?.versionId, 'version-1')
})

void test('execution contract rejects an exact generated-tool call without a matching result', async () => {
  const result = await runAgent({
    sessionId: 'session-exact-generated-tool-missing-result',
    runId: 'run-exact-generated-tool-missing-result',
    messages: [{ role: 'user', content: 'continue with the promoted tool' }],
    reasoningLevel: 'auto',
    model: exactGeneratedToolModel('GeneratedTool', {}),
    tools: { GeneratedTool: tool({ description: 'generated', inputSchema: z.object({}), execute: async () => ({ output: 'ok' }) }) },
    executionContract: {
      taskKind: 'tool-forge-continuation',
      requireToolCall: true,
      activeToolNames: ['GeneratedTool'],
      requiredFirstTool: {
        toolName: 'GeneratedTool',
        toolId: 'tool-1',
        versionId: 'version-1',
        fingerprint: 'a'.repeat(64),
        capabilityRevision: 7
      },
      reason: 'missing result test'
    },
    onEvent: () => undefined
  })
  assert.equal(result.status, 'error')
})

void test('execution contract allows the normal tool-result then final-text path', async () => {
  const requests: ModelMessage[][] = []
  const result = await runAgent({
    sessionId: 'session-execution-contract-success',
    runId: 'run-execution-contract-success',
    messages: [{ role: 'user', content: '继续验证' }],
    reasoningLevel: 'auto',
    model: multiStepModel(requests),
    tools: {
      Read: tool({ description: 'Read', inputSchema: z.object({}), execute: async () => ({ output: 'ok' }) })
    },
    executionContract: {
      taskKind: 'workspace-validation',
      requireToolCall: true,
      activeToolNames: ['Read'],
      reason: 'test contract'
    },
    onEvent: () => undefined
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0]?.status, 'done')
  assert.equal(result.text, 'finished')
})

void test('execution contract retries step 0 without required tool choice when thinking mode rejects it', async () => {
  const calls: ExecutionCallSnapshot[] = []
  const events: StreamEvent[] = []
  const result = await runAgent({
    sessionId: 'session-thinking-tool-choice',
    runId: 'run-thinking-tool-choice',
    messages: [{ role: 'user', content: '修复问题' }],
    reasoningLevel: 'auto',
    model: thinkingToolChoiceModel(calls),
    tools: {
      Read: tool({ description: 'Read', inputSchema: z.object({}), execute: async () => ({ output: 'read' }) }),
      Bash: tool({ description: 'Run', inputSchema: z.object({}), execute: async () => ({ output: 'ran' }) })
    },
    executionContract: {
      taskKind: 'workspace-change',
      requireToolCall: true,
      activeToolNames: ['Read', 'Bash'],
      reason: 'thinking-mode retry test'
    },
    onEvent: (event) => { events.push(event) }
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'finished')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0]?.status, 'done')
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0]?.toolChoice, { type: 'required' })
  assert.deepEqual(calls[1]?.toolChoice, { type: 'auto' })
  assert.deepEqual(calls[1]?.toolNames, ['Bash', 'Read'])
  assert.match(JSON.stringify(calls[1]?.prompt), /HOST_EXECUTION_CONTRACT/)
  assert.equal(events.filter((event) => event.type === 'error').length, 0)
  assert.equal(events.filter((event) => event.type === 'step-start').length, 2)
  assert.equal(events.filter((event) => event.type === 'message-end').length, 1)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.deepEqual(
    events.filter((event) => event.type === 'context-usage').map((event) => event.type === 'context-usage' ? event.usage.source : null),
    ['estimate', 'provider', 'estimate', 'provider', 'provider']
  )
})

void test('execution contract does not retry when the first step fails with an unrelated error', async () => {
  const calls: ExecutionCallSnapshot[] = []
  const events: StreamEvent[] = []
  const result = await runAgent({
    sessionId: 'session-tool-choice-no-retry',
    runId: 'run-tool-choice-no-retry',
    messages: [{ role: 'user', content: '修复问题' }],
    reasoningLevel: 'auto',
    model: failingThenTextModel(new Error('fake provider failure'), calls),
    tools: {
      Read: tool({ description: 'Read', inputSchema: z.object({}), execute: async () => ({ output: 'read' }) })
    },
    executionContract: {
      taskKind: 'workspace-change',
      requireToolCall: true,
      activeToolNames: ['Read'],
      reason: 'no-retry test'
    },
    onEvent: (event) => { events.push(event) }
  })

  assert.equal(result.status, 'error')
  assert.match(result.status === 'error' ? result.error : '', /fake provider failure/)
  assert.equal(calls.length, 1)
  assert.equal(events.filter((event) => event.type === 'error').length, 1)
  assert.equal(events.filter((event) => event.type === 'step-start').length, 1)
})

void test('execution contract does not retry when a non-400 error mentions tool choice', async () => {
  const calls: ExecutionCallSnapshot[] = []
  const events: StreamEvent[] = []
  const result = await runAgent({
    sessionId: 'session-tool-choice-500',
    runId: 'run-tool-choice-500',
    messages: [{ role: 'user', content: '修复问题' }],
    reasoningLevel: 'auto',
    model: failingThenTextModel(Object.assign(new Error('tool_choice rejected by upstream'), { statusCode: 500 }), calls),
    tools: {
      Read: tool({ description: 'Read', inputSchema: z.object({}), execute: async () => ({ output: 'read' }) })
    },
    executionContract: {
      taskKind: 'workspace-change',
      requireToolCall: true,
      activeToolNames: ['Read'],
      reason: 'no-retry-500 test'
    },
    onEvent: (event) => { events.push(event) }
  })

  assert.equal(result.status, 'error')
  assert.equal(calls.length, 1)
  assert.equal(events.filter((event) => event.type === 'error').length, 1)
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

void test('runAgent reports configured step-limit exhaustion and keeps chronological tool segments', async () => {
  const events: StreamEvent[] = []
  const result = await runAgent({
    sessionId: 'session-step-limit',
    runId: 'run-step-limit',
    messages: [{ role: 'user', content: 'keep using the tool' }],
    reasoningLevel: 'auto',
    maxSteps: 2,
    model: stepLimitModel(),
    tools: {
      Again: tool({ description: 'Continue', inputSchema: z.object({}), execute: async () => ({ output: 'again' }) })
    },
    onEvent: (event) => { events.push(event) }
  })

  assert.equal(result.status, 'step-limit')
  assert.equal(result.steps.count, 2)
  assert.equal(result.steps.limit, 2)
  assert.equal(result.finishReason, 'tool-calls')
  assert.equal(result.text, '')
  assert.deepEqual(result.toolCalls.map((call) => ({ id: call.toolCallId, output: call.output, status: call.status })), [
    { id: 'call-0', output: 'again', status: 'done' },
    { id: 'call-1', output: 'again', status: 'done' }
  ])
  assert.deepEqual(result.segments, [{ type: 'tools', tools: result.toolCalls }])
  assert.equal(events.filter((event) => event.type === 'message-end').length, 1)
  assert.equal(events.filter((event) => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
})

void test('runAgent replaces missing tool outputs with an explicit fallback', async () => {
  const events: StreamEvent[] = []
  await runAgent({
    sessionId: 'session-missing-tool-output',
    runId: 'run-missing-tool-output',
    messages: [{ role: 'user', content: 'run the tool' }],
    reasoningLevel: 'auto',
    model: multiStepModel([]),
    tools: {
      Read: tool({
        description: 'Return no output',
        inputSchema: z.object({}),
        execute: async () => undefined as unknown as string
      })
    },
    onEvent: (event) => { events.push(event) }
  })

  const result = events.find((event) => event.type === 'tool-result')
  assert.ok(result?.type === 'tool-result')
  assert.equal(result.output, 'Tool returned no output.')
  assert.doesNotMatch(result.output, /undefined/)
})

void test('next run consumes an already-projected checkpoint before automatic compression', async () => {
  const requests: ModelMessage[][] = []
  const checkpointSummary: ModelMessage = { role: 'system', content: 'Conversation checkpoint summary:\n- preserved history' }
  await runAgent({
    sessionId: 'session-checkpoint-consumption',
    runId: 'run-checkpoint-consumption',
    messages: [checkpointSummary, { role: 'user', content: 'latest current turn' }],
    reasoningLevel: 'auto',
    checkpointUsed: true,
    model: multiStepModel(requests),
    tools: {
      Read: tool({ description: 'Return a short result', inputSchema: z.object({}), execute: async () => ({ output: 'ok' }) })
    },
    onEvent: () => undefined
  })

  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.[0]?.content, checkpointSummary.content)
  assert.ok(requests[0]?.some((message) => message.role === 'user' && (typeof message.content === 'string'
    ? message.content === 'latest current turn'
    : message.content.some((part) => part.type === 'text' && part.text === 'latest current turn'))))
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

void test('prepareStep applies steer messages at the next safe model step', async () => {
  const requests: ModelMessage[][] = []
  const appliedSteps: number[] = []
  const events: StreamEvent[] = []
  await runAgent({
    sessionId: 'session-steer',
    runId: 'run-steer',
    messages: [{ role: 'user', content: 'start' }],
    reasoningLevel: 'auto',
    model: multiStepModel(requests),
    tools: {
      Read: tool({ description: 'Return a short result', inputSchema: z.object({}), execute: async () => ({ output: 'ok' }) })
    },
    takeSteerMessages: (stepNumber) => {
      appliedSteps.push(stepNumber)
      return stepNumber === 1 ? [{ id: 'steer-1', role: 'user', content: 'focus on the tests', createdAt: 1 }] : []
    },
    onEvent: (event) => { events.push(event) }
  })

  assert.deepEqual(appliedSteps, [0, 1])
  assert.ok(requests[1]?.some((message) => message.role === 'user' && (typeof message.content === 'string'
    ? message.content === 'focus on the tests'
    : message.content.some((part) => part.type === 'text' && part.text === 'focus on the tests'))))
  assert.deepEqual(events.filter((event) => event.type === 'step-start').map((event) => event.type === 'step-start' ? event.stepNumber : 0), [1, 2])
})

void test('onStepCommitted exposes replayable step messages after tool results close', async () => {
  const requests: ModelMessage[][] = []
  const committed: ChatMessage[] = []
  const generatedImage = {
    id: 'generated-image-1',
    sessionId: 'session-step-commit',
    filename: 'generated-image-1.jpg',
    mediaType: 'image/jpeg',
    sizeBytes: 1024,
    createdAt: 123
  }
  await runAgent({
    sessionId: 'session-step-commit',
    runId: 'run-step-commit',
    messages: [{ role: 'user', content: 'read then answer' }],
    reasoningLevel: 'auto',
    model: multiStepModel(requests),
    tools: {
      Read: tool({
        description: 'Return a short result',
        inputSchema: z.object({}),
        execute: async () => ({ output: 'ok', metadata: { generatedImages: [generatedImage] } })
      })
    },
    onStepCommitted: (message) => { committed.push(message) },
    onEvent: () => undefined
  })

  assert.equal(committed.length, 2)
  assert.equal(committed[0]?.segments?.[0]?.type, 'tools')
  assert.equal(committed[0]?.toolCalls?.[0]?.status, 'done')
  assert.equal(committed[0]?.toolCalls?.[0]?.output, 'ok')
  assert.deepEqual(committed[0]?.toolCalls?.[0]?.metadata?.generatedImages, [generatedImage])
  assert.deepEqual(committed[0]?.segments?.[0]?.type === 'tools' ? committed[0].segments[0].tools[0]?.metadata?.generatedImages : undefined, [generatedImage])
  assert.equal(committed[1]?.content, 'finished')
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
  const endUsage = messageEnd.usage ?? {}
  const { firstTokenMs, generationMs, ...reportedUsage } = endUsage
  assert.deepEqual(reportedUsage, {
    inputTokens: 390,
    outputTokens: 38,
    totalTokens: 428,
    noCacheTokens: 245,
    cacheReadTokens: 145,
    cacheWriteTokens: 5,
    stepCount: 3
  })
  // The fake stream emits text deltas, so timing must be recorded on the final usage.
  assert.equal(typeof firstTokenMs, 'number')
  assert.equal(typeof generationMs, 'number')

  const contextEvents = events.filter((event) => event.type === 'context-usage')
  assert.equal(contextEvents.length, 5)
  assert.deepEqual(contextEvents.map((event) => event.type === 'context-usage' ? event.usage.stepNumber : 0), [1, 1, 2, 2, 2])
  const finalContext = contextEvents.at(-1)
  assert.ok(finalContext?.type === 'context-usage')
  assert.equal(finalContext.usage.inputTokens, 250)
  assert.equal(finalContext.usage.cacheHitRate, 50)
  assert.equal(finalContext.usage.source, 'provider')
})

void test('request reconstruction: model-visible messages are derived from logged input plus recorded tool results', async () => {
  const requests: ModelMessage[][] = []
  const result = await runAgent({
    sessionId: 'session-reconstruction',
    runId: 'run-reconstruction',
    messages: [{ role: 'user', content: 'read then answer' }],
    reasoningLevel: 'auto',
    model: multiStepModel(requests),
    tools: {
      Read: tool({
        description: 'Read',
        inputSchema: z.object({}),
        execute: async () => ({ output: 'CONTENTS' })
      })
    },
    onEvent: () => undefined
  })

  // The first request carries exactly the logged user message.
  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.length, 1)
  assert.equal(requests[0]?.[0]?.role, 'user')
  assert.match(JSON.stringify(requests[0]?.[0]?.content), /read then answer/)
  // The second request reconstructs the transcript: user -> assistant tool-call -> tool result.
  const second = requests[1] ?? []
  assert.equal(second[0]?.role, 'user')
  assert.ok(second.some((message) => message.role === 'assistant'))
  const toolResultMessage = second.find((message) => message.role === 'tool')
  assert.ok(toolResultMessage)
  assert.match(JSON.stringify(toolResultMessage), /CONTENTS/)
  assert.equal(result.status, 'completed')
})
