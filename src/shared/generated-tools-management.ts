import { z } from 'zod'

import type {
  ForgeJobMode,
  ForgeJobStatus,
  GeneratedToolAvailability,
  GeneratedToolInvocationOutcome,
  GeneratedToolInvocationStatus,
  GeneratedToolManifest,
  GeneratedToolPermissionManifest,
  GeneratedToolScope,
  GeneratedToolValidationCheckCategory,
  GeneratedToolValidationCheckStatus,
  GeneratedToolValidationReportStatus,
  GeneratedToolVersionTrustState,
  RuntimeQualificationCaseId,
  RuntimeQualificationCaseStatus,
  RuntimeQualificationLevel
} from './generated-tools'

const ToolForgeIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)

export const GeneratedToolRevalidateInputSchema = z.object({
  toolId: ToolForgeIdSchema,
  versionId: ToolForgeIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  operationId: ToolForgeIdSchema
}).strict()

export interface GeneratedToolRevalidateInput {
  toolId: string
  versionId: string
  expectedRevision: number
  operationId: string
}

export type GeneratedToolRevalidateResult = GeneratedToolsReadResult<{
  toolId: string
  versionId: string
  action: 'revalidated' | 'already-active'
  registryRevision: number
  capabilityRevision: number
  activeVersionId?: string
  reason: string
}>

export function parseGeneratedToolRevalidateInput(value: unknown): GeneratedToolRevalidateInput {
  return GeneratedToolRevalidateInputSchema.parse(value)
}

export const GeneratedToolEnableInputSchema = z.object({
  jobId: ToolForgeIdSchema
}).strict()

export const GeneratedToolEditRequestSchema = z.object({
  toolId: ToolForgeIdSchema,
  baseVersionId: ToolForgeIdSchema,
  baseFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  instruction: z.string().trim().min(1).max(8_000),
  requestedFrom: z.enum(['settings', 'conversation'])
}).strict()

export interface GeneratedToolEditRequest {
  toolId: string
  baseVersionId: string
  baseFingerprint: string
  instruction: string
  requestedFrom: 'settings' | 'conversation'
}

export type GeneratedToolEditResult = GeneratedToolsReadResult<{
  jobId: string
  toolId: string
  baseVersionId: string
  baseFingerprint: string
  status: ForgeJobStatus
  revision: number
  originalTaskComplete: false
}>

export function parseGeneratedToolEditRequest(value: unknown): GeneratedToolEditRequest {
  return GeneratedToolEditRequestSchema.parse(value)
}

export interface GeneratedToolEnableInput {
  jobId: string
}

export type GeneratedToolEnableResult = GeneratedToolsReadResult<{
  jobId: string
  toolId: string
  status: ForgeJobStatus
  action: 'enabled' | 'permission-required' | 'denied'
  reason: string
  originalTaskComplete: false
}>

export interface GeneratedToolContinuationView {
  id: string
  jobId: string
  toolId: string
  versionId: string
  fingerprint: string
  sessionId: string
  sourceRunId: string
  continuationRunId?: string
  fromCapabilityRevision: number
  toCapabilityRevision: number
  status: import('./generated-tools').ToolForgeContinuationV2Status
  attempt: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
}

export type GeneratedToolContinuationListResult = GeneratedToolsReadResult<GeneratedToolContinuationView[]>

export interface GeneratedToolGetInput {
  toolId: string
}

export const GeneratedToolJobStatusInputSchema = z.object({
  jobId: ToolForgeIdSchema
}).strict()

export interface GeneratedToolJobStatusInput {
  jobId: string
}

export interface GeneratedToolJobStatusView {
  jobId: string
  toolId: string
  mode: ForgeJobMode
  status: ForgeJobStatus
  jobRevision: number
  attempt: number
  maxAttempts: number
  currentPhase?: string
  candidateId?: string
  candidateFingerprint?: string
  validationReportId?: string
  error?: string
  resumeHint?: string
  requiresApproval?: boolean
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  registryRevision: number
  capabilityRevision: number
  originalTaskComplete: false
}

export type GeneratedToolJobStatusResult = GeneratedToolsReadResult<GeneratedToolJobStatusView>

export function parseGeneratedToolEnableInput(value: unknown): GeneratedToolEnableInput {
  return GeneratedToolEnableInputSchema.parse(value)
}


export const GeneratedToolGetInputSchema = z.object({
  toolId: ToolForgeIdSchema
}).strict()

export type GeneratedToolsReadErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'corrupt-state'
  | 'read-failed'

