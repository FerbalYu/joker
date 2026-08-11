import test from 'node:test'
import assert from 'node:assert/strict'

import { parseGeneratedToolEnableInput, parseGeneratedToolExportInput, parseGeneratedToolGetInput, parseGeneratedToolRemoveInput } from './generated-tools-management'

void test('Generated Tool management input is strict and path-free', () => {
  assert.deepEqual(parseGeneratedToolGetInput({ toolId: 'tool-1' }), { toolId: 'tool-1' })
  for (const invalid of [
    null,
    'tool-1',
    {},
    { toolId: '../tool' },
    { toolId: '/absolute' },
    { toolId: 'C:\\tool' },
    { toolId: 'tool-1', artifactPath: 'tools/tool-1' }
  ]) {
    assert.throws(() => parseGeneratedToolGetInput(invalid))
  }
})

void test('enable input accepts only a durable job identity', () => {
  assert.deepEqual(parseGeneratedToolEnableInput({ jobId: 'job-1' }), { jobId: 'job-1' })
  assert.throws(() => parseGeneratedToolEnableInput({ jobId: 'job-1', expectedJobRevision: 4 }))
  assert.throws(() => parseGeneratedToolEnableInput({ jobId: 'job-1', approval: { approved: true } }))
})

void test('Gate 4 remove and export inputs are strict and path-safe', () => {
  assert.deepEqual(parseGeneratedToolRemoveInput({ toolId: 'tool-1', expectedRevision: 2, operationId: 'remove-1' }), { toolId: 'tool-1', expectedRevision: 2, operationId: 'remove-1' })
  assert.deepEqual(parseGeneratedToolExportInput({ toolId: 'tool-1', versionId: 'version-1' }), { toolId: 'tool-1', versionId: 'version-1' })
  assert.throws(() => parseGeneratedToolRemoveInput({ toolId: 'tool-1', expectedRevision: 2, operationId: 'remove-1', extra: true }))
  assert.throws(() => parseGeneratedToolExportInput({ toolId: 'tool-1', versionId: '../escape' }))
})
