import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'

import type {
  ForgeJob,
  ForgeJobStatus,
  GeneratedToolAvailability,
  GeneratedToolDescriptor,
  GeneratedToolManifest,
  GeneratedToolSpec,
  GeneratedToolValidationCheckCategory,
  GeneratedToolValidationReport,
  GeneratedToolVersion,
  RuntimeQualificationLevel
} from '../../shared/generated-tools'
import {
  ForgeJobSchema,
  GeneratedToolDescriptorSchema,
  GeneratedToolManifestSchema,
  GeneratedToolSpecSchema,
  GeneratedToolValidationReportSchema,
  GeneratedToolVersionSchema,
  canonicalGeneratedToolJson
} from '../../shared/generated-tools-schema'

/**
 * Contract freeze tests (TOOL-FORGE-PLAN.md P0): canonical instances of every
 * ToolForge contract must satisfy the documented invariants, and the string
 * literal unions must keep their exact frozen membership. Any change to these
 * shapes is a deliberate contract revision and must update this file.
 */

const canonicalSpec: GeneratedToolSpec = {
  id: 'summarize-task-json',
  displayName: 'SummarizeTaskJson',
  goal: '统计当前项目 fixtures/tasks.json 中各状态的任务数量，并按数量排序',
  reason: '现有工具缺少对项目内结构化任务数据的统计能力',
  requestedBy: { sessionId: 'sess_canonical', runId: 'run_canonical', userMessageId: 'msg_canonical' },
  scope: 'project',
  projectId: 'project-canonical',
  inputContract: {},
  outputContract: {},
  permissions: {
    filesystem: { read: ['fixtures/tasks.json'], write: [] },
    network: { hosts: [] },
    process: { commands: [] },
    environment: { keys: [] },
    secrets: { handles: [] }
  },
  acceptance: ['读取 workspace 内 fixtures/tasks.json', '按 status 分组计数并按数量降序输出', '文件缺失或 JSON 非法时报错'],
  examples: [{ input: {}, expected: 'open: 4\ndone: 3\nin_progress: 2' }]
}

const canonicalManifest: GeneratedToolManifest = {
  schemaVersion: 1,
  toolId: 'summarize-task-json',
  displayName: 'SummarizeTaskJson',
  description: '读取项目内固定格式任务 JSON 并输出状态统计',
  sdkVersion: '1.0.0',
  runtime: { id: 'quickjs-wasm', version: '0.32.0' },
  entrypoint: 'source/tool.js',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'string' },
  errorContract: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  permissions: canonicalSpec.permissions,
  dependencies: [],
  limits: {
    timeoutMs: 3_000,
    maxInputBytes: 16_384,
    maxOutputBytes: 65_536,
    maxMemoryBytes: 33_554_432
  }
}

const canonicalJob: ForgeJob = {
  id: 'job_canonical',
  idempotencyKey: 'idem-job-canonical',
  specHash: createHash('sha256').update(canonicalGeneratedToolJson(canonicalSpec)).digest('hex'),
  toolId: 'summarize-task-json',
  mode: 'create',
  status: 'completed',
  revision: 1,
  spec: canonicalSpec,
  attempt: 1,
  maxAttempts: 3,
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  finishedAt: 2,
  artifactPath: 'tools/summarize-task-json/versions/v1',
  candidateId: 'candidate-canonical',
  candidateFingerprint: 'a'.repeat(64),
  attemptRecordId: 'attempt-canonical',
  validationRunId: 'validation-canonical',
  validationReportId: 'report_canonical'
}

const canonicalDescriptor: GeneratedToolDescriptor = {
  id: 'summarize-task-json',
  displayName: 'SummarizeTaskJson',
  description: '读取项目内固定格式任务 JSON 并输出状态统计',
  scope: 'project',
  projectId: 'project-canonical',
  availability: 'available',
  activeVersionId: 'v1',
  lastStableVersionId: 'v1',
  createdBy: 'joker',
  createdForSessionId: 'sess_canonical',
  createdForRunId: 'run_canonical',
  permissionSummary: ['项目只读'],
  invocationCount: 18,
  lastInvokedAt: 3,
  createdAt: 1,
  updatedAt: 2
}

const canonicalVersion: GeneratedToolVersion = {
  id: 'v1',
  toolId: 'summarize-task-json',
  version: 1,
  fingerprint: 'a'.repeat(64),
  manifestHash: 'c'.repeat(64),
  sourceHash: 'b'.repeat(64),
  distHash: 'd'.repeat(64),
  manifest: canonicalManifest,
  artifactPath: 'tools/summarize-task-json/versions/v1',
  validationReportId: 'report_canonical',
  trustState: 'trusted',
  createdAt: 1
}

const canonicalValidationReport: GeneratedToolValidationReport = {
  id: 'report_canonical',
  toolId: 'summarize-task-json',
  versionId: 'v1',
  artifactFingerprint: 'a'.repeat(64),
  startedAt: 1,
  finishedAt: 2,
  status: 'passed',
  checks: [
    { id: 'manifest-schema', category: 'schema', status: 'passed', evidencePath: 'evidence/manifest-schema.json', message: 'manifest matches spec permissions' },
    { id: 'workspace-boundary', category: 'permission', status: 'passed', evidencePath: 'evidence/workspace.json', message: 'out-of-workspace read denied' }
  ],
  declaredPermissions: canonicalSpec.permissions,
  observedCapabilities: ['filesystem.read'],
  logsPath: 'logs/validate-v1.log'
}

