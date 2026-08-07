import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CapabilityRevisionStateSchema,
  ForgeJobSchema,
  GeneratedToolDescriptorSchema,
  GeneratedToolInvocationSchema,
  GeneratedToolManifestSchema,
  GeneratedToolRegistryStateSchema,
  GeneratedToolSpecSchema,
  GeneratedToolValidationReportSchema,
  GeneratedToolVersionSchema,
  RuntimeQualificationReportSchema,
  ToolForgeContinuationClaimSchema,
  ToolForgeContinuationStateSchema,
  canonicalGeneratedToolJson
} from './generated-tools-schema'

const permissions = {
  filesystem: { read: ['fixtures/tasks.json'], write: [] },
  network: { hosts: [], methods: [] },
  process: { commands: [] },
  environment: { keys: [] },
  secrets: { handles: [] }
}

const manifest = {
  schemaVersion: 1 as const,
  toolId: 'summarize-task-json',
  displayName: 'SummarizeTaskJson',
  description: 'Summarize a fixed project task fixture.',
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm' as const, version: '0.32.0' },
  entrypoint: 'source/tool.js',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'string' },
  errorContract: { type: 'object' },
  permissions,
  dependencies: [],
  limits: { timeoutMs: 3_000, maxInputBytes: 1024, maxOutputBytes: 4096, maxMemoryBytes: 16_000_000 }
}

const spec = {
  id: manifest.toolId,
  displayName: manifest.displayName,
  goal: 'Count tasks by status.',
  reason: 'No existing task summary tool.',
  requestedBy: { sessionId: 'session-1', runId: 'run-1', userMessageId: 'message-1' },
  scope: 'project' as const,
  projectId: 'project-1',
  inputContract: manifest.inputSchema,
  outputContract: manifest.outputSchema,
  permissions,
  acceptance: ['Returns deterministic counts.'],
  examples: [{ input: {}, expected: 'open: 4' }]
}

void test('GeneratedToolSpecSchema requires projectId for project scope', () => {
  assert.equal(GeneratedToolSpecSchema.safeParse(spec).success, true)
  const { projectId: _projectId, ...invalid } = spec
  assert.equal(GeneratedToolSpecSchema.safeParse(invalid).success, false)
})

void test('GeneratedToolManifestSchema rejects unsafe entrypoints and unknown fields', () => {
  assert.equal(GeneratedToolManifestSchema.safeParse(manifest).success, true)
  assert.equal(GeneratedToolManifestSchema.safeParse({ ...manifest, entrypoint: '../tool.js' }).success, false)
  assert.equal(GeneratedToolManifestSchema.safeParse({ ...manifest, extra: true }).success, false)
})

void test('ForgeJobSchema enforces terminal evidence and attempt budget', () => {
  const job = {
    id: 'job-1', idempotencyKey: 'idem-job-1',
    specHash: createHash('sha256').update(canonicalGeneratedToolJson(spec)).digest('hex'),
    toolId: manifest.toolId, mode: 'create' as const, status: 'completed' as const,
    revision: 1, spec, attempt: 1, maxAttempts: 3, createdAt: 1, updatedAt: 2,
    startedAt: 1, finishedAt: 2, artifactPath: 'tools/summarize-task-json/candidate-1',
    candidateId: 'candidate-1', candidateFingerprint: 'a'.repeat(64), attemptRecordId: 'attempt-1',
    validationRunId: 'validation-1', validationReportId: 'report-1'
  }
  assert.equal(ForgeJobSchema.safeParse(job).success, true)
  assert.equal(ForgeJobSchema.safeParse({ ...job, validationReportId: undefined }).success, false)
  assert.equal(ForgeJobSchema.safeParse({ ...job, attempt: 4 }).success, false)
  assert.equal(ForgeJobSchema.safeParse({ ...job, status: 'failed', error: undefined }).success, false)
  assert.equal(ForgeJobSchema.safeParse({ ...job, status: 'cancelled', finishedAt: undefined, validationReportId: undefined }).success, false)
})

void test('descriptor and version schemas enforce stable identity invariants', () => {
  const descriptor = {
    id: manifest.toolId, displayName: manifest.displayName, description: manifest.description,
    scope: 'project' as const, projectId: 'project-1', availability: 'available' as const,
    activeVersionId: 'version-1', lastStableVersionId: 'version-1', createdBy: 'joker' as const,
    permissionSummary: ['project read'], invocationCount: 0, createdAt: 1, updatedAt: 1
  }
  const version = {
    id: 'version-1', toolId: manifest.toolId, version: 1, fingerprint: 'a'.repeat(64),
    manifestHash: 'c'.repeat(64), sourceHash: 'b'.repeat(64), distHash: 'd'.repeat(64),
    manifest, artifactPath: 'tools/summarize-task-json/versions/v1',
    validationReportId: 'report-1', trustState: 'trusted' as const, createdAt: 1
  }
  assert.equal(GeneratedToolDescriptorSchema.safeParse(descriptor).success, true)
  assert.equal(GeneratedToolDescriptorSchema.safeParse({ ...descriptor, activeVersionId: undefined }).success, false)
  assert.equal(GeneratedToolDescriptorSchema.safeParse({ ...descriptor, scope: 'user', projectId: 'project-1' }).success, false)
  assert.equal(GeneratedToolDescriptorSchema.safeParse({ ...descriptor, updatedAt: 0 }).success, false)
  assert.equal(GeneratedToolVersionSchema.safeParse(version).success, true)
  assert.equal(GeneratedToolVersionSchema.safeParse({ ...version, manifest: { ...manifest, toolId: 'other' } }).success, false)
})

