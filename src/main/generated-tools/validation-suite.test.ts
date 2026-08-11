import test from 'node:test'
import assert from 'node:assert/strict'

import type { GeneratedToolSpec } from '../../shared/generated-tools'
import { compileGeneratedToolValidationPlan, SUMMARIZE_TASK_JSON_VALIDATION_SUITE } from './validation-suite'

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

void test('generic validation plans require independently observable success and failure cases', () => {
  assert.throws(
    () => compileGeneratedToolValidationPlan(spec([
      { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } }
    ])),
    /explicit expected-failure/
  )
  assert.throws(
    () => compileGeneratedToolValidationPlan(spec([
      { id: 'failure', input: {}, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected' } } }
    ])),
    /expected-success/
  )

  const plan = compileGeneratedToolValidationPlan(spec([
    { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } },
    { id: 'failure', input: { fail: true }, workspaceFiles: {}, expected: { outcome: 'tool-failed', error: { message: 'expected' } } }
  ]))
  assert.deepEqual(plan.cases.map((item) => item.id), ['success', 'failure'])
})

void test('registered tool IDs cannot replace host cases with success-only validation', () => {
  const registered = spec([
    { id: 'success', input: {}, workspaceFiles: {}, expected: { outcome: 'succeeded', output: 'ok' } }
  ])
  registered.id = SUMMARIZE_TASK_JSON_VALIDATION_SUITE.toolId
  assert.throws(() => compileGeneratedToolValidationPlan(registered), /explicit expected-failure/)
})

void test('unregistered legacy examples cannot silently become an auto-promotion plan', () => {
  assert.throws(() => compileGeneratedToolValidationPlan(spec()), /explicit expected-failure/)
})
