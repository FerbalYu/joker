// Shared types for ToolForge: generated tools, forge jobs, validation and
// runtime qualification. Frozen per TOOL-FORGE-PLAN.md P0 — change these
// shapes only through a deliberate contract revision.

// ---------------------------------------------------------------------------
// Permission manifest (§5.4)
// ---------------------------------------------------------------------------

export type GeneratedToolNetworkMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Precise permission scope of a generated tool. Undeclared capabilities are
 * denied by default; "full file access" or "network allowed" are never legal
 * values. Paths are validated against real absolute paths by the host after
 * resolution, not by string prefix comparison.
 */
export interface GeneratedToolPermissionManifest {
  filesystem: {
    read: string[]
    write: string[]
  }
  network: {
    hosts: string[]
    methods?: GeneratedToolNetworkMethod[]
  }
  process: {
    commands: string[]
  }
  environment: {
    keys: string[]
  }
  secrets: {
    handles: string[]
  }
}

// ---------------------------------------------------------------------------
// ToolSpec (§5.1)
// ---------------------------------------------------------------------------

export type GeneratedToolScope = 'project' | 'user'
export type GeneratedToolRuntimeId = 'quickjs-wasm' | 'node-child-process'

export type GeneratedToolValidationExpectation =
  | { outcome: 'succeeded'; output: unknown }
  | { outcome: 'tool-failed'; error: unknown }

/** A deterministic host-executed acceptance case sealed with the ToolSpec. */
export interface GeneratedToolValidationCase {
  id: string
  input: Record<string, unknown>
  workspaceFiles: Record<string, string>
  expected: GeneratedToolValidationExpectation
}

/** Immutable generic plan compiled by the host from a ToolSpec's validation cases. */
export interface GeneratedToolValidationPlan {
  schemaVersion: 1
  id: 'host-compiled-validation-plan-v1'
  cases: GeneratedToolValidationCase[]
}

/** Complete immutable runtime contract carried by every generated Tool version. */
export interface GeneratedToolManifest {
  schemaVersion: 1
  toolId: string
  displayName: string
  description: string
  sdkVersion: string
  runtime: {
    id: GeneratedToolRuntimeId
    version: string
  }
  entrypoint: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  errorContract: Record<string, unknown>
  permissions: GeneratedToolPermissionManifest
  dependencies: string[]
  limits: {
    timeoutMs: number
    maxInputBytes: number
    maxOutputBytes: number
    maxMemoryBytes: number
  }
}

/**
 * Structured description of a capability gap. This is the only manufacturing
 * input the ForgeAgent receives; free-form code generation is not allowed.
 */
export interface GeneratedToolSpec {
  id: string
  displayName: string
  goal: string
  reason: string
  requestedBy: {
    sessionId: string
    runId: string
    userMessageId: string
  }
  scope: GeneratedToolScope
  projectId?: string
  inputContract: Record<string, unknown>
  outputContract: Record<string, unknown>
  permissions: GeneratedToolPermissionManifest
  /** Defaults to the qualified project-read profile unless explicit user-owned workspace trust permits full trust. */
  validationProfile?: GeneratedToolValidationProfileId
  /** Optional while legacy ToolSpecs are migrated; examples compile to success cases. */
  validationCases?: GeneratedToolValidationCase[]
  acceptance: string[]
  examples: Array<{
    input: Record<string, unknown>
    expected: string
  }>
}

// ---------------------------------------------------------------------------
// ForgeJob (§5.2)
// ---------------------------------------------------------------------------

export type ForgeJobStatus =
  | 'queued'
  | 'planning'
  | 'building'
  | 'validating'
  | 'awaiting-policy'
  | 'promoting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type ForgeJobMode = 'create' | 'edit' | 'repair'
export type GeneratedToolValidationProfileId = 'gate2-project-read-v1' | 'user-owned-full-trust-v1'

export type GeneratedToolPolicyOperation = 'promote' | 'execute'
export type GeneratedToolPolicyAction = 'allow' | 'ask' | 'deny'
export type GeneratedToolPolicyReasonCode =
  | 'runtime-l0'
  | 'runtime-l1-approval-required'
  | 'runtime-l2-project-read'
  | 'workspace-full-trust-authorized'
  | 'workspace-full-trust-required'
  | 'permission-profile-unsupported'
  | 'permission-profile-hard-deny'
  | 'validation-not-passed'
  | 'candidate-integrity-failed'
  | 'stale-registry-revision'
  | 'stale-base-version'
  | 'approval-required'

