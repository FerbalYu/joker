import test from 'node:test'
import assert from 'node:assert/strict'

import type { GeneratedToolSpec } from '../../shared/generated-tools'
import { compileGeneratedToolValidationPlan } from './validation-suite'

function spec(validationCases?: GeneratedToolSpec['validationCases']): GeneratedToolSpec {
  return {
    id: 'arbitrary-generic-tool',
    displayName: 'ArbitraryGenericTool',
    goal: 'Return a deterministic result.',
    reason: 'Test generic validation plan compilation.',
    requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' },
    scope: 'project',
    projectId: 'project-1',
    inputContract: { type: 'object' },
    outputContract: { type: 'string' },
    permissions: { filesystem: { read: [], write: [] }, network: { hosts: [] }, process: { commands: [] }, environment: { keys: [] }, secrets: { handles: [] } },
    ...(validationCases ? { validationCases } : {}),
    acceptance: ['Returns deterministic output.'],
    examples: [{ input: {}, expected: 'ok' }]
  }
}

void test('generic validation plans require at least one expected-success case', () => {
  assert.throws(
    () => compileGeneratedToolValidationPlan(spec([
      { id: 'failure', input: {}, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected' } } }
    ])),
    /expected-success/
  )
})

void test('generic validation plans accept success-only cases', () => {
  const plan = compileGeneratedToolValidationPlan(spec([
    { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } }
  ]))
  assert.deepEqual(plan.cases.map((item) => item.id), ['success'])
})

void test('validation plan case ids must be unique', () => {
  assert.throws(
    () => compileGeneratedToolValidationPlan(spec([
      { id: 'dup', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } },
      { id: 'dup', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } }
    ])),
    /unique/
  )
})
