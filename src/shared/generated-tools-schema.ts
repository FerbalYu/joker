import { z } from 'zod'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_RELATIVE_PATH_PATTERN = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9._/@+-]+(?:[\\/][A-Za-z0-9._/@+-]+)*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_SCHEMA_DEPTH_BYTES = 256_000

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function jsonObjectSchema(maxBytes = MAX_SCHEMA_DEPTH_BYTES) {
  return z.record(z.string(), z.unknown()).superRefine((value, context) => {
    try {
      if (utf8ByteLength(JSON.stringify(value)) > maxBytes) {
        context.addIssue({ code: 'custom', message: `JSON object exceeds ${maxBytes} bytes` })
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'Value must be JSON serializable' })
    }
  })
}

const IdSchema = z.string().trim().regex(ID_PATTERN)
const RelativePathSchema = z.string().trim().min(1).max(512).regex(SAFE_RELATIVE_PATH_PATTERN)
const NonEmptyStringSchema = z.string().trim().min(1).max(8_000)
const UniqueStringsSchema = z.array(z.string().trim().min(1).max(512)).max(128)
  .refine((items) => new Set(items).size === items.length, 'items must be unique')

export const GeneratedToolNetworkMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
export const GeneratedToolScopeSchema = z.enum(['project', 'user'])
export const GeneratedToolRuntimeIdSchema = z.literal('quickjs-wasm')

export const GeneratedToolPermissionManifestSchema = z.object({
  filesystem: z.object({
    read: z.array(RelativePathSchema).max(128).refine((items) => new Set(items).size === items.length, 'read paths must be unique'),
    write: z.array(RelativePathSchema).max(128).refine((items) => new Set(items).size === items.length, 'write paths must be unique')
  }).strict(),
  network: z.object({
    hosts: UniqueStringsSchema,
    methods: z.array(GeneratedToolNetworkMethodSchema).max(5)
      .refine((items) => new Set(items).size === items.length, 'methods must be unique')
      .optional()
  }).strict(),
  process: z.object({ commands: UniqueStringsSchema }).strict(),
  environment: z.object({ keys: UniqueStringsSchema }).strict(),
  secrets: z.object({ handles: UniqueStringsSchema }).strict()
}).strict()

export const GeneratedToolManifestSchema = z.object({
  schemaVersion: z.literal(1),
  toolId: IdSchema,
  displayName: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2_000),
  sdkVersion: z.string().trim().min(1).max(64),
  runtime: z.object({
    id: GeneratedToolRuntimeIdSchema,
    version: z.string().trim().min(1).max(64)
  }).strict(),
  entrypoint: RelativePathSchema,
  inputSchema: jsonObjectSchema(),
  outputSchema: jsonObjectSchema(),
  errorContract: jsonObjectSchema(),
  permissions: GeneratedToolPermissionManifestSchema,
  dependencies: z.array(z.string().trim().min(1).max(160)).max(32)
    .refine((items) => new Set(items).size === items.length, 'dependencies must be unique'),
  limits: z.object({
    timeoutMs: z.number().int().min(10).max(120_000),
    maxInputBytes: z.number().int().min(1).max(10_000_000),
    maxOutputBytes: z.number().int().min(1).max(10_000_000),
    maxMemoryBytes: z.number().int().min(1_000_000).max(536_870_912)
  }).strict()
}).strict()

export const GeneratedToolSpecSchema = z.object({
  id: IdSchema,
  displayName: z.string().trim().min(1).max(160),
  goal: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
  requestedBy: z.object({
    sessionId: IdSchema,
    runId: IdSchema,
    userMessageId: IdSchema
  }).strict(),
  scope: GeneratedToolScopeSchema,
  projectId: IdSchema.optional(),
  inputContract: jsonObjectSchema(),
  outputContract: jsonObjectSchema(),
  permissions: GeneratedToolPermissionManifestSchema,
  acceptance: z.array(NonEmptyStringSchema).min(1).max(64),
  examples: z.array(z.object({
    input: jsonObjectSchema(),
    expected: z.string().max(64_000)
  }).strict()).min(1).max(32)
}).strict().superRefine((value, context) => {
  if (value.scope === 'project' && !value.projectId) {
    context.addIssue({ code: 'custom', path: ['projectId'], message: 'project scope requires projectId' })
  }
  if (value.scope === 'user' && value.projectId !== undefined) {
    context.addIssue({ code: 'custom', path: ['projectId'], message: 'user scope must not carry projectId' })
  }
})

export const ForgeJobStatusSchema = z.enum([
  'queued', 'planning', 'building', 'validating', 'awaiting-policy',
  'promoting', 'completed', 'failed', 'cancelled', 'interrupted'
])
export const ForgeJobModeSchema = z.enum(['create', 'edit', 'repair'])
export const GeneratedToolValidationProfileIdSchema = z.literal('gate2-project-read-v1')

