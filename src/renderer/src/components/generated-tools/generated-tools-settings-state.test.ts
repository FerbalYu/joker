import test from 'node:test'
import assert from 'node:assert/strict'

import type {
  GeneratedToolContinuationView,
  GeneratedToolsInventorySnapshot
} from '@shared/types'
import { generatedToolJobProductState, generatedToolProductState, hasFailedGeneratedToolUpdate, isStaleGeneratedToolsCasError, shouldPollGeneratedTools } from './generated-tools-settings-state'

function snapshot(overrides: Partial<GeneratedToolsInventorySnapshot> = {}): GeneratedToolsInventorySnapshot {
  return {
    registryRevision: 1,
    capabilityRevision: 1,
    invocationRevision: 1,
    qualification: null,
    tools: [],
    ...overrides
  }
}

function continuation(status: GeneratedToolContinuationView['status']): GeneratedToolContinuationView {
  return {
    id: 'continuation-1',
    jobId: 'job-1',
    toolId: 'tool-1',
    versionId: 'version-1',
    fingerprint: 'a'.repeat(64),
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    fromCapabilityRevision: 1,
    toCapabilityRevision: 2,
    status,
    attempt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function inventoryItem(overrides: Partial<GeneratedToolsInventorySnapshot['tools'][number]> = {}): GeneratedToolsInventorySnapshot['tools'][number] {
  return {
    toolId: 'tool-1',
    displayName: 'Tool',
    description: 'Tool',
    scope: 'user',
    availability: 'available',
    executable: true,
    executionPolicy: 'auto-eligible',
    integrity: 'verified',
    issues: [],
    activeVersionId: 'version-1',
    lastStableVersionId: 'version-1',
    permissionSummary: [],
    invocationCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

void test('product states simplify forge and inventory internals', () => {
  assert.equal(generatedToolJobProductState('planning'), 'manufacturing')
  assert.equal(generatedToolJobProductState('awaiting-policy'), 'waiting-permission')
  assert.equal(generatedToolJobProductState('failed'), 'validation-failed')
  assert.equal(generatedToolProductState(inventoryItem()), 'enabled')
  assert.equal(generatedToolProductState(inventoryItem({ availability: 'disabled', executable: false })), 'disabled')
  assert.equal(generatedToolProductState(inventoryItem({ availability: 'failed', executable: false })), 'validation-failed')
  assert.equal(generatedToolProductState(inventoryItem({ availability: 'permission-required', executable: false })), 'waiting-permission')
})

void test('stable enabled asset remains enabled while a failed update is reported separately', () => {
  const item = inventoryItem({
    candidate: {
      jobId: 'job-2',
      jobRevision: 2,
      mode: 'edit',
      status: 'failed',
      attempt: 2,
      maxAttempts: 2,
      error: 'validation failed',
      updatedAt: 2
    }
  })
  assert.equal(generatedToolProductState(item), 'enabled')
  assert.equal(hasFailedGeneratedToolUpdate(item), true)
})

void test('polling continues for transient qualification, job, and continuation states', () => {
  assert.equal(shouldPollGeneratedTools(snapshot({
    qualificationOperation: { attemptId: 'qualification-1', status: 'running', completedChecks: 1, totalChecks: 2, updatedAt: 1 }
  }), []), true)
  assert.equal(shouldPollGeneratedTools(snapshot({
    tools: [{
      toolId: 'tool-1',
      displayName: 'Tool',
      description: 'Tool',
      scope: 'user',
      availability: 'building',
      executable: false,
      executionPolicy: 'unavailable',
      integrity: 'verified',
      issues: [],
      permissionSummary: [],
      invocationCount: 0,
      candidate: {
        jobId: 'job-1',
        jobRevision: 1,
        mode: 'create',
        status: 'validating',
        attempt: 1,
        maxAttempts: 2,
        updatedAt: 1
      },
      createdAt: 1,
      updatedAt: 1
    }]
  }), []), true)
  assert.equal(shouldPollGeneratedTools(snapshot(), [continuation('running')]), true)
})

void test('polling stops at awaiting-policy and terminal continuation states', () => {
  assert.equal(shouldPollGeneratedTools(snapshot({
    tools: [{
      toolId: 'tool-1',
      displayName: 'Tool',
      description: 'Tool',
      scope: 'user',
      availability: 'changed',
      executable: false,
      executionPolicy: 'unavailable',
      integrity: 'verified',
      issues: [],
      permissionSummary: [],
      invocationCount: 0,
      candidate: {
        jobId: 'job-1',
        jobRevision: 1,
        mode: 'edit',
        status: 'awaiting-policy',
        attempt: 1,
        maxAttempts: 2,
        updatedAt: 1
      },
      createdAt: 1,
      updatedAt: 1
    }]
  }), [continuation('completed')]), false)
})

void test('stale CAS detection recognizes revision errors without classifying ordinary failures', () => {
  assert.equal(isStaleGeneratedToolsCasError(new Error('ForgeJob revision is stale')), true)
  assert.equal(isStaleGeneratedToolsCasError({ message: 'Expected registry revision mismatch' }), true)
  assert.equal(isStaleGeneratedToolsCasError(new Error('Permission denied')), false)
})