export interface GeneratedToolsReadError {
  code: GeneratedToolsReadErrorCode
  message: string
}

export type GeneratedToolsReadResult<T> =
  | { success: true; data: T }
  | { success: false; error: GeneratedToolsReadError }

export type GeneratedToolEffectiveAvailability = GeneratedToolAvailability | 'missing' | 'permission-required'
export type GeneratedToolIntegrityState = 'verified' | 'degraded' | 'missing'

export interface GeneratedToolReadIssue {
  code:
    | 'active-version-missing'
    | 'version-invalid'
    | 'artifact-changed'
    | 'validation-missing'
    | 'validation-failed'
    | 'validation-quarantined'
    | 'trust-revoked'
    | 'workspace-full-trust-required'
  message: string
}

export interface GeneratedToolCandidateSummary {
  jobId: string
  jobRevision: number
  candidateId?: string
  candidateFingerprint?: string
  mode: ForgeJobMode
  status: ForgeJobStatus
  attempt: number
  maxAttempts: number
  currentPhase?: string
  error?: string
  requiresApproval?: boolean
  updatedAt: number
}

export interface GeneratedToolInventoryItem {
  toolId: string
  displayName: string
  description: string
  scope: GeneratedToolScope
  projectId?: string
  availability: GeneratedToolEffectiveAvailability
  executable: boolean
  executionPolicy: 'unavailable' | 'approval-required' | 'auto-eligible'
  integrity: GeneratedToolIntegrityState
  issues: GeneratedToolReadIssue[]
  activeVersionId?: string
  lastStableVersionId?: string
  pointerRevision?: number
  capabilityRevision?: number
  permissionSummary: string[]
  invocationCount: number
  lastInvokedAt?: number
  lastOutcome?: GeneratedToolInvocationOutcome
  lastError?: string
  candidate?: GeneratedToolCandidateSummary
  createdAt: number
  updatedAt: number
}

export interface GeneratedToolsQualificationCaseSummary {
  id: RuntimeQualificationCaseId
  status: RuntimeQualificationCaseStatus
  details: string
}

export interface GeneratedToolsQualificationSummary {
  level: RuntimeQualificationLevel
  generatedAt: number
  devStatus: 'passed' | 'failed' | 'incomplete'
  packagedStatus: 'passed' | 'failed' | 'incomplete'
  candidate: 'quickjs-wasm' | 'node-vm' | 'child-process' | null
  devCases: GeneratedToolsQualificationCaseSummary[]
  packagedCases: GeneratedToolsQualificationCaseSummary[]
  limitations: string[]
}

export interface GeneratedToolsQualificationOperationView {
  attemptId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  phase?: string
  completedChecks: number
  totalChecks: number
  startedAt?: number
  updatedAt: number
  finishedAt?: number
  error?: string
}

export type GeneratedToolsQualificationOperationResult = GeneratedToolsReadResult<GeneratedToolsQualificationOperationView | null>

export interface GeneratedToolsInventorySnapshot {
  registryRevision: number
  capabilityRevision: number
  invocationRevision: number
  qualification: GeneratedToolsQualificationSummary | null
  qualificationOperation?: GeneratedToolsQualificationOperationView | null
  tools: GeneratedToolInventoryItem[]
}

export interface GeneratedToolValidationCheckView {
  id: string
  category: GeneratedToolValidationCheckCategory
  status: GeneratedToolValidationCheckStatus
  message: string
  hasEvidence: boolean
}

export interface GeneratedToolValidationReportView {
  id: string
  toolId: string
  versionId: string
  artifactFingerprint: string
  startedAt: number
  finishedAt: number
  status: GeneratedToolValidationReportStatus
  checks: GeneratedToolValidationCheckView[]
  declaredPermissions: GeneratedToolPermissionManifest
  observedCapabilities: string[]
}

export interface GeneratedToolVersionView {
  id: string
  version: number
  fingerprint: string
  manifestHash: string
  sourceHash: string
  distHash: string
  validationReportId: string
  trustState: GeneratedToolVersionTrustState
  createdAt: number
  active: boolean
  stable: boolean
  integrity: GeneratedToolIntegrityState
  issue?: GeneratedToolReadIssue
  manifest: GeneratedToolManifest
  validationReport?: GeneratedToolValidationReportView
  editDiff?: GeneratedToolEditDiff
}

export interface GeneratedToolInvocationView {
  id: string
  versionId: string
  sessionId: string
  runId: string
  toolCallId: string
  capabilityRevision: number
  status: GeneratedToolInvocationStatus
  policyDecision?: 'allow' | 'ask' | 'deny'
  outcome?: GeneratedToolInvocationOutcome
  proposedAt: number
  policyAt?: number
  startedAt?: number
  finishedAt?: number
  error?: string
}