export const ForgeJobSchema = z.object({
  id: IdSchema,
  idempotencyKey: z.string().trim().min(1).max(256),
  specHash: z.string().regex(SHA256_PATTERN),
  toolId: IdSchema,
  baseVersionId: IdSchema.optional(),
  baseFingerprint: z.string().regex(SHA256_PATTERN).optional(),
  mode: ForgeJobModeSchema,
  status: ForgeJobStatusSchema,
  revision: z.number().int().nonnegative(),
  spec: GeneratedToolSpecSchema,
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive().max(3),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  finishedAt: z.number().int().nonnegative().optional(),
  currentPhase: z.string().trim().min(1).max(160).optional(),
  artifactPath: RelativePathSchema,
  candidateId: IdSchema.optional(),
  candidateFingerprint: z.string().regex(SHA256_PATTERN).optional(),
  attemptRecordId: IdSchema.optional(),
  validationRunId: IdSchema.optional(),
  validationReportId: IdSchema.optional(),
  error: z.string().max(16_000).optional(),
  resumeHint: z.string().max(4_000).optional()
}).strict().superRefine((value, context) => {
  if (value.mode === 'edit' && (!value.baseVersionId || !value.baseFingerprint)) {
    context.addIssue({ code: 'custom', path: ['baseVersionId'], message: 'edit ForgeJob requires immutable base version identity' })
  }
  if (value.mode !== 'edit' && value.baseFingerprint !== undefined) {
    context.addIssue({ code: 'custom', path: ['baseFingerprint'], message: 'only edit ForgeJobs may carry a base fingerprint' })
  }
  if (value.attempt > value.maxAttempts) {
    context.addIssue({ code: 'custom', path: ['attempt'], message: 'attempt exceeds maxAttempts' })
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt precedes createdAt' })
  }
  if (value.finishedAt !== undefined && value.startedAt !== undefined && value.finishedAt < value.startedAt) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt precedes startedAt' })
  }
  const candidateFields = [value.candidateId, value.candidateFingerprint, value.attemptRecordId]
  if (candidateFields.some((item) => item !== undefined) && candidateFields.some((item) => item === undefined)) {
    context.addIssue({ code: 'custom', path: ['candidateId'], message: 'candidate identity fields must be attached together' })
  }
  if (value.validationRunId !== undefined && value.candidateId === undefined) {
    context.addIssue({ code: 'custom', path: ['validationRunId'], message: 'validation run requires a sealed candidate' })
  }
  if (value.validationReportId !== undefined && (value.candidateId === undefined || value.validationRunId === undefined)) {
    context.addIssue({ code: 'custom', path: ['validationReportId'], message: 'validation report requires candidate and validation run bindings' })
  }
  if (value.status === 'completed' && (value.finishedAt === undefined || value.validationReportId === undefined)) {
    context.addIssue({ code: 'custom', message: 'completed job requires finishedAt and validationReportId' })
  }
  if (value.validationReportId !== undefined && !['validating', 'awaiting-policy', 'promoting', 'completed', 'failed', 'interrupted'].includes(value.status)) {
    context.addIssue({ code: 'custom', path: ['validationReportId'], message: 'validation report is not valid for this job status' })
  }
  if (value.status === 'cancelled' && (value.candidateId !== undefined || value.validationRunId !== undefined || value.validationReportId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['candidateId'], message: 'cancelled job cannot retain active candidate or validation bindings' })
  }
  if (['failed', 'cancelled', 'interrupted', 'completed'].includes(value.status) && value.finishedAt === undefined) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'terminal job requires finishedAt' })
  }
  if (value.status === 'failed' && !value.error) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'failed job requires error evidence' })
  }
})

export const GeneratedToolCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  jobId: IdSchema,
  toolId: IdSchema,
  attempt: z.number().int().positive().max(3),
  attemptRecordId: IdSchema,
  artifactPath: RelativePathSchema,
  artifactFingerprint: z.string().regex(SHA256_PATTERN),
  manifestHash: z.string().regex(SHA256_PATTERN),
  sourceHash: z.string().regex(SHA256_PATTERN),
  distHash: z.string().regex(SHA256_PATTERN),
  manifest: GeneratedToolManifestSchema,
  specHash: z.string().regex(SHA256_PATTERN),
  validationProfile: GeneratedToolValidationProfileIdSchema,
  validationSuiteId: IdSchema,
  validationSuiteHash: z.string().regex(SHA256_PATTERN),
  createdAt: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  if (value.manifest.toolId !== value.toolId) {
    context.addIssue({ code: 'custom', path: ['manifest', 'toolId'], message: 'manifest toolId must match candidate toolId' })
  }
})

export const GeneratedToolForgeAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  jobId: IdSchema,
  toolId: IdSchema,
  attempt: z.number().int().positive().max(3),
  candidateId: IdSchema,
  candidateFingerprint: z.string().regex(SHA256_PATTERN),
  specHash: z.string().regex(SHA256_PATTERN),
  validationProfile: GeneratedToolValidationProfileIdSchema,
  validationSuiteId: IdSchema,
  validationSuiteHash: z.string().regex(SHA256_PATTERN),
  createdAt: z.number().int().nonnegative()
}).strict()

export const GeneratedToolAvailabilitySchema = z.enum([
  'available', 'building', 'validating', 'failed', 'disabled', 'changed', 'quarantined'
])

