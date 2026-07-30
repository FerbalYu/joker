import test from 'node:test'
import assert from 'node:assert/strict'
import { getReadonlySubagentToolNames, runSubagent } from './subagent'

function createContext(signal: AbortSignal): Parameters<typeof runSubagent>[0]['toolContext'] {
  return {
    workspacePath: 'C:\\workspace',
    sessionId: 'session-test',
    runId: `run-${crypto.randomUUID()}`,
    approvalGate: async () => ({ outcome: 'allow', risk: 'read', reason: 'test approval' }),
    abortSignal: signal
  }
}

function fakeModel(active: { count: number; max: number }, delayMs: number): Parameters<typeof runSubagent>[0]['model'] {
  return {
    specificationVersion: 'v2',
    provider: 'test',
    modelId: 'test',
    defaultObjectGenerationMode: 'json',
    doGenerate: async () => ({
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      rawCall: { rawPrompt: null, rawSettings: {} },
      text: 'done'
    }),
    doStream: async () => {
      active.count += 1
      active.max = Math.max(active.max, active.count)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      active.count -= 1
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'text-1' })
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'done' })
            controller.enqueue({ type: 'text-end', id: 'text-1' })
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
            controller.close()
          }
        }),
        rawCall: { rawPrompt: null, rawSettings: {} }
      }
    }
  } as unknown as Parameters<typeof runSubagent>[0]['model']
}

void test('sub-agent allowlist is read-only and excludes write, Bash, web, image, and MCP tools', () => {
  assert.deepEqual(getReadonlySubagentToolNames(), ['Read', 'Grep', 'Glob', 'GitStatus', 'GitDiff', 'GitLog', 'GitBranch'])
})

void test('sub-agent rejects an already-aborted request before creating a provider run', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runSubagent({ prompt: 'should not run', toolContext: createContext(controller.signal) }), /Aborted/)
})

void test('sub-agent cancels a queued request without starting it', async () => {
  const active = { count: 0, max: 0 }
  const model = fakeModel(active, 80)
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = runSubagent({ prompt: 'first', model, toolContext: createContext(firstController.signal) })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = runSubagent({ prompt: 'queued', model, toolContext: createContext(secondController.signal) })
  secondController.abort()
  await assert.rejects(second, /aborted/i)
  await first
  assert.equal(active.max >= 1, true)
})

void test('sub-agent returns output with cumulative usage details', async () => {
  const active = { count: 0, max: 0 }
  const controller = new AbortController()
  const result = await runSubagent({
    prompt: 'report usage',
    model: fakeModel(active, 0),
    toolContext: createContext(controller.signal)
  })
  assert.equal(result.output, 'done')
  assert.deepEqual(result.usage, {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    stepCount: 1
  })
})

void test('sub-agent concurrency is capped at four running providers', async () => {
  const active = { count: 0, max: 0 }
  const model = fakeModel(active, 60)
  const runs = Array.from({ length: 6 }, (_, index) => {
    const controller = new AbortController()
    return runSubagent({ prompt: `run-${index}`, model, toolContext: createContext(controller.signal) })
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(active.max, 4)
  await Promise.all(runs)
  assert.equal(active.count, 0)
})
