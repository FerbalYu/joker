import test from 'node:test'
import assert from 'node:assert/strict'

import type { GeneratedToolRevalidateResult } from '../../shared/generated-tools-management'
import { handleGeneratedToolRevalidate, type GeneratedToolsMutationHandlers } from './generated-tools-handler'

void test('generated tools IPC revalidate validates strict input before invoking the service', () => {
  const calls: unknown[] = []
  const result: GeneratedToolRevalidateResult = {
    success: true,
    data: {
      toolId: 'tool-1',
      versionId: 'version-1',
      action: 'revalidated',
      registryRevision: 2,
      capabilityRevision: 3,
      activeVersionId: 'version-1',
      reason: 'ok'
    }
  }
  const handlers: GeneratedToolsMutationHandlers = {
    enable: () => ({ success: false, error: { code: 'read-failed', message: 'unused' } }),
    revalidate: (input) => {
      calls.push(input)
      return result
    }
  }

  assert.deepEqual(handleGeneratedToolRevalidate(handlers, {
    toolId: 'tool-1',
    versionId: 'version-1',
    expectedRevision: 1,
    operationId: 'revalidate-1'
  }), result)
  assert.equal(calls.length, 1)
  for (const invalid of [null, {}, { toolId: '../escape', versionId: 'version-1', expectedRevision: 1, operationId: 'revalidate-1' }, {
    toolId: 'tool-1',
    versionId: 'version-1',
    expectedRevision: 1,
    operationId: 'revalidate-1',
    artifactPath: 'arbitrary'
  }]) {
    const invalidResult = handleGeneratedToolRevalidate(handlers, invalid)
    assert.equal(invalidResult.success, false)
    if (!invalidResult.success) assert.equal(invalidResult.error.code, 'invalid-input')
  }
  assert.equal(calls.length, 1)
})

void test('generated tools IPC revalidate reports unavailable services without throwing', () => {
  const handlers: GeneratedToolsMutationHandlers = {
    enable: () => ({ success: false, error: { code: 'read-failed', message: 'unused' } })
  }
  const result = handleGeneratedToolRevalidate(handlers, {
    toolId: 'tool-1',
    versionId: 'version-1',
    expectedRevision: 1,
    operationId: 'revalidate-1'
  })
  assert.equal(result.success, false)
  if (!result.success) assert.equal(result.error.message, 'Generated Tool revalidation service is unavailable')
})