export const GeneratedToolDescriptorSchema = z.object({
  id: IdSchema,
  displayName: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2_000),
  scope: GeneratedToolScopeSchema,
  projectId: IdSchema.optional(),
  availability: GeneratedToolAvailabilitySchema,
  activeVersionId: IdSchema.optional(),
  lastStableVersionId: IdSchema.optional(),
  createdBy: z.literal('joker'),
  createdForSessionId: IdSchema.optional(),
  createdForRunId: IdSchema.optional(),
  permissionSummary: z.array(z.string().trim().min(1).max(512)).max(64),
  invocationCount: z.number().int().nonnegative(),
  lastInvokedAt: z.number().int().nonnegative().optional(),
  lastError: z.string().max(16_000).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  if (value.scope === 'project' && !value.projectId) {
    context.addIssue({ code: 'custom', path: ['projectId'], message: 'project scope requires projectId' })
  }
  if (value.scope === 'user' && value.projectId !== undefined) {
    context.addIssue({ code: 'custom', path: ['projectId'], message: 'user scope must not carry projectId' })
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt precedes createdAt' })
  }
  if (value.lastInvokedAt !== undefined && value.lastInvokedAt < value.createdAt) {
    context.addIssue({ code: 'custom', path: ['lastInvokedAt'], message: 'lastInvokedAt precedes createdAt' })
  }
  if (value.availability === 'available' && (!value.activeVersionId || !value.lastStableVersionId)) {
    context.addIssue({ code: 'custom', message: 'available tool requires active and stable versions' })
  }
})

export const GeneratedToolVersionTrustStateSchema = z.enum(['trusted', 'untrusted', 'changed'])
export const GeneratedToolVersionSchema = z.object({
  id: IdSchema,
  toolId: IdSchema,
  version: z.number().int().positive(),
  fingerprint: z.string().regex(SHA256_PATTERN),
  manifestHash: z.string().regex(SHA256_PATTERN),
  sourceHash: z.string().regex(SHA256_PATTERN),
  distHash: z.string().regex(SHA256_PATTERN),
  manifest: GeneratedToolManifestSchema,
  artifactPath: RelativePathSchema,
  validationReportId: IdSchema,
  trustState: GeneratedToolVersionTrustStateSchema,
  createdAt: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  if (value.manifest.toolId !== value.toolId) {
    context.addIssue({ code: 'custom', path: ['manifest', 'toolId'], message: 'manifest toolId must match version toolId' })
  }
})

export const ToolForgeOperationRecordSchema = z.object({
  operationId: IdSchema,
  operationHash: z.string().regex(SHA256_PATTERN),
  kind: z.string().trim().min(1).max(80),
  appliedRevision: z.number().int().positive(),
  createdAt: z.number().int().nonnegative()
}).strict()

export const GeneratedToolRegistryEntrySchema = z.object({
  toolId: IdSchema,
  descriptor: GeneratedToolDescriptorSchema,
  versionIds: z.array(IdSchema).max(10_000),
  validationReportIds: z.array(IdSchema).max(10_000),
  updatedAt: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  if (value.descriptor.id !== value.toolId) context.addIssue({ code: 'custom', path: ['descriptor', 'id'], message: 'descriptor id must match toolId' })
  if (new Set(value.versionIds).size !== value.versionIds.length) context.addIssue({ code: 'custom', path: ['versionIds'], message: 'version ids must be unique' })
  if (new Set(value.validationReportIds).size !== value.validationReportIds.length) context.addIssue({ code: 'custom', path: ['validationReportIds'], message: 'report ids must be unique' })
})

export const GeneratedToolRegistryStateSchema = z.object({
  schemaVersion: z.literal(1),
  registryId: IdSchema,
  revision: z.number().int().nonnegative(),
  entries: z.array(GeneratedToolRegistryEntrySchema).max(10_000),
  activePointers: z.array(z.lazy(() => GeneratedToolActivePointerSchema)).max(10_000),
  capabilityRevision: z.lazy(() => CapabilityRevisionStateSchema),
  operations: z.array(ToolForgeOperationRecordSchema).max(10_000)
}).strict().superRefine((value, context) => {
  if (new Set(value.entries.map((entry) => entry.toolId.toLocaleLowerCase('en-US'))).size !== value.entries.length) {
    context.addIssue({ code: 'custom', path: ['entries'], message: 'tool ids must be case-fold unique' })
  }
  if (new Set(value.activePointers.map((pointer) => pointer.toolId.toLocaleLowerCase('en-US'))).size !== value.activePointers.length) {
    context.addIssue({ code: 'custom', path: ['activePointers'], message: 'active pointer tool ids must be case-fold unique' })
  }
  if (value.activePointers.some((pointer) => {
    const entry = value.entries.find((candidate) => candidate.toolId === pointer.toolId)
    return !entry || (pointer.activeVersionId !== undefined && !entry.versionIds.includes(pointer.activeVersionId)) ||
      (pointer.lastStableVersionId !== undefined && !entry.versionIds.includes(pointer.lastStableVersionId))
  })) {
    context.addIssue({ code: 'custom', path: ['activePointers'], message: 'active pointer versions must exist in the matching registry entry' })
  }
  for (const entry of value.entries) {
    const pointer = value.activePointers.find((candidate) => candidate.toolId === entry.toolId)
    if (entry.descriptor.activeVersionId !== pointer?.activeVersionId || entry.descriptor.lastStableVersionId !== pointer?.lastStableVersionId) {
      context.addIssue({ code: 'custom', path: ['entries'], message: 'descriptor pointers must match the authoritative active pointer' })
      break
    }
    if (entry.descriptor.availability === 'available' && !pointer?.activeVersionId) {
      context.addIssue({ code: 'custom', path: ['entries'], message: 'available descriptor requires an active pointer' })
      break
    }
    if (entry.descriptor.availability === 'disabled' && pointer?.activeVersionId !== undefined) {
      context.addIssue({ code: 'custom', path: ['entries'], message: 'disabled descriptor cannot retain an active pointer' })
      break
    }
  }
  if (new Set(value.operations.map((record) => record.operationId)).size !== value.operations.length) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'operation ids must be unique' })
  }
  if (value.operations.some((record) => record.appliedRevision > value.revision)) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'operation revision exceeds registry revision' })
  }
  const operationRevisions = value.operations.map((record) => record.appliedRevision).sort((left, right) => left - right)
  if (operationRevisions.some((revision, index) => revision !== index + 1)) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'operation revisions must cover every registry revision exactly once' })
  }
  if (value.revision === 0 && value.operations.length > 0) context.addIssue({ code: 'custom', path: ['operations'], message: 'initial registry cannot contain operations' })
  if (value.revision > 0 && !value.operations.some((record) => record.appliedRevision === value.revision)) context.addIssue({ code: 'custom', path: ['operations'], message: 'registry revision must have a matching operation record' })
  if (value.capabilityRevision.revision > value.revision) context.addIssue({ code: 'custom', path: ['capabilityRevision'], message: 'capability revision cannot exceed registry revision' })
})

