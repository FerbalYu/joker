import test from 'node:test'
import assert from 'node:assert/strict'
import type { ContextUsage } from '@shared/types'
import { contextOptimizationView } from './context-optimization-ui'

const baseUsage: ContextUsage = {
  inputTokens: 1000,
  maxTokens: 10_000,
  percent: 10,
  messageTokens: 800,
  mcpTokens: 0,
  systemTokens: 100,
  toolTokens: 50,
  skillTokens: 0,
  systemPromptTokens: 50,
  otherTokens: 0
}

void test('contextOptimizationView exposes mode, policy, latest transform and cost metrics', () => {
  const view = contextOptimizationView({
    ...baseUsage,
    optimization: {
      mode: 'v2',
      policyVersion: 'context-v2.1',
      transforms: [
        { sourceType: 'Bash', transform: 'log-template-fold', beforeTokens: 8000, afterTokens: 900, durationMs: 12, contextId: 'ctx-1' }
      ],
      summaryInputTokens: 400,
      summaryOutputTokens: 100,
      estimatedNetSavedTokens: 6500,
      retrievalCount: 2,
      retrievalFailureCount: 1
    }
  })

  assert.deepEqual(view, {
    mode: 'v2',
    policyVersion: 'context-v2.1',
    latestTransform: {
      sourceType: 'Bash',
      transform: 'log-template-fold',
      beforeTokens: 8000,
      afterTokens: 900,
      durationMs: 12,
      contextId: 'ctx-1',
      retrievable: true,
      error: undefined
    },
    summaryInputTokens: 400,
    summaryOutputTokens: 100,
    estimatedNetSavedTokens: 6500,
    retrievalCount: 2,
    retrievalFailureCount: 1,
    error: undefined
  })
})

void test('contextOptimizationView keeps legacy compression UI compatible', () => {
  const view = contextOptimizationView({
    ...baseUsage,
    compressionBeforeTokens: 5000,
    compressionAfterTokens: 1200,
    compressionError: 'summary unavailable'
  })

  assert.equal(view?.latestTransform?.transform, 'legacy-summary')
  assert.equal(view?.latestTransform?.retrievable, false)
  assert.equal(view?.error, 'summary unavailable')
})

void test('contextOptimizationView tolerates expected top-level fields from parallel shared type work', () => {
  const usage = {
    ...baseUsage,
    mode: 'observe',
    policyVersion: 'shadow-v2',
    lastTransform: { transform: 'json-minify', beforeTokens: 2000, afterTokens: 500, retrievable: false },
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
    estimatedNetSavedTokens: -50,
    retrievalCount: 0,
    retrievalFailureCount: 0,
    optimizationError: 'shadow mismatch'
  } as ContextUsage

  const view = contextOptimizationView(usage)
  assert.equal(view?.mode, 'observe')
  assert.equal(view?.estimatedNetSavedTokens, -50)
  assert.equal(view?.error, 'shadow mismatch')
})
