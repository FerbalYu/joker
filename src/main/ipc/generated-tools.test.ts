import test from 'node:test'
import assert from 'node:assert/strict'

import type { GeneratedToolDetailResult, GeneratedToolEnableResult, GeneratedToolJobStatusResult, GeneratedToolsListResult } from '../../shared/generated-tools-management'
import { handleGeneratedToolEnable, handleGeneratedToolGet, handleGeneratedToolJobStatus, type GeneratedToolsMutationHandlers, type GeneratedToolsReadModel } from './generated-tools-handler'

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
    },
    jobStatus: () => ({ success: false, error: { code: 'not-found', message: 'missing' } })
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

void test('generated tools IPC job status parser accepts only a strict stable job id', () => {
  const calls: string[] = []
  const result: GeneratedToolJobStatusResult = {
    success: true,
    data: {
      jobId: 'job-1',
      toolId: 'tool-1',
      mode: 'create',
      status: 'failed',
      jobRevision: 2,
      attempt: 1,
      maxAttempts: 3,
      error: 'failed',
      createdAt: 1,
      updatedAt: 2,
      finishedAt: 2,
      registryRevision: 0,
      capabilityRevision: 0,
      originalTaskComplete: false
    }
  }
  const readModel: GeneratedToolsReadModel = {
    list: () => listed,
    get: () => ({ success: false, error: { code: 'not-found', message: 'missing' } }),
    jobStatus: (jobId) => {
      calls.push(jobId)
      return result
    }
  }

  assert.deepEqual(handleGeneratedToolJobStatus(readModel, { jobId: 'job-1' }), result)
  assert.deepEqual(calls, ['job-1'])
  for (const invalid of [null, 'job-1', {}, { jobId: '../escape' }, { jobId: 'job-1', artifactPath: 'x' }]) {
    const invalidResult = handleGeneratedToolJobStatus(readModel, invalid)
    assert.equal(invalidResult.success, false)
    if (!invalidResult.success) assert.equal(invalidResult.error.code, 'invalid-input')
  }
  assert.deepEqual(calls, ['job-1'])
})

void test('generated tools IPC enable parser accepts only the durable job identity', async () => {
  const calls: unknown[] = []
  const result: GeneratedToolEnableResult = {
    success: true,
    data: {
      jobId: 'job-1',
      toolId: 'tool-1',
      status: 'completed',
      action: 'enabled',
      reason: 'ok',
      originalTaskComplete: false
    }
  }
  const handlers: GeneratedToolsMutationHandlers = {
    enable: (input) => {
      calls.push(input)
      return result
    }
  }
  assert.deepEqual(await handleGeneratedToolEnable(handlers, { jobId: 'job-1' }), result)
  assert.deepEqual(calls, [{ jobId: 'job-1' }])
  for (const invalid of [
    null,
    {},
    { jobId: '../escape' },
    { jobId: 'job-1', expectedJobRevision: 2 },
    { jobId: 'job-1', approval: { approved: true } },
    { jobId: 'job-1', candidateFingerprint: 'a'.repeat(64) }
  ]) {
    const invalidResult = await handleGeneratedToolEnable(handlers, invalid)
    assert.equal(invalidResult.success, false)
    if (!invalidResult.success) assert.equal(invalidResult.error.code, 'invalid-input')
  }
  assert.equal(calls.length, 1)
})