export const GeneratedToolActivePointerSchema = z.object({
  schemaVersion: z.literal(1),
  toolId: IdSchema,
  revision: z.number().int().nonnegative(),
  activeVersionId: IdSchema.optional(),
  lastStableVersionId: IdSchema.optional(),
  updatedAt: z.number().int().nonnegative()
}).strict()

export const CapabilityRevisionReasonSchema = z.enum(['initial', 'tool-promoted', 'tool-disabled', 'tool-rolled-back', 'tool-revalidated', 'tool-removed', 'mcp-refreshed'])
export const CapabilityRevisionStateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  changedAt: z.number().int().nonnegative(),
  reason: CapabilityRevisionReasonSchema,
  toolIds: z.array(IdSchema).max(10_000).refine((items) => new Set(items).size === items.length, 'tool ids must be unique'),
  operationId: IdSchema
}).strict().superRefine((value, context) => {
  const sorted = [...value.toolIds].sort((left, right) => left.localeCompare(right, 'en-US'))
  if (value.toolIds.some((toolId, index) => toolId !== sorted[index])) context.addIssue({ code: 'custom', path: ['toolIds'], message: 'tool ids must be sorted' })
  if (value.revision === 0 && (value.reason !== 'initial' || value.operationId !== 'initial' || value.changedAt !== 0 || value.toolIds.length !== 0)) context.addIssue({ code: 'custom', message: 'revision zero requires the empty initial capability record' })
  if (value.revision > 0 && value.reason === 'initial') context.addIssue({ code: 'custom', path: ['reason'], message: 'initial reason is only valid for revision zero' })
})

export const GeneratedToolInvocationStatusSchema = z.enum(['proposed', 'policy', 'started', 'finished'])
export const GeneratedToolInvocationOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled', 'timed-out'])
export const GeneratedToolInvocationSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  idempotencyKey: z.string().trim().min(1).max(256),
  requestHash: z.string().regex(SHA256_PATTERN),
  toolId: IdSchema,
  versionId: IdSchema,
  fingerprint: z.string().regex(SHA256_PATTERN),
  sessionId: IdSchema,
  runId: IdSchema,
  toolCallId: IdSchema,
  capabilityRevision: z.number().int().nonnegative(),
  status: GeneratedToolInvocationStatusSchema,
  revision: z.number().int().nonnegative(),
  proposedAt: z.number().int().nonnegative(),
  policyAt: z.number().int().nonnegative().optional(),
  startedAt: z.number().int().nonnegative().optional(),
  finishedAt: z.number().int().nonnegative().optional(),
  policyDecision: z.enum(['allow', 'ask', 'deny']).optional(),
  outcome: GeneratedToolInvocationOutcomeSchema.optional(),
  outputHash: z.string().regex(SHA256_PATTERN).optional(),
  error: z.string().max(16_000).optional()
}).strict().superRefine((value, context) => {
  const requiredRank = { proposed: 0, policy: 1, started: 2, finished: 3 }[value.status]
  if (requiredRank >= 1 && (value.policyAt === undefined || value.policyDecision === undefined)) context.addIssue({ code: 'custom', message: 'policy state requires decision and timestamp' })
  if (value.status === 'started' && value.startedAt === undefined) context.addIssue({ code: 'custom', message: 'started state requires startedAt' })
  if (value.status === 'proposed' && (value.policyAt !== undefined || value.policyDecision !== undefined || value.startedAt !== undefined || value.finishedAt !== undefined || value.outcome !== undefined || value.outputHash !== undefined || value.error !== undefined)) {
    context.addIssue({ code: 'custom', message: 'proposed state cannot carry later lifecycle evidence' })
  }
  if (value.status === 'policy' && (value.startedAt !== undefined || value.finishedAt !== undefined || value.outcome !== undefined || value.outputHash !== undefined || value.error !== undefined)) {
    context.addIssue({ code: 'custom', message: 'policy state cannot carry execution or terminal evidence' })
  }
  if (value.status === 'started' && (value.finishedAt !== undefined || value.outcome !== undefined || value.outputHash !== undefined || value.error !== undefined)) {
    context.addIssue({ code: 'custom', message: 'started state cannot carry terminal evidence' })
  }
  if (requiredRank >= 3 && (value.finishedAt === undefined || value.outcome === undefined)) context.addIssue({ code: 'custom', message: 'finished state requires outcome and finishedAt' })
  if (value.policyAt !== undefined && value.policyAt < value.proposedAt) context.addIssue({ code: 'custom', path: ['policyAt'], message: 'policyAt precedes proposedAt' })
  if (value.startedAt !== undefined && (value.policyAt === undefined || value.startedAt < value.policyAt)) context.addIssue({ code: 'custom', path: ['startedAt'], message: 'startedAt precedes policyAt' })
  if (value.finishedAt !== undefined && value.finishedAt < (value.startedAt ?? value.policyAt ?? value.proposedAt)) context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt precedes prior lifecycle state' })
  if (value.policyDecision === 'deny' && ((value.status !== 'policy' && value.status !== 'finished') || value.startedAt !== undefined || (value.status === 'finished' && value.outcome !== 'cancelled'))) context.addIssue({ code: 'custom', message: 'denied invocation must remain unstarted and finish cancelled' })
  if (value.status === 'finished' && value.policyDecision !== 'deny' && value.startedAt === undefined) context.addIssue({ code: 'custom', message: 'non-denied finished invocation must have started' })
})

export const GeneratedToolInvocationStateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  invocations: z.array(GeneratedToolInvocationSchema).max(100_000)
}).strict().superRefine((value, context) => {
  if (new Set(value.invocations.map((item) => item.id)).size !== value.invocations.length) context.addIssue({ code: 'custom', path: ['invocations'], message: 'invocation ids must be unique' })
  if (new Set(value.invocations.map((item) => item.idempotencyKey)).size !== value.invocations.length) context.addIssue({ code: 'custom', path: ['invocations'], message: 'idempotency keys must be unique' })
})

export const ToolForgeContinuationStatusSchema = z.enum(['claimed', 'completed', 'cancelled'])
export const ToolForgeContinuationClaimSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  jobId: IdSchema,
  capabilityRevision: z.number().int().positive(),
  sessionId: IdSchema,
  sourceRunId: IdSchema,
  continuationRunId: IdSchema.optional(),
  status: ToolForgeContinuationStatusSchema,
  revision: z.number().int().nonnegative(),
  claimedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  if (value.updatedAt < value.claimedAt) context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt precedes claimedAt' })
  if (value.status === 'claimed' && value.continuationRunId !== undefined) context.addIssue({ code: 'custom', path: ['continuationRunId'], message: 'claimed continuation cannot have a continuation run' })
  if (value.status === 'completed' && value.continuationRunId === undefined) context.addIssue({ code: 'custom', path: ['continuationRunId'], message: 'completed continuation requires a continuation run' })
  if (value.status === 'cancelled' && value.continuationRunId !== undefined) context.addIssue({ code: 'custom', path: ['continuationRunId'], message: 'cancelled continuation cannot have a continuation run' })
})

export const ToolForgeContinuationStateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  claims: z.array(ToolForgeContinuationClaimSchema).max(100_000)
}).strict().superRefine((value, context) => {
  if (new Set(value.claims.map((claim) => claim.id)).size !== value.claims.length) {
    context.addIssue({ code: 'custom', path: ['claims'], message: 'continuation ids must be unique' })
  }
  if (new Set(value.claims.map((claim) => `${claim.jobId}:${claim.capabilityRevision}`)).size !== value.claims.length) {
    context.addIssue({ code: 'custom', path: ['claims'], message: 'job and capability revision claims must be unique' })
  }
})