export interface GeneratedToolPolicyInput {
  schemaVersion: 1
  operation: GeneratedToolPolicyOperation
  jobId: string
  toolId: string
  specHash: string
  candidateId: string
  candidateFingerprint: string
  validationReportId: string
  runtimeQualificationLevel: RuntimeQualificationLevel
  scope: GeneratedToolScope
  projectId?: string
  validationProfile: GeneratedToolValidationProfileId
  workspaceFullTrustGranted: boolean
  permissions: GeneratedToolPermissionManifest
  baseVersionId?: string
  registryRevision: number
  capabilityRevision: number
  approvalMode: 'suggest' | 'auto-edit' | 'full-auto'
  evaluatedAt: number
}

export interface GeneratedToolPolicyDecision {
  schemaVersion: 1
  action: GeneratedToolPolicyAction
  reasonCode: GeneratedToolPolicyReasonCode
  reason: string
  policyVersion: string
  inputHash: string
  evaluatedAt: number
  requiresApproval: boolean
  hardDeny: boolean
}

export interface GeneratedToolPromotionApprovalReceiptV1 {
  schemaVersion: 1
  id: string
  promotionId: string
  jobId: string
  toolId: string
  candidateId: string
  candidateFingerprint: string
  validationReportId: string
  policyInputHash: string
  windowId: number
  sessionId: string
  runId: string
  approved: boolean
  approvalMode: 'suggest' | 'auto-edit' | 'full-auto'
  approvedAt: number
  revision: number
}

export interface GeneratedToolPromotionApprovalReceiptV2 {
  schemaVersion: 2
  id: string
  promotionId: string
  jobId: string
  toolId: string
  candidateId: string
  candidateFingerprint: string
  validationReportId: string
  policyInputHash: string
  requestId: string
  requestHash: string
  webContentsId: number
  sessionId: string
  runId: string
  approvedAt: number
  revision: number
}

export type GeneratedToolPromotionApprovalReceipt =
  | GeneratedToolPromotionApprovalReceiptV1
  | GeneratedToolPromotionApprovalReceiptV2

export type GeneratedToolPromotionJournalPhase =
  | 'intent'
  | 'policy-resolved'
  | 'assembled'
  | 'published'
  | 'registered'
  | 'pointer-switched'
  | 'continuation-ready'
  | 'completed'
  | 'failed'
  | 'interrupted'

export interface GeneratedToolPromotionJournal {
  schemaVersion: 1
  id: string
  idempotencyKey: string
  jobId: string
  jobRevision: number
  toolId: string
  candidateId: string
  candidateFingerprint: string
  validationReportId: string
  policy: GeneratedToolPolicyDecision
  approvalReceiptId?: string
  registryId: string
  registryRevision: number
  versionId?: string
  versionNumber?: number
  registerOperationId: string
  promoteOperationId: string
  phase: GeneratedToolPromotionJournalPhase
  revision: number
  capabilityRevision?: number
  error?: string
  createdAt: number
  updatedAt: number
}

export type ToolForgeContinuationV2Status =
  | 'ready'
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ToolForgeContinuationV2 {
  schemaVersion: 2
  id: string
  jobId: string
  toolId: string
  versionId: string
  fingerprint: string
  validationReportId: string
  sessionId: string
  sourceRunId: string
  sourceUserMessageId: string
  specHash: string
  fromCapabilityRevision: number
  toCapabilityRevision: number
  userIntentRevision: number
  status: ToolForgeContinuationV2Status
  request: {
    reasoningLevel: string
    runMode: 'chat' | 'research'
    projectId?: string
    skillIds?: string[]
  }
  continuationRunId?: string
  queueItemId?: string
  attempt: number
  revision: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
}

/**
 * A persisted manufacturing/edit task. It is not transient chat output and
 * must survive window, run and app restarts. Identity, spec and workspace are
 * host-owned; candidate/report bindings are attached only by later gates.
 */
export interface ForgeJob {
  id: string
  idempotencyKey: string
  specHash: string
  toolId: string
  baseVersionId?: string
  baseFingerprint?: string
  mode: ForgeJobMode
  status: ForgeJobStatus
  revision: number
  spec: GeneratedToolSpec
  attempt: number
  maxAttempts: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  currentPhase?: string
  artifactPath: string
  candidateId?: string
  candidateFingerprint?: string
  attemptRecordId?: string
  validationRunId?: string
  validationReportId?: string
  error?: string
  resumeHint?: string
}

/** One immutable snapshot submitted from a mutable Forge workspace. */
export interface GeneratedToolCandidate {
  schemaVersion: 1
  id: string
  jobId: string
  toolId: string
  attempt: number
  attemptRecordId: string
  artifactPath: string
  artifactFingerprint: string
  manifestHash: string
  sourceHash: string
  distHash: string
  manifest: GeneratedToolManifest
  specHash: string
  validationProfile: GeneratedToolValidationProfileId
  validationPlan: GeneratedToolValidationPlan
  validationPlanHash: string
  createdAt: number
}