void test('passed validation reports require evidence for every check', () => {
  const report = {
    id: 'report-1', toolId: manifest.toolId, versionId: 'version-1', artifactFingerprint: 'a'.repeat(64),
    startedAt: 1, finishedAt: 2, status: 'passed' as const,
    checks: [{ id: 'schema-check', category: 'schema' as const, status: 'passed' as const, evidencePath: 'evidence/schema.json', message: 'valid' }],
    declaredPermissions: permissions, observedCapabilities: ['filesystem.read'], logsPath: 'logs/validator.log'
  }
  assert.equal(GeneratedToolValidationReportSchema.safeParse(report).success, true)
  assert.equal(GeneratedToolValidationReportSchema.safeParse({
    ...report,
    checks: [{ ...report.checks[0], evidencePath: undefined }]
  }).success, false)
})

void test('RuntimeQualificationReportSchema rejects unknown or inconsistent environments', () => {
  const environment = { status: 'incomplete' as const, startedAt: 1, finishedAt: 2, error: 'not run' }
  const identity = (path: string) => ({ path, size: 1, sha256: createHash('sha256').update(path).digest('hex') })
  const report = {
    schemaVersion: 2 as const,
    generatedAt: 2,
    level: 'L0' as const,
    artifactIdentity: {
      bundle: identity('out/main/index.js'),
      worker: identity('out/main/generated-tool-worker.js'),
      quickjsPackage: { ...identity('node_modules/quickjs-emscripten/package.json'), version: '0.32.0' },
      packageLock: identity('package-lock.json')
    },
    environments: {
      dev: { ...environment, environment: 'dev' as const },
      packaged: { ...environment, environment: 'packaged' as const }
    },
    candidates: [],
    limitations: ['No qualified runtime.']
  }
  assert.equal(RuntimeQualificationReportSchema.safeParse(report).success, true)
  assert.equal(RuntimeQualificationReportSchema.safeParse({
    ...report,
    environments: { ...report.environments, dev: { ...report.environments.dev, environment: 'packaged' } }
  }).success, false)
  assert.equal(RuntimeQualificationReportSchema.safeParse({ ...report, extra: true }).success, false)

  const qualifiedCandidate = {
    candidate: 'quickjs-wasm' as const,
    env: 'dev' as const,
    passesIsolation: true,
    cases: [
      'legit-execution', 'workspace-boundary', 'network-denied', 'subprocess-denied',
      'env-denied', 'timeout-cleanup', 'cancel-cleanup', 'ipc-registry-audit-isolation'
    ].map((id) => ({ id, status: 'pass' as const, details: id, evidence: identity(`evidence/${id}.json`) }))
  }
  assert.equal(RuntimeQualificationReportSchema.safeParse({
    ...report,
    environments: {
      ...report.environments,
      dev: { ...report.environments.dev, status: 'passed', error: undefined }
    },
    candidates: [qualifiedCandidate]
  }).success, true)
  assert.equal(RuntimeQualificationReportSchema.safeParse({
    ...report,
    candidates: [{ ...qualifiedCandidate, cases: qualifiedCandidate.cases.slice(1) }]
  }).success, false)
  assert.equal(RuntimeQualificationReportSchema.safeParse({
    ...report,
    candidates: [qualifiedCandidate, qualifiedCandidate]
  }).success, false)
  assert.equal(RuntimeQualificationReportSchema.safeParse({
    ...report,
    environments: {
      ...report.environments,
      dev: { ...report.environments.dev, startedAt: 3, finishedAt: 2 }
    }
  }).success, false)
})

