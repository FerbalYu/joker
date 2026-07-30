import test from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModel, ModelMessage } from 'ai'
import {
  compressContext,
  compressionThreshold,
  estimateContextTokens,
  truncateLargeToolResults
} from './context'

function v3Usage(inputTokens = 10, outputTokens = 3) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 }
  }
}

function toolOutputValue(message: ModelMessage | undefined): string {
  assert.ok(message?.role === 'tool')
  const part = message.content.find((item) => item.type === 'tool-result')
  assert.ok(part?.type === 'tool-result' && part.output.type === 'text')
  return part.output.value
}

function summaryModel(options: { fail?: boolean; text?: string } = {}): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'summary',
    supportedUrls: {},
    doGenerate: async () => {
      if (options.fail) throw new Error('summary failed')
      return {
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: v3Usage(),
        response: { id: 'summary-response', modelId: 'summary', timestamp: new Date(0) },
        content: [{ type: 'text', text: options.text ?? 'compact history' }],
        warnings: []
      }
    },
    doStream: async () => {
      throw new Error('not used')
    }
  } as unknown as LanguageModel
}

function toolTurn(output: string): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', input: { file_path: 'large.txt' } }]
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'Read',
        output: { type: 'text', value: output }
      }]
    }
  ]
}

void test('estimateContextTokens scales with text size', () => {
  const short: ModelMessage[] = [{ role: 'user', content: '1234' }]
  const long: ModelMessage[] = [{ role: 'user', content: '1'.repeat(400) }]
  assert.ok(estimateContextTokens(long) > estimateContextTokens(short))
})

void test('compression threshold uses the lower ratio and reserved-token limit', () => {
  assert.equal(compressionThreshold({ maxContextTokens: 100_000, outputTokenReserve: 8_000 }), 80_000)
  assert.equal(compressionThreshold({ maxContextTokens: 12_000, outputTokenReserve: 8_000 }), 1)
})

void test('below the compression threshold reports unchanged messages', async () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
  const result = await compressContext(messages, { maxContextTokens: 20_000 })
  assert.equal(result.messages, messages)
  assert.equal(result.attempted, false)
  assert.equal(result.compressed, false)
  assert.equal(result.beforeTokens, result.afterTokens)
})

void test('successful compression summarizes old history and retains the current turn', async () => {
  const currentUser = { role: 'user' as const, content: 'current request' }
  const messages: ModelMessage[] = [
    { role: 'user', content: 'old request ' + 'a'.repeat(12_000) },
    { role: 'assistant', content: 'old answer ' + 'b'.repeat(12_000) },
    currentUser,
    ...toolTurn('tool output ' + 'c'.repeat(4_000))
  ]
  const result = await compressContext(messages, {
    maxContextTokens: 12_000,
    outputTokenReserve: 1_000,
    model: summaryModel()
  })

  assert.equal(result.attempted, true)
  assert.equal(result.compressed, true)
  assert.equal(result.error, undefined)
  assert.equal(result.messages[0]?.role, 'system')
  assert.match(String(result.messages[0]?.content), /compact history/)
  assert.ok(result.messages.includes(currentUser))
  assert.ok(result.afterTokens < result.beforeTokens)
  assert.ok(result.afterTokens < compressionThreshold({ maxContextTokens: 12_000, outputTokenReserve: 1_000 }))
  assert.equal(result.usage?.inputTokens, 10)
})

void test('summary failure falls back to model-side tool output projection', async () => {
  const originalOutput = 'x'.repeat(120_000)
  const messages: ModelMessage[] = [
    { role: 'user', content: 'old request ' + 'a'.repeat(8_000) },
    { role: 'assistant', content: 'old answer ' + 'b'.repeat(8_000) },
    { role: 'user', content: 'inspect the large result' },
    ...toolTurn(originalOutput)
  ]
  const result = await compressContext(messages, {
    maxContextTokens: 20_000,
    outputTokenReserve: 2_000,
    model: summaryModel({ fail: true })
  })

  assert.equal(result.attempted, true)
  assert.equal(result.compressed, true)
  assert.match(result.error ?? '', /summary failed/)
  assert.ok(result.afterTokens < result.beforeTokens)
  assert.equal(toolOutputValue(messages.at(-1)), originalOutput)
  const projected = result.messages.find((message) => message.role === 'tool')
  assert.match(toolOutputValue(projected), /truncated for context/)
})

void test('one giant current tool result is truncated below the threshold without mutating session data', async () => {
  const originalOutput = 'z'.repeat(200_000)
  const messages: ModelMessage[] = [{ role: 'user', content: 'read it' }, ...toolTurn(originalOutput)]
  const result = await compressContext(messages, {
    maxContextTokens: 24_000,
    outputTokenReserve: 2_000,
    model: summaryModel()
  })

  assert.equal(result.attempted, true)
  assert.equal(result.compressed, true)
  assert.ok(result.afterTokens < compressionThreshold({ maxContextTokens: 24_000, outputTokenReserve: 2_000 }))
  assert.equal(toolOutputValue(messages.at(-1)), originalOutput)
  const projected = result.messages.find((message) => message.role === 'tool')
  assert.match(toolOutputValue(projected), /truncated for context/)
})

void test('tool result truncation keeps non-text outputs and original messages unchanged', () => {
  const messages: ModelMessage[] = toolTurn('y'.repeat(100_000))
  const projected = truncateLargeToolResults(messages)
  assert.notEqual(projected, messages)
  assert.match(toolOutputValue(projected[1]), /truncated for context/)
  assert.doesNotMatch(toolOutputValue(messages[1]), /truncated for context/)
})