export const GeneratedToolPolicyOperationSchema = z.enum(['promote', 'execute'])
export const GeneratedToolPolicyActionSchema = z.enum(['allow', 'ask', 'deny'])
export const GeneratedToolPolicyReasonCodeSchema = z.enum([
  'runtime-l0',
  'runtime-l1-approval-required',
  'runtime-l2-project-read',
  'permission-profile-unsupported',
  'permission-profile-hard-deny',
  'validation-not-passed',
  'candidate-integrity-failed',
  'stale-registry-revision',
  'stale-base-version',
  'approval-required'
])
export const GeneratedToolPolicyInputSchema = z.object({
  schemaVersion: z.literal(1),
  operation: GeneratedToolPolicyOperationSchema,
  jobId: IdSchema,
  toolId: IdSchema,
  specHash: z.string().regex(SHA256_PATTERN),
  candidateId: IdSchema,
  candidateFingerprint: z.string().regex(SHA256_PATTERN),
  validationReportId: IdSchema,
  runtimeQualificationLevel: z.enum(['L2', 'L1', 'L0']),
  scope: GeneratedToolScopeSchema,
  projectId: IdSchema.optional(),
  permissions: GeneratedToolPermissionManifestSchema,
  baseVersionId: IdSchema.optional(),
  registryRevision: z.number().int().nonnegative(),
  capabilityRevision: z.number().int().nonnegative(),
  approvalMode: z.enum(['suggest', 'auto-edit', 'full-auto']),
  evaluatedAt: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  if (value.scope === 'project' && !value.projectId) context.addIssue({ code: 'custom', path: ['projectId'], message: 'project policy scope requires projectId' })
  if (value.scope === 'user' && value.projectId !== undefined) context.addIssue({ code: 'custom', path: ['projectId'], message: 'user policy scope must not carry projectId' })
})
export const GeneratedToolPolicyDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  action: GeneratedToolPolicyActionSchema,
  reasonCode: GeneratedToolPolicyReasonCodeSchema,
  reason: z.string().trim().min(1).max(4_000),
  policyVersion: z.string().trim().min(1).max(64),
  inputHash: z.string().regex(SHA256_PATTERN),
  evaluatedAt: z.number().int().nonnegative(),
  requiresApproval: z.boolean(),
  hardDeny: z.boolean()
}).strict().superRefine((value, context) => {
  if (value.action === 'allow' && (value.requiresApproval || value.hardDeny)) context.addIssue({ code: 'custom', message: 'allow decision cannot require approval or be hard denied' })
  if (value.action === 'deny' && !value.hardDeny && value.reasonCode !== 'approval-required') context.addIssue({ code: 'custom', message: 'deny decision must be hard denied unless approval is required' })
  if (value.action === 'ask' && value.hardDeny) context.addIssue({ code: 'custom', message: 'ask decision cannot be hard denied' })
})
export const GeneratedToolPromotionApprovalReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  promotionId: IdSchema,
  jobId: IdSchema,
  toolId: IdSchema,
  candidateId: IdSchema,
  candidateFingerprint: z.string().regex(SHA256_PATTERN),
  validationReportId: IdSchema,
  policyInputHash: z.string().regex(SHA256_PATTERN),
  windowId: z.number().int().positive(),
  sessionId: IdSchema,
  runId: IdSchema,
  approved: z.boolean(),
  approvalMode: z.enum(['suggest', 'auto-edit', 'full-auto']),
  approvedAt: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative()
}).strict()
export const GeneratedToolPromotionApprovalReceiptV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: IdSchema,
  promotionId: IdSchema,
  jobId: IdSchema,
  toolId: IdSchema,
  candidateId: IdSchema,
  candidateFingerprint: z.string().regex(SHA256_PATTERN),
  validationReportId: IdSchema,
  policyInputHash: z.string().regex(SHA256_PATTERN),
  requestId: IdSchema,
  requestHash: z.string().regex(SHA256_PATTERN),
  webContentsId: z.number().int().positive(),
  sessionId: IdSchema,
  runId: IdSchema,
  approvedAt: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative()
}).strict()
export const GeneratedToolPromotionApprovalReceiptSchema = z.discriminatedUnion('schemaVersion', [
  GeneratedToolPromotionApprovalReceiptV1Schema,
  GeneratedToolPromotionApprovalReceiptV2Schema
])
export const GeneratedToolPromotionJournalPhaseSchema = z.enum([
  'intent', 'policy-resolved', 'assembled', 'published', 'registered', 'pointer-switched', 'continuation-ready', 'completed', 'failed', 'interrupted'
])
export const GeneratedToolPromotionJournalSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  idempotencyKey: z.string().trim().min(1).max(256),
  jobId: IdSchema,
  jobRevision: z.number().int().nonnegative(),
  toolId: IdSchema,
  candidateId: IdSchema,
  candidateFingerprint: z.string().regex(SHA256_PATTERN),
  validationReportId: IdSchema,
  policy: GeneratedToolPolicyDecisionSchema,
  approvalReceiptId: IdSchema.optional(),
  registryId: IdSchema,
  registryRevision: z.number().int().nonnegative(),
  versionId: IdSchema.optional(),
  versionNumber: z.number().int().positive().optional(),
  registerOperationId: IdSchema,
  promoteOperationId: IdSchema,
  phase: GeneratedToolPromotionJournalPhaseSchema,
  revision: z.number().int().nonnegative(),
  capabilityRevision: z.number().int().nonnegative().optional(),
  error: z.string().max(16_000).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  if (value.revision < 0) context.addIssue({ code: 'custom', path: ['revision'], message: 'journal revision must be nonnegative' })
  if (value.updatedAt < value.createdAt) context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'journal updatedAt precedes createdAt' })
  if (['assembled', 'published', 'registered', 'pointer-switched', 'continuation-ready', 'completed'].includes(value.phase) && (!value.versionId || value.versionNumber === undefined)) context.addIssue({ code: 'custom', message: 'published promotion phase requires version identity' })
  if (['pointer-switched', 'continuation-ready', 'completed'].includes(value.phase) && value.capabilityRevision === undefined) context.addIssue({ code: 'custom', path: ['capabilityRevision'], message: 'pointer-switched promotion requires capability revision' })
  if (['failed', 'interrupted'].includes(value.phase) && !value.error) context.addIssue({ code: 'custom', path: ['error'], message: 'terminal promotion failure requires error' })
})
export const ToolForgeContinuationV2StatusSchema = z.enum(['ready', 'dispatched', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
export const ToolForgeContinuationV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: IdSchema,
  jobId: IdSchema,
  toolId: IdSchema,
  versionId: IdSchema,
  fingerprint: z.string().regex(SHA256_PATTERN),
  validationReportId: IdSchema,
  sessionId: IdSchema,
  sourceRunId: IdSchema,
  sourceUserMessageId: IdSchema,
  specHash: z.string().regex(SHA256_PATTERN),
  fromCapabilityRevision: z.number().int().nonnegative(),
  toCapabilityRevision: z.number().int().positive(),
  userIntentRevision: z.number().int().nonnegative(),
  status: ToolForgeContinuationV2StatusSchema,
  request: z.object({
    reasoningLevel: z.string().trim().min(1).max(32),
    runMode: z.enum(['chat', 'research']),
    projectId: IdSchema.optional(),
    skillIds: z.array(IdSchema).max(64).optional()
  }).strict(),
  continuationRunId: IdSchema.optional(),
  queueItemId: IdSchema.optional(),
  attempt: z.number().int().positive().max(3),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  finishedAt: z.number().int().nonnegative().optional(),
  error: z.string().max(16_000).optional()
}).strict().superRefine((value, context) => {
  if (value.toCapabilityRevision <= value.fromCapabilityRevision) context.addIssue({ code: 'custom', path: ['toCapabilityRevision'], message: 'continuation capability revision must advance' })
  if (value.updatedAt < value.createdAt) context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'continuation updatedAt precedes createdAt' })
  if (['dispatched', 'running', 'completed'].includes(value.status) && !value.continuationRunId) context.addIssue({ code: 'custom', path: ['continuationRunId'], message: 'dispatched continuation requires run id' })
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status) && value.finishedAt === undefined) context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'terminal continuation requires finishedAt' })
  if (['failed', 'interrupted'].includes(value.status) && !value.error) context.addIssue({ code: 'custom', path: ['error'], message: 'failed continuation requires error' })
  if (value.status === 'cancelled' && value.error === undefined) context.addIssue({ code: 'custom', path: ['error'], message: 'cancelled continuation requires cancellation reason' })
})