export const GeneratedToolLifecycleMutationRequestSchema = z.object({
  toolId: ToolForgeIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  operationId: ToolForgeIdSchema,
  versionId: ToolForgeIdSchema.optional()
}).strict()

export function parseGeneratedToolLifecycleMutationRequest(value: unknown): GeneratedToolLifecycleMutationRequest {
  return GeneratedToolLifecycleMutationRequestSchema.parse(value)
}

export interface GeneratedToolLifecycleMutationRequest {
  toolId: string
  expectedRevision: number
  operationId: string
  versionId?: string
}

export interface GeneratedToolLifecycleMutationResult {
  success: boolean
  error?: string
  registryRevision?: number
  capabilityRevision?: number
  activeVersionId?: string
}

export const GeneratedToolRemoveInputSchema = z.object({
  toolId: ToolForgeIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  operationId: ToolForgeIdSchema
}).strict()

export interface GeneratedToolRemoveInput {
  toolId: string
  expectedRevision: number
  operationId: string
}

export interface GeneratedToolRemoveResult {
  success: boolean
  error?: string
  registryRevision?: number
  capabilityRevision?: number
  quarantineId?: string
}

export const GeneratedToolExportInputSchema = z.object({
  toolId: ToolForgeIdSchema,
  versionId: ToolForgeIdSchema
}).strict()

export interface GeneratedToolExportInput {
  toolId: string
  versionId: string
}

export interface GeneratedToolExportFile {
  path: string
  content: string
  sha256: string
}

export function parseGeneratedToolRemoveInput(value: unknown): GeneratedToolRemoveInput {
  return GeneratedToolRemoveInputSchema.parse(value)
}

export function parseGeneratedToolExportInput(value: unknown): GeneratedToolExportInput {
  return GeneratedToolExportInputSchema.parse(value)
}

export interface GeneratedToolExportResult {
  success: boolean
  error?: string
  data?: {
    toolId: string
    versionId: string
    version: number
    fingerprint: string
    manifestHash: string
    sourceHash: string
    distHash: string
    validationReportHash: string
    manifest: import('./generated-tools').GeneratedToolManifest
    validationReport: import('./generated-tools').GeneratedToolValidationReport
    files: GeneratedToolExportFile[]
    json: string
  }
}

export interface GeneratedToolEditSchemaDiff {
  changed: boolean
  baseHash: string
  candidateHash: string
}

export interface GeneratedToolEditPermissionDiff {
  added: string[]
  removed: string[]
  expanded: boolean
  categories: string[]
}

export interface GeneratedToolEditValidationDiff {
  added: string[]
  changed: string[]
  failed: string[]
}

export interface GeneratedToolEditDiff {
  baseVersionId: string
  baseFingerprint: string
  candidateId: string
  candidateFingerprint: string
  inputSchema: GeneratedToolEditSchemaDiff
  outputSchema: GeneratedToolEditSchemaDiff
  permissions: GeneratedToolEditPermissionDiff
  sourceChanged: boolean
  distChanged: boolean
  dependencies: GeneratedToolEditSchemaDiff
  validation: GeneratedToolEditValidationDiff
}

export interface GeneratedToolJobView {
  id: string
  candidateId?: string
  candidateFingerprint?: string
  attemptRecordId?: string
  mode: ForgeJobMode
  status: ForgeJobStatus
  jobRevision: number
  baseVersionId?: string
  baseFingerprint?: string
  attempt: number
  maxAttempts: number
  currentPhase?: string
  validationReportId?: string
  error?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
}

export interface GeneratedToolDetail {
  summary: GeneratedToolInventoryItem
  registryRevision: number
  capabilityRevision: number
  versions: GeneratedToolVersionView[]
  recentInvocations: GeneratedToolInvocationView[]
  recentJobs: GeneratedToolJobView[]
}

export type GeneratedToolsListResult = GeneratedToolsReadResult<GeneratedToolsInventorySnapshot>
export type GeneratedToolDetailResult = GeneratedToolsReadResult<GeneratedToolDetail>

export function parseGeneratedToolGetInput(value: unknown): GeneratedToolGetInput {
  return GeneratedToolGetInputSchema.parse(value)
}

export function parseGeneratedToolJobStatusInput(value: unknown): GeneratedToolJobStatusInput {
  return GeneratedToolJobStatusInputSchema.parse(value)
}
