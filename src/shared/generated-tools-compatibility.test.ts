import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GENERATED_TOOL_COMPATIBILITY_CONTRACT,
  checkGeneratedToolCompatibility,
  SUPPORTED_GENERATED_TOOL_RUNTIME_IDS,
  SUPPORTED_GENERATED_TOOL_RUNTIME_VERSIONS,
  SUPPORTED_GENERATED_TOOL_SCHEMA_VERSIONS,
  SUPPORTED_GENERATED_TOOL_SDK_VERSIONS
} from './generated-tools-compatibility'

const manifest = {
  schemaVersion: 1,
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm', version: '0.32.0' }
}

void test('Generated Tool compatibility accepts the current host contract', () => {
  const result = checkGeneratedToolCompatibility(manifest)
  assert.equal(result.compatible, true)
  if (result.compatible) assert.deepEqual(result.contract, GENERATED_TOOL_COMPATIBILITY_CONTRACT)
  assert.deepEqual(SUPPORTED_GENERATED_TOOL_SCHEMA_VERSIONS, [1])
  assert.deepEqual(SUPPORTED_GENERATED_TOOL_SDK_VERSIONS, ['1.0.0', '1'])
  assert.deepEqual(SUPPORTED_GENERATED_TOOL_RUNTIME_IDS, ['quickjs-wasm'])
  assert.deepEqual(SUPPORTED_GENERATED_TOOL_RUNTIME_VERSIONS, ['0.32.0'])
})

void test('Generated Tool compatibility fails closed with structured reasons', () => {
  const result = checkGeneratedToolCompatibility({
    ...manifest,
    schemaVersion: 2,
    sdkVersion: '2.0.0',
    runtime: { id: 'node-vm', version: '99.0.0' }
  })
  assert.equal(result.compatible, false)
  if (!result.compatible) {
    assert.deepEqual(result.reasons.map(({ code, field, expected, actual }) => ({ code, field, expected, actual })), [
      { code: 'unsupported-schema-version', field: 'schemaVersion', expected: [1], actual: 2 },
      { code: 'unsupported-sdk-version', field: 'sdkVersion', expected: ['1.0.0', '1'], actual: '2.0.0' },
      { code: 'unsupported-runtime-id', field: 'runtime.id', expected: ['quickjs-wasm'], actual: 'node-vm' },
      { code: 'unsupported-runtime-version', field: 'runtime.version', expected: ['0.32.0'], actual: '99.0.0' }
    ])
  }
})

void test('Generated Tool compatibility rejects malformed envelopes', () => {
  const missingRuntime = checkGeneratedToolCompatibility({ schemaVersion: 1, sdkVersion: '1.0.0' })
  assert.equal(missingRuntime.compatible, false)
  if (!missingRuntime.compatible) assert.deepEqual(missingRuntime.reasons, [
    { code: 'invalid-runtime', field: 'runtime', expected: ['object'], actual: undefined }
  ])

  const invalidInput = checkGeneratedToolCompatibility(null)
  assert.equal(invalidInput.compatible, false)
  if (!invalidInput.compatible) assert.deepEqual(invalidInput.reasons, [
    { code: 'invalid-input', field: 'manifest', expected: ['object'], actual: null }
  ])
})