export const GeneratedToolValidationCheckCategorySchema = z.enum([
  'schema', 'build', 'unit', 'contract', 'permission', 'timeout', 'recovery', 'audit'
])
export const GeneratedToolValidationCheckStatusSchema = z.enum(['passed', 'failed', 'skipped'])
export const GeneratedToolValidationCheckSchema = z.object({
  id: IdSchema,
  category: GeneratedToolValidationCheckCategorySchema,
  status: GeneratedToolValidationCheckStatusSchema,
  evidencePath: RelativePathSchema.optional(),
  evidenceHash: z.string().regex(SHA256_PATTERN).optional(),
  message: z.string().trim().min(1).max(8_000)
}).strict()
export const GeneratedToolValidationReportStatusSchema = z.enum(['passed', 'failed', 'quarantined'])
export const GeneratedToolValidationReportSchema = z.object({
  id: IdSchema,
  toolId: IdSchema,
  versionId: IdSchema,
  artifactFingerprint: z.string().regex(SHA256_PATTERN),
  validationProfile: GeneratedToolValidationProfileIdSchema.optional(),
  jobId: IdSchema.optional(),
  attempt: z.number().int().positive().max(3).optional(),
  validationRunId: IdSchema.optional(),
  validationSuiteId: IdSchema.optional(),
  validationSuiteHash: z.string().regex(SHA256_PATTERN).optional(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  status: GeneratedToolValidationReportStatusSchema,
  checks: z.array(GeneratedToolValidationCheckSchema).min(1).max(256),
  declaredPermissions: GeneratedToolPermissionManifestSchema,
  observedCapabilities: z.array(z.string().trim().min(1).max(256)).max(128),
  logsPath: RelativePathSchema,
  logsHash: z.string().regex(SHA256_PATTERN).optional()
}).strict().superRefine((value, context) => {
  const gate2Fields = [value.validationProfile, value.jobId, value.attempt, value.validationRunId, value.validationSuiteId, value.validationSuiteHash]
  if (gate2Fields.some((item) => item !== undefined) && gate2Fields.some((item) => item === undefined)) {
    context.addIssue({ code: 'custom', path: ['validationProfile'], message: 'Gate 2 validation identity fields must be attached together' })
  }
  if (value.finishedAt < value.startedAt) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt precedes startedAt' })
  }
  if (new Set(value.checks.map((check) => check.id)).size !== value.checks.length) {
    context.addIssue({ code: 'custom', path: ['checks'], message: 'validation check ids must be unique' })
  }
  if (value.validationProfile && (value.checks.some((check) => !check.evidencePath || !check.evidenceHash) || !value.logsHash)) {
    context.addIssue({ code: 'custom', path: ['checks'], message: 'Gate 2 report requires evidence and log hashes' })
  }
  if (value.status === 'passed' && value.checks.some((check) => check.status !== 'passed' || !check.evidencePath)) {
    context.addIssue({ code: 'custom', path: ['checks'], message: 'passed report requires every check to pass with evidence' })
  }
})

export const RuntimeQualificationLevelSchema = z.enum(['L2', 'L1', 'L0'])
export const RuntimeQualificationCandidateIdSchema = z.enum(['quickjs-wasm', 'node-vm', 'child-process'])
export const RuntimeQualificationEnvironmentSchema = z.enum(['dev', 'packaged'])
export const RuntimeQualificationCaseStatusSchema = z.enum(['pass', 'fail', 'inconclusive', 'skipped'])
export const RuntimeQualificationCaseIdSchema = z.enum([
  'legit-execution', 'workspace-boundary', 'network-denied', 'subprocess-denied',
  'env-denied', 'timeout-cleanup', 'cancel-cleanup', 'ipc-registry-audit-isolation',
  'packaged-equivalence'
])

export const RuntimeQualificationFileIdentitySchema = z.object({
  path: RelativePathSchema,
  size: z.number().int().positive(),
  sha256: z.string().regex(SHA256_PATTERN)
}).strict()

