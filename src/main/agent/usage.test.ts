import test from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModelUsage, ModelMessage } from 'ai'
import type { CapabilitySnapshot } from './capabilities'
import { addStreamUsage, buildContextUsage, estimateMessagesWithCapabilities, streamUsageFromModelUsage } from './usage'

function modelUsage(): LanguageModelUsage {
  return {
    inputTokens: 1_000,
    outputTokens: 120,
    totalTokens: 1_120,
    inputTokenDetails: {
      noCacheTokens: 600,
      cacheReadTokens: 300,
      cacheWriteTokens: 100
    },
    outputTokenDetails: {
      textTokens: 100,
      reasoningTokens: 20
    }
  }
}

const capabilities: CapabilitySnapshot = {
  systemPrompt: 'system instructions ' + 's'.repeat(400),
  activeSkillIds: [],
  skillTokens: 25,
  mcpTokens: 50,
  toolDefinitionTokens: 100,
  generatedToolVersions: []
}

void test('streamUsageFromModelUsage preserves cache details and step count', () => {
  assert.deepEqual(streamUsageFromModelUsage(modelUsage(), 3), {
    inputTokens: 1_000,
    outputTokens: 120,
    totalTokens: 1_120,
    noCacheTokens: 600,
    cacheReadTokens: 300,
    cacheWriteTokens: 100,
    stepCount: 3
  })
})

void test('addStreamUsage aggregates reported fields and derives a conservative total', () => {
  assert.deepEqual(addStreamUsage(
    { inputTokens: 10, cacheReadTokens: 2, stepCount: 1 },
    { inputTokens: 20, outputTokens: 4, cacheWriteTokens: 3, stepCount: 2 }
  ), {
    inputTokens: 30,
    outputTokens: 4,
    totalTokens: 34,
    noCacheTokens: undefined,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
    stepCount: 3
  })
  assert.equal(addStreamUsage(
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    { inputTokens: 20, outputTokens: 4 }
  ).totalTokens, 39)
})

void test('provider context uses the current step input and cache ratio, not cumulative usage', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'hello ' + 'u'.repeat(100) },
    { role: 'assistant', content: 'answer ' + 'a'.repeat(100) },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'Read',
        output: { type: 'text', value: 'result ' + 'r'.repeat(100) }
      }]
    }
  ]
  const result = buildContextUsage(messages, {
    actualInputTokens: 500,
    cacheReadTokens: 125,
    maxTokens: 10_000,
    capabilities,
    source: 'provider',
    stepNumber: 4,
    compressionCount: 2,
    compressionBeforeTokens: 9_000,
    compressionAfterTokens: 3_000
  })

  assert.equal(result.inputTokens, 500)
  assert.equal(result.percent, 5)
  assert.equal(result.cacheHitRate, 25)
  assert.equal(result.source, 'provider')
  assert.equal(result.stepNumber, 4)
  assert.equal(result.compressionCount, 2)
  assert.equal(result.compressionBeforeTokens, 9_000)
  assert.equal(result.compressionAfterTokens, 3_000)
  assert.equal(result.messageTokens + result.mcpTokens + result.systemTokens + result.toolTokens + result.skillTokens + result.systemPromptTokens + result.otherTokens, 500)
})

void test('estimated context includes instructions and tool definitions', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
  const estimated = estimateMessagesWithCapabilities(messages, capabilities)
  const result = buildContextUsage(messages, {
    maxTokens: 10_000,
    capabilities,
    source: 'estimate',
    stepNumber: 1
  })
  assert.equal(result.inputTokens, estimated)
  assert.equal(result.source, 'estimate')
})