/** Immutable audit record proving which candidate consumed a job attempt. */
export interface GeneratedToolForgeAttempt {
  schemaVersion: 1
  id: string
  jobId: string
  toolId: string
  attempt: number
  candidateId: string
  candidateFingerprint: string
  specHash: string
  validationProfile: GeneratedToolValidationProfileId
  validationPlan: GeneratedToolValidationPlan
  validationPlanHash: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// GeneratedTool descriptor and versions (§5.3)
// ---------------------------------------------------------------------------

export type GeneratedToolAvailability =
  | 'available'
  | 'building'
  | 'validating'
  | 'failed'
  | 'disabled'
  | 'changed'
  | 'quarantined'

/**
 * A tool is a stable identity; a version is an immutable build artifact.
 * Editing always creates a new draft version and never overwrites the current
 * stable version in place. Availability is derived from host facts only:
 * content or permission change => 'changed' (automatically unavailable),
 * manual disable revokes fingerprint trust, validation failure keeps the old
 * stable version available, detected escape => 'quarantined'.
 */
export interface GeneratedToolDescriptor {
  id: string
  displayName: string
  description: string
  scope: GeneratedToolScope
  projectId?: string
  availability: GeneratedToolAvailability
  activeVersionId?: string
  lastStableVersionId?: string
  createdBy: 'joker'
  createdForSessionId?: string
  createdForRunId?: string
  permissionSummary: string[]
  invocationCount: number
  lastInvokedAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export type GeneratedToolVersionTrustState = 'trusted' | 'untrusted' | 'changed'

export interface GeneratedToolVersion {
  id: string
  toolId: string
  version: number
  /** Composite SHA-256 over the canonical manifest, source tree and dist tree hashes. */
  fingerprint: string
  manifestHash: string
  sourceHash: string
  distHash: string
  manifest: GeneratedToolManifest
  artifactPath: string
  validationReportId: string
  trustState: GeneratedToolVersionTrustState
  createdAt: number
}

// ---------------------------------------------------------------------------
// Gate 1.1 durable persistence contracts
// ---------------------------------------------------------------------------

export interface ToolForgeOperationRecord {
  operationId: string
  operationHash: string
  kind: string
  appliedRevision: number
  createdAt: number
}

export interface GeneratedToolRegistryEntry {
  toolId: string
  descriptor: GeneratedToolDescriptor
  versionIds: string[]
  validationReportIds: string[]
  updatedAt: number
}

export interface GeneratedToolRegistryState {
  schemaVersion: 1
  registryId: string
  revision: number
  entries: GeneratedToolRegistryEntry[]
  activePointers: GeneratedToolActivePointer[]
  capabilityRevision: CapabilityRevisionState
  operations: ToolForgeOperationRecord[]
}

export interface GeneratedToolActivePointer {
  schemaVersion: 1
  toolId: string
  revision: number
  activeVersionId?: string
  lastStableVersionId?: string
  updatedAt: number
}

export type CapabilityRevisionReason =
  | 'initial'
  | 'tool-promoted'
  | 'tool-disabled'
  | 'tool-rolled-back'
  | 'tool-revalidated'
  | 'tool-removed'
  | 'mcp-refreshed'

export interface CapabilityRevisionState {
  schemaVersion: 1
  revision: number
  changedAt: number
  reason: CapabilityRevisionReason
  toolIds: string[]
  operationId: string
}

export type GeneratedToolInvocationStatus = 'proposed' | 'policy' | 'started' | 'finished'
export type GeneratedToolInvocationOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timed-out'

export interface GeneratedToolInvocation {
  schemaVersion: 1
  id: string
  idempotencyKey: string
  requestHash: string
  toolId: string
  versionId: string
  fingerprint: string
  sessionId: string
  runId: string
  toolCallId: string
  capabilityRevision: number
  status: GeneratedToolInvocationStatus
  revision: number
  proposedAt: number
  policyAt?: number
  startedAt?: number
  finishedAt?: number
  policyDecision?: 'allow' | 'ask' | 'deny'
  outcome?: GeneratedToolInvocationOutcome
  outputHash?: string
  error?: string
}

export interface GeneratedToolInvocationState {
  schemaVersion: 1
  revision: number
  invocations: GeneratedToolInvocation[]
}

export type ToolForgeContinuationStatus = 'claimed' | 'completed' | 'cancelled'

export interface ToolForgeContinuationClaim {
  schemaVersion: 1
  id: string
  jobId: string
  capabilityRevision: number
  sessionId: string
  sourceRunId: string
  continuationRunId?: string
  status: ToolForgeContinuationStatus
  revision: number
  claimedAt: number
  updatedAt: number
}

export interface ToolForgeContinuationState {
  schemaVersion: 1
  revision: number
  claims: ToolForgeContinuationClaim[]
}

// ---------------------------------------------------------------------------
// Validation report (§10.1)
// ---------------------------------------------------------------------------

export type GeneratedToolValidationCheckCategory =
  | 'schema'
  | 'build'
  | 'unit'
  | 'contract'
  | 'permission'
  | 'timeout'
  | 'recovery'
  | 'audit'

export type GeneratedToolValidationCheckStatus = 'passed' | 'failed' | 'skipped'

export interface GeneratedToolValidationCheck {
  id: string
  category: GeneratedToolValidationCheckCategory
  status: GeneratedToolValidationCheckStatus
  evidencePath?: string
  evidenceHash?: string
  message: string
}

export type GeneratedToolValidationReportStatus = 'passed' | 'failed' | 'quarantined'

/**
 * Host-side factual acceptance record. A `passed` report must contain no
 * `failed` checks and no unexplained `skipped` checks, and its
 * `artifactFingerprint` must match a fresh hash of the artifact to be
 * installed.
 */
export interface GeneratedToolValidationReport {
  id: string
  toolId: string
  versionId: string
  artifactFingerprint: string
  validationProfile?: GeneratedToolValidationProfileId
  jobId?: string
  attempt?: number
  validationRunId?: string
  validationPlanId?: string
  validationPlanHash?: string
  validationSuiteId?: string
  validationSuiteHash?: string
  startedAt: number
  finishedAt: number
  status: GeneratedToolValidationReportStatus
  checks: GeneratedToolValidationCheck[]
  declaredPermissions: GeneratedToolPermissionManifest
  observedCapabilities: string[]
  logsPath: string
  logsHash?: string
}

// ---------------------------------------------------------------------------
// Runtime qualification (P0, §8.2 / §8.2.1)
// ---------------------------------------------------------------------------

export type RuntimeQualificationLevel = 'L2' | 'L1' | 'L0'
export type RuntimeQualificationCandidateId = 'quickjs-wasm' | 'node-vm' | 'child-process'
export type RuntimeQualificationEnvironment = 'dev' | 'packaged'
export type RuntimeQualificationCaseStatus = 'pass' | 'fail' | 'inconclusive' | 'skipped'

export type RuntimeQualificationCaseId =
  | 'legit-execution'
  | 'workspace-boundary'
  | 'network-denied'
  | 'subprocess-denied'
  | 'env-denied'
  | 'timeout-cleanup'
  | 'cancel-cleanup'
  | 'ipc-registry-audit-isolation'
  | 'packaged-equivalence'

export interface RuntimeQualificationFileIdentity {
  path: string
  size: number
  sha256: string
}

export interface RuntimeQualificationCaseResult {
  id: RuntimeQualificationCaseId
  status: RuntimeQualificationCaseStatus
  details: string
  evidence?: RuntimeQualificationFileIdentity
}

export interface RuntimeQualificationCandidateResult {
  candidate: RuntimeQualificationCandidateId
  env: RuntimeQualificationEnvironment
  /** True only when every mandatory isolation case passed with no unexplained skip. */
  passesIsolation: boolean
  cases: RuntimeQualificationCaseResult[]
  error?: string
}

export interface RuntimeQualificationEnvironmentResult {
  environment: RuntimeQualificationEnvironment
  status: 'passed' | 'failed' | 'incomplete'
  startedAt: number
  finishedAt: number
  error?: string
}

export interface RuntimeQualificationArtifactIdentity {
  bundle: RuntimeQualificationFileIdentity
  worker: RuntimeQualificationFileIdentity
  quickjsPackage: RuntimeQualificationFileIdentity & { version: string }
  packageLock: RuntimeQualificationFileIdentity
  packaged?: {
    executable: RuntimeQualificationFileIdentity
    appAsar: RuntimeQualificationFileIdentity
  }
}

/**
 * Frozen runtime qualification matrix (TOOL-FORGE-PLAN.md §8.2.1). Level is
 * derived, never declared: L2 requires all cases to pass in both dev and
 * packaged environments; L1 requires dev to pass; otherwise L0 (observe only).
 */
export interface RuntimeQualificationReport {
  schemaVersion: 2
  generatedAt: number
  level: RuntimeQualificationLevel
  artifactIdentity: RuntimeQualificationArtifactIdentity
  environments: {
    dev: RuntimeQualificationEnvironmentResult
    packaged: RuntimeQualificationEnvironmentResult
  }
  candidates: RuntimeQualificationCandidateResult[]
  limitations: string[]
}
