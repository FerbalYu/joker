import test from 'node:test'
import assert from 'node:assert/strict'

import type { GeneratedToolDetailResult, GeneratedToolPromoteResult, GeneratedToolsListResult } from '../../shared/generated-tools-management'
import { handleGeneratedToolGet, handleGeneratedToolPromote, type GeneratedToolsMutationHandlers, type GeneratedToolsReadModel } from './generated-tools-handler'

const listed: GeneratedToolsListResult = {
  success: true,
  data: {
    registryRevision: 0,
    capabilityRevision: 0,
    invocationRevision: 0,
    qualification: null,
    qualificationOperation: null,
    tools: []
  }
}

void test('generated tools IPC get parser accepts only a strict stable tool id', () => {
  const calls: string[] = []
  const detail: GeneratedToolDetailResult = { success: false, error: { code: 'not-found', message: 'missing' } }
  const readModel: GeneratedToolsReadModel = {
    list: () => listed,
    get: (toolId) => {
      calls.push(toolId)
      return detail
    }
  }

  assert.deepEqual(handleGeneratedToolGet(readModel, { toolId: 'tool-1' }), detail)
  assert.deepEqual(calls, ['tool-1'])
  for (const invalid of [null, 'tool-1', {}, { toolId: '../escape' }, { toolId: 'tool-1', artifactPath: 'x' }]) {
    const result = handleGeneratedToolGet(readModel, invalid)
    assert.equal(result.success, false)
    if (!result.success) assert.equal(result.error.code, 'invalid-input')
  }
  assert.deepEqual(calls, ['tool-1'])
})

void test('generated tools IPC promote parser rejects extra fields before invoking host service', async () => {
  const calls: unknown[] = []
  const result: GeneratedToolPromoteResult = {
    success: true,
    data: {
      jobId: 'job-1',
      status: 'completed',
      jobRevision: 3,
      action: 'promoted',
      reason: 'ok',
      promotionId: 'promotion-1',
      phase: 'completed',
      originalTaskComplete: false
    }
  }
  const handlers: GeneratedToolsMutationHandlers = {
    promote: (input) => {
      calls.push(input)
      return result
    }
  }
  assert.deepEqual(await handleGeneratedToolPromote(handlers, {
    jobId: 'job-1',
    expectedJobRevision: 2,
    registryRevision: 7,
    expectedCandidateFingerprint: 'a'.repeat(64)
  }), result)
  assert.equal(calls.length, 1)
  for (const invalid of [
    null,
    {},
    { jobId: 'job-1', expectedJobRevision: 2, registryRevision: 7, expectedCandidateFingerprint: 'bad' },
    { jobId: 'job-1', expectedRevision: 2, registryRevision: 7, expectedCandidateFingerprint: 'a'.repeat(64) },
    {
      jobId: 'job-1',
      expectedJobRevision: 2,
      registryRevision: 7,
      expectedCandidateFingerprint: 'a'.repeat(64),
      approval: { approved: true }
    }, {
    jobId: 'job-1',
    expectedJobRevision: 2,
    registryRevision: 7,
    expectedCandidateFingerprint: 'a'.repeat(64),
    trustState: 'trusted'
  }]) {
    const invalidResult = await handleGeneratedToolPromote(handlers, invalid)
    assert.equal(invalidResult.success, false)
    if (!invalidResult.success) assert.equal(invalidResult.error.code, 'invalid-input')
  }
  assert.equal(calls.length, 1)
})