export const RuntimeQualificationCaseResultSchema = z.object({
  id: RuntimeQualificationCaseIdSchema,
  status: RuntimeQualificationCaseStatusSchema,
  details: z.string().trim().min(1).max(16_000),
  evidence: RuntimeQualificationFileIdentitySchema.optional()
}).strict()
export const RuntimeQualificationCandidateResultSchema = z.object({
  candidate: RuntimeQualificationCandidateIdSchema,
  env: RuntimeQualificationEnvironmentSchema,
  passesIsolation: z.boolean(),
  cases: z.array(RuntimeQualificationCaseResultSchema).max(64),
  error: z.string().max(16_000).optional()
}).strict().superRefine((value, context) => {
  const ids = value.cases.map((item) => item.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['cases'], message: 'qualification case ids must be unique per candidate' })
  }
  if (value.passesIsolation) {
    const mandatory = [
      'legit-execution', 'workspace-boundary', 'network-denied', 'subprocess-denied',
      'env-denied', 'timeout-cleanup', 'cancel-cleanup', 'ipc-registry-audit-isolation'
    ]
    if (value.env === 'packaged') mandatory.push('packaged-equivalence')
    const byId = new Map(value.cases.map((item) => [item.id, item]))
    if (value.error || mandatory.some((id) => {
      const item = byId.get(id as z.infer<typeof RuntimeQualificationCaseIdSchema>)
      return !item || item.status !== 'pass' || !item.evidence
    })) {
      context.addIssue({ code: 'custom', path: ['passesIsolation'], message: 'qualified candidate requires every applicable case to pass with evidence and no error' })
    }
  }
})
export const RuntimeQualificationEnvironmentResultSchema = z.object({
  environment: RuntimeQualificationEnvironmentSchema,
  status: z.enum(['passed', 'failed', 'incomplete']),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  error: z.string().max(16_000).optional()
}).strict().superRefine((value, context) => {
  if (value.finishedAt < value.startedAt) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt precedes startedAt' })
  }
  if (value.status === 'passed' && value.error) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'passed environment cannot carry an error' })
  }
})
export const RuntimeQualificationArtifactIdentitySchema = z.object({
  bundle: RuntimeQualificationFileIdentitySchema,
  worker: RuntimeQualificationFileIdentitySchema,
  quickjsPackage: RuntimeQualificationFileIdentitySchema.extend({
    version: z.string().trim().min(1).max(64)
  }).strict(),
  packageLock: RuntimeQualificationFileIdentitySchema,
  packaged: z.object({
    executable: RuntimeQualificationFileIdentitySchema,
    appAsar: RuntimeQualificationFileIdentitySchema
  }).strict().optional()
}).strict()

export const RuntimeQualificationReportSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.number().int().nonnegative(),
  level: RuntimeQualificationLevelSchema,
  artifactIdentity: RuntimeQualificationArtifactIdentitySchema,
  environments: z.object({
    dev: RuntimeQualificationEnvironmentResultSchema.refine((item) => item.environment === 'dev', 'dev environment mismatch'),
    packaged: RuntimeQualificationEnvironmentResultSchema.refine((item) => item.environment === 'packaged', 'packaged environment mismatch')
  }).strict(),
  candidates: z.array(RuntimeQualificationCandidateResultSchema).max(32)
    .refine(
      (items) => new Set(items.map((item) => `${item.candidate}:${item.env}`)).size === items.length,
      'candidate/environment rows must be unique'
    ),
  limitations: z.array(z.string().trim().min(1).max(4_000)).max(64)
}).strict()

export function parseGeneratedToolPolicyInput(value: unknown) {
  return GeneratedToolPolicyInputSchema.parse(value)
}

export function parseGeneratedToolPolicyDecision(value: unknown) {
  return GeneratedToolPolicyDecisionSchema.parse(value)
}

export function parseGeneratedToolPromotionApprovalReceipt(value: unknown) {
  return GeneratedToolPromotionApprovalReceiptSchema.parse(value)
}

export function parseGeneratedToolPromotionJournal(value: unknown) {
  return GeneratedToolPromotionJournalSchema.parse(value)
}

export function parseToolForgeContinuationV2(value: unknown) {
  return ToolForgeContinuationV2Schema.parse(value)
}

export function parseGeneratedToolManifest(value: unknown) {
  return GeneratedToolManifestSchema.parse(value)
}

export function parseGeneratedToolSpec(value: unknown) {
  return GeneratedToolSpecSchema.parse(value)
}

export function parseForgeJob(value: unknown) {
  return ForgeJobSchema.parse(value)
}

export function parseGeneratedToolCandidate(value: unknown) {
  return GeneratedToolCandidateSchema.parse(value)
}

export function parseGeneratedToolForgeAttempt(value: unknown) {
  return GeneratedToolForgeAttemptSchema.parse(value)
}

export function parseGeneratedToolDescriptor(value: unknown) {
  return GeneratedToolDescriptorSchema.parse(value)
}

export function parseGeneratedToolVersion(value: unknown) {
  return GeneratedToolVersionSchema.parse(value)
}

export function parseGeneratedToolRegistryState(value: unknown) {
  return GeneratedToolRegistryStateSchema.parse(value)
}

export function parseGeneratedToolActivePointer(value: unknown) {
  return GeneratedToolActivePointerSchema.parse(value)
}

export function parseCapabilityRevisionState(value: unknown) {
  return CapabilityRevisionStateSchema.parse(value)
}

export function parseGeneratedToolInvocationState(value: unknown) {
  return GeneratedToolInvocationStateSchema.parse(value)
}

export function parseToolForgeContinuationState(value: unknown) {
  return ToolForgeContinuationStateSchema.parse(value)
}

export function parseGeneratedToolValidationReport(value: unknown) {
  return GeneratedToolValidationReportSchema.parse(value)
}

export function parseRuntimeQualificationReport(value: unknown) {
  return RuntimeQualificationReportSchema.parse(value)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    )
  }
  return value
}

export function canonicalGeneratedToolJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}