void test('Gate 1.1 registry schema binds pointers, capability revision, and operation revisions', () => {
  const descriptor = {
    id: manifest.toolId, displayName: manifest.displayName, description: manifest.description,
    scope: 'project' as const, projectId: 'project-1', availability: 'available' as const,
    activeVersionId: 'version-1', lastStableVersionId: 'version-1', createdBy: 'joker' as const,
    permissionSummary: ['project read'], invocationCount: 0, createdAt: 1, updatedAt: 1
  }
  const state = {
    schemaVersion: 1 as const,
    registryId: 'registry-1',
    revision: 1,
    entries: [{ toolId: manifest.toolId, descriptor, versionIds: ['version-1'], validationReportIds: ['report-1'], updatedAt: 2 }],
    activePointers: [{ schemaVersion: 1 as const, toolId: manifest.toolId, revision: 1, activeVersionId: 'version-1', lastStableVersionId: 'version-1', updatedAt: 2 }],
    capabilityRevision: { schemaVersion: 1 as const, revision: 1, changedAt: 2, reason: 'tool-promoted' as const, toolIds: [manifest.toolId], operationId: 'operation-1' },
    operations: [{ operationId: 'operation-1', operationHash: 'a'.repeat(64), kind: 'promote', appliedRevision: 1, createdAt: 2 }]
  }
  assert.equal(GeneratedToolRegistryStateSchema.safeParse(state).success, true)
  assert.equal(GeneratedToolRegistryStateSchema.safeParse({ ...state, activePointers: [{ ...state.activePointers[0], activeVersionId: 'missing' }] }).success, false)
  assert.equal(GeneratedToolRegistryStateSchema.safeParse({ ...state, entries: [{ ...state.entries[0], descriptor: { ...descriptor, activeVersionId: undefined } }] }).success, false)
  assert.equal(GeneratedToolRegistryStateSchema.safeParse({ ...state, entries: [...state.entries, { ...state.entries[0], toolId: manifest.toolId.toUpperCase(), descriptor: { ...descriptor, id: manifest.toolId.toUpperCase() } }] }).success, false)
  assert.equal(GeneratedToolRegistryStateSchema.safeParse({ ...state, revision: 0 }).success, false)
  assert.equal(GeneratedToolRegistryStateSchema.safeParse({ ...state, revision: 2 }).success, false)
  assert.equal(CapabilityRevisionStateSchema.safeParse({ schemaVersion: 1, revision: 0, changedAt: 0, reason: 'initial', toolIds: [], operationId: 'initial' }).success, true)
  assert.equal(CapabilityRevisionStateSchema.safeParse({ schemaVersion: 1, revision: 0, changedAt: 1, reason: 'initial', toolIds: [], operationId: 'initial' }).success, false)
  assert.equal(CapabilityRevisionStateSchema.safeParse({ schemaVersion: 1, revision: 0, changedAt: 0, reason: 'tool-promoted', toolIds: [], operationId: 'op' }).success, false)
})

void test('Gate 1.1 invocation schema requires exact lifecycle evidence and monotonic timestamps', () => {
  const invocation = {
    schemaVersion: 1 as const, id: 'invocation-1', idempotencyKey: 'idem-1', requestHash: 'a'.repeat(64),
    toolId: manifest.toolId, versionId: 'version-1', fingerprint: 'b'.repeat(64), sessionId: 'session-1',
    runId: 'run-1', toolCallId: 'call-1', capabilityRevision: 3, status: 'finished' as const, revision: 3,
    proposedAt: 1, policyAt: 2, startedAt: 3, finishedAt: 4, policyDecision: 'allow' as const, outcome: 'succeeded' as const,
    outputHash: 'c'.repeat(64)
  }
  assert.equal(GeneratedToolInvocationSchema.safeParse(invocation).success, true)
  assert.equal(GeneratedToolInvocationSchema.safeParse({ ...invocation, startedAt: 1 }).success, false)
  assert.equal(GeneratedToolInvocationSchema.safeParse({ ...invocation, status: 'policy', revision: 1, startedAt: undefined, finishedAt: undefined, outcome: undefined, outputHash: 'c'.repeat(64) }).success, false)
  assert.equal(GeneratedToolInvocationSchema.safeParse({ ...invocation, policyDecision: 'deny', startedAt: undefined, outcome: 'cancelled' }).success, true)
  assert.equal(GeneratedToolInvocationSchema.safeParse({ ...invocation, policyDecision: 'deny', outcome: 'failed' }).success, false)
})

void test('Gate 1.1 continuation claims require positive revision keys and valid terminal linkage', () => {
  const claim = {
    schemaVersion: 1 as const, id: 'continuation-1', jobId: 'job-1', capabilityRevision: 1,
    sessionId: 'session-1', sourceRunId: 'run-1', status: 'claimed' as const, revision: 0, claimedAt: 1, updatedAt: 1
  }
  assert.equal(ToolForgeContinuationClaimSchema.safeParse(claim).success, true)
  assert.equal(ToolForgeContinuationClaimSchema.safeParse({ ...claim, capabilityRevision: 0 }).success, false)
  assert.equal(ToolForgeContinuationClaimSchema.safeParse({ ...claim, status: 'completed', continuationRunId: undefined }).success, false)
  assert.equal(ToolForgeContinuationClaimSchema.safeParse({ ...claim, status: 'completed', continuationRunId: 'run-2', revision: 1, updatedAt: 2 }).success, true)
  assert.equal(ToolForgeContinuationStateSchema.safeParse({ schemaVersion: 1, revision: 2, claims: [claim, { ...claim, id: claim.id, jobId: 'job-2', capabilityRevision: 2 }] }).success, false)
})

void test('canonicalGeneratedToolJson sorts object keys recursively', () => {
  assert.equal(
    canonicalGeneratedToolJson({ z: 1, a: { y: 2, b: 3 } }),
    '{"a":{"b":3,"y":2},"z":1}'
  )
})