void test('runtime contract schemas accept the canonical ToolForge records', () => {
  assert.equal(GeneratedToolSpecSchema.safeParse(canonicalSpec).success, true)
  assert.equal(GeneratedToolManifestSchema.safeParse(canonicalManifest).success, true)
  assert.equal(ForgeJobSchema.safeParse(canonicalJob).success, true)
  assert.equal(GeneratedToolDescriptorSchema.safeParse(canonicalDescriptor).success, true)
  assert.equal(GeneratedToolVersionSchema.safeParse(canonicalVersion).success, true)
  assert.equal(GeneratedToolValidationReportSchema.safeParse(canonicalValidationReport).success, true)
})

void test('runtime contract schemas reject unknown fields and cross-record mismatches', () => {
  assert.equal(GeneratedToolManifestSchema.safeParse({ ...canonicalManifest, extra: true }).success, false)
  const { projectId: _projectId, ...missingProjectSpec } = canonicalSpec
  assert.equal(GeneratedToolSpecSchema.safeParse(missingProjectSpec).success, false)
  assert.equal(GeneratedToolVersionSchema.safeParse({
    ...canonicalVersion,
    manifest: { ...canonicalManifest, toolId: 'another-tool' }
  }).success, false)
  assert.equal(ForgeJobSchema.safeParse({ ...canonicalJob, attempt: canonicalJob.maxAttempts + 1 }).success, false)
})

void test('canonicalGeneratedToolJson is stable across object key order', () => {
  const left = canonicalGeneratedToolJson({ b: 2, a: { d: 4, c: 3 } })
  const right = canonicalGeneratedToolJson({ a: { c: 3, d: 4 }, b: 2 })
  assert.equal(left, right)
  assert.equal(left, '{"a":{"c":3,"d":4},"b":2}')
})

void test('contract freeze: ForgeJobStatus union keeps exact membership', () => {
  assert.deepEqual(
    [...new Set<ForgeJobStatus>(['queued', 'planning', 'building', 'validating', 'awaiting-policy', 'promoting', 'completed', 'failed', 'cancelled', 'interrupted'])].sort(),
    ['awaiting-policy', 'building', 'cancelled', 'completed', 'failed', 'interrupted', 'planning', 'promoting', 'queued', 'validating']
  )
})

void test('contract freeze: GeneratedToolAvailability union keeps exact membership', () => {
  assert.deepEqual(
    [...new Set<GeneratedToolAvailability>(['available', 'building', 'validating', 'failed', 'disabled', 'changed', 'quarantined'])].sort(),
    ['available', 'building', 'changed', 'disabled', 'failed', 'quarantined', 'validating']
  )
})

void test('contract freeze: validation check categories keep exact membership', () => {
  assert.deepEqual(
    [...new Set<GeneratedToolValidationCheckCategory>(['schema', 'build', 'unit', 'contract', 'permission', 'timeout', 'recovery', 'audit'])].sort(),
    ['audit', 'build', 'contract', 'permission', 'recovery', 'schema', 'timeout', 'unit']
  )
})

void test('contract freeze: runtime qualification levels keep exact membership', () => {
  assert.deepEqual(
    [...new Set<RuntimeQualificationLevel>(['L2', 'L1', 'L0'])].sort(),
    ['L0', 'L1', 'L2']
  )
})

void test('contract freeze: canonical spec carries a precise permission manifest', () => {
  assert.deepEqual(canonicalSpec.permissions.filesystem, { read: ['fixtures/tasks.json'], write: [] })
  assert.deepEqual(canonicalSpec.permissions.network.hosts, [])
  assert.deepEqual(canonicalSpec.permissions.process.commands, [])
  assert.deepEqual(canonicalSpec.permissions.environment.keys, [])
  assert.deepEqual(canonicalSpec.permissions.secrets.handles, [])
  assert.equal(canonicalSpec.scope, 'project')
})

void test('contract freeze: completed job carries finishedAt and validationReportId', () => {
  assert.equal(canonicalJob.status, 'completed')
  assert.ok(canonicalJob.finishedAt !== undefined)
  assert.ok(canonicalJob.validationReportId !== undefined)
  assert.ok(canonicalJob.startedAt !== undefined)
  assert.ok(canonicalJob.finishedAt >= canonicalJob.startedAt)
})

void test('contract freeze: passed validation report has no failed or unexplained skipped checks', () => {
  assert.equal(canonicalValidationReport.status, 'passed')
  assert.ok(canonicalValidationReport.artifactFingerprint.length >= 32)
  for (const check of canonicalValidationReport.checks) {
    assert.notEqual(check.status, 'failed')
    if (check.status === 'skipped') {
      assert.ok(check.message.trim().length > 0, 'skipped checks must carry a reason')
    }
  }
  assert.ok(canonicalValidationReport.finishedAt >= canonicalValidationReport.startedAt)
})

void test('contract freeze: available descriptor carries the active stable version', () => {
  assert.equal(canonicalDescriptor.availability, 'available')
  assert.ok(canonicalDescriptor.activeVersionId !== undefined)
  assert.equal(canonicalDescriptor.activeVersionId, canonicalDescriptor.lastStableVersionId)
  assert.equal(canonicalDescriptor.createdBy, 'joker')
  assert.ok(Array.isArray(canonicalDescriptor.permissionSummary) && canonicalDescriptor.permissionSummary.length > 0)
})

void test('contract freeze: active version is immutable and trusted', () => {
  assert.equal(canonicalVersion.trustState, 'trusted')
  assert.equal(canonicalVersion.fingerprint, canonicalValidationReport.artifactFingerprint)
  assert.ok(canonicalVersion.sourceHash.length >= 32)
  assert.equal(canonicalVersion.validationReportId, canonicalValidationReport.id)
})
