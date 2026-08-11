import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ForgeJob,
  GeneratedToolInvocation,
  GeneratedToolRegistryEntry,
  GeneratedToolValidationReport,
  GeneratedToolVersion,
  RuntimeQualificationReport
} from '../../shared/generated-tools'
import type {
  GeneratedToolCandidateSummary,
  GeneratedToolDetail,
  GeneratedToolDetailResult,
  GeneratedToolInventoryItem,
  GeneratedToolInvocationView,
  GeneratedToolJobStatusResult,
  GeneratedToolJobView,
  GeneratedToolReadIssue,
  GeneratedToolsInventorySnapshot,
  GeneratedToolsListResult,
  GeneratedToolsQualificationSummary,
  GeneratedToolValidationReportView,
  GeneratedToolVersionView
} from '../../shared/generated-tools-management'
import { parseGeneratedToolValidationReport } from '../../shared/generated-tools-schema'
import { CorruptAtomicJsonError } from '../store/atomic-json'
import { getJokerHomeDir } from '../store/paths'
import { listForgeJobs, readForgeJob } from './forge-job-store'
import { readGeneratedToolInvocations } from './invocation-store'
import { assertToolForgeId, assertPathHasNoSymlink, resolveRootRelativePath } from './paths'
import { readQualificationOperation } from './qualification-operation-store'
import { readEffectiveRuntimeQualificationReport } from './qualification'
import { readGeneratedToolRegistry } from './registry'
import { canonicalVersionPath, generatedToolsRoot } from './store'
import { buildGeneratedToolEditDiff } from './edit-diff'
import { readGeneratedToolVersion } from './version-store'
import { readGeneratedToolCandidate } from './candidate-store'
import { readPromotionJournalByIdempotencyKey } from './promotion-journal-store'
import { readValidationReport } from './validation-report-store'

const MAX_RECENT_INVOCATIONS = 50
const MAX_RECENT_JOBS = 20
const MAX_UI_ERROR_LENGTH = 2_000

interface LoadedVersion {
  version?: GeneratedToolVersion
  report?: GeneratedToolValidationReport
  issue?: GeneratedToolReadIssue
  integrity: GeneratedToolVersionView['integrity']
}

interface ReadModelContext {
  registryRevision: number
  capabilityRevision: number
  invocationRevision: number
  entries: GeneratedToolRegistryEntry[]
  pointers: Map<string, { revision: number; activeVersionId?: string; lastStableVersionId?: string }>
  invocations: GeneratedToolInvocation[]
  jobs: ForgeJob[]
  qualification: RuntimeQualificationReport | null
  qualificationOperation: import('./qualification-operation-store').QualificationOperationRecord | null
}

function sanitizeMessage(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : fallback
  const collapsed = raw.replace(/[A-Za-z]:[\\/][^\s;,)]+/g, '[path]').replace(/(?:^|\s)\/[A-Za-z0-9_./-]+/g, ' [path]')
  return collapsed.slice(0, MAX_UI_ERROR_LENGTH)
}

function readError(error: unknown): { code: 'corrupt-state' | 'read-failed'; message: string } {
  return error instanceof CorruptAtomicJsonError
    ? { code: 'corrupt-state', message: 'Generated Tools state is corrupt' }
    : { code: 'read-failed', message: 'Unable to read Generated Tools' }
}

function loadContext(jokerHome: string): ReadModelContext {
  const registry = readGeneratedToolRegistry(jokerHome)
  const invocationState = readGeneratedToolInvocations(jokerHome)
  const jobs = listForgeJobs(jokerHome).jobs
  return {
    registryRevision: registry.revision,
    capabilityRevision: registry.capabilityRevision.revision,
    invocationRevision: invocationState.revision,
    entries: registry.entries,
    pointers: new Map(registry.activePointers.map((pointer) => [pointer.toolId, pointer])),
    invocations: invocationState.invocations,
    jobs,
    qualification: readEffectiveRuntimeQualificationReport(jokerHome),
    qualificationOperation: readQualificationOperation(jokerHome)
  }
}

function readEmbeddedValidationReport(
  jokerHome: string,
  version: GeneratedToolVersion
): GeneratedToolValidationReport {
  const root = generatedToolsRoot(jokerHome)
  const artifactPath = canonicalVersionPath(version.toolId, version.id)
  const artifactRoot = resolveRootRelativePath(root, artifactPath)
  assertPathHasNoSymlink(root, artifactRoot)
  const reportPath = join(artifactRoot, 'validation-report.json')
  assertPathHasNoSymlink(artifactRoot, reportPath)
  const report = parseGeneratedToolValidationReport(JSON.parse(readFileSync(reportPath, 'utf8')))
  if (
    report.id !== version.validationReportId ||
    report.toolId !== version.toolId ||
    report.versionId !== version.id ||
    report.artifactFingerprint !== version.fingerprint
  ) {
    throw new Error('Validation report does not match the Generated Tool version')
  }
  return report
}

function classifyVersionError(error: unknown): GeneratedToolReadIssue {
  const raw = error instanceof Error ? error.message : ''
  const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT' || /missing|not found|ENOENT/i.test(raw)
  return {
    code: missing ? 'validation-missing' : 'artifact-changed',
    message: missing
      ? 'Generated Tool validation evidence is missing'
      : 'Generated Tool artifact no longer matches its verified version'
  }
}

function loadVersion(jokerHome: string, toolId: string, versionId: string): LoadedVersion {
  try {
    const version = readGeneratedToolVersion(jokerHome, toolId, versionId)
    const report = readEmbeddedValidationReport(jokerHome, version)
    return { version, report, integrity: 'verified' }
  } catch (error) {
    const canonicalRoot = resolveRootRelativePath(generatedToolsRoot(jokerHome), canonicalVersionPath(toolId, versionId))
    const missing = !existsSync(canonicalRoot)
    return {
      integrity: missing ? 'missing' : 'degraded',
      issue: missing
        ? { code: 'active-version-missing', message: 'Generated Tool version bundle is missing' }
        : classifyVersionError(error)
    }
  }
}

function latestInvocationTime(invocation: GeneratedToolInvocation): number {
  return invocation.finishedAt ?? invocation.startedAt ?? invocation.policyAt ?? invocation.proposedAt
}

function invocationSummary(invocations: GeneratedToolInvocation[], toolId: string): {
  invocationCount: number
  lastInvokedAt?: number
  lastOutcome?: GeneratedToolInvocation['outcome']
  lastError?: string
} {
  const started = invocations.filter((item) => item.toolId === toolId && item.startedAt !== undefined)
  const latest = [...started].sort((left, right) => latestInvocationTime(right) - latestInvocationTime(left))[0]
  return {
    invocationCount: started.length,
    lastInvokedAt: latest ? latestInvocationTime(latest) : undefined,
    lastOutcome: latest?.outcome,
    lastError: latest?.error ? sanitizeMessage(latest.error, 'Generated Tool invocation failed') : undefined
  }
}

function jobRequiresApproval(jokerHome: string, job: ForgeJob): boolean {
  if (job.status !== 'awaiting-policy' || !job.candidateId) return false
  const journal = readPromotionJournalByIdempotencyKey(
    jokerHome,
    `promotion-${job.id}-${job.candidateId}`
  )
  return journal?.policy.action === 'ask'
}

function latestCandidate(jokerHome: string, jobs: ForgeJob[], toolId: string): GeneratedToolCandidateSummary | undefined {
  const job = jobs
    .filter((item) => item.toolId === toolId)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.revision - left.revision)[0]
  if (!job) return undefined
  return {
    jobId: job.id,
    jobRevision: job.revision,
    candidateId: job.candidateId,
    candidateFingerprint: job.candidateFingerprint,
    mode: job.mode,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    currentPhase: job.currentPhase,
    error: job.error ? sanitizeMessage(job.error, 'Forge job failed') : undefined,
    requiresApproval: jobRequiresApproval(jokerHome, job),
    updatedAt: job.updatedAt
  }
}

function inventoryItem(
  jokerHome: string,
  context: ReadModelContext,
  entry: GeneratedToolRegistryEntry
): GeneratedToolInventoryItem {
  const pointer = context.pointers.get(entry.toolId)
  const active = pointer?.activeVersionId
    ? loadVersion(jokerHome, entry.toolId, pointer.activeVersionId)
    : undefined
  const issues = active?.issue ? [active.issue] : []
  const integrity = active?.integrity ?? (pointer?.activeVersionId ? 'missing' : 'verified')
  let availability: GeneratedToolInventoryItem['availability'] = entry.descriptor.availability
  if (active?.issue?.code === 'artifact-changed') availability = 'changed'
  else if (active?.integrity === 'missing') availability = 'missing'
  const invocation = invocationSummary(context.invocations, entry.toolId)
  const executionPolicy = availability !== 'available' || integrity !== 'verified' || !pointer?.activeVersionId
    ? 'unavailable'
    : 'auto-eligible'
  return {
    toolId: entry.toolId,
    displayName: entry.descriptor.displayName,
    description: entry.descriptor.description,
    scope: entry.descriptor.scope,
    projectId: entry.descriptor.projectId,
    availability,
    executable: executionPolicy !== 'unavailable',
    executionPolicy,
    integrity,
    issues,
    activeVersionId: pointer?.activeVersionId,
    lastStableVersionId: pointer?.lastStableVersionId,
    pointerRevision: pointer?.revision,
    capabilityRevision: context.capabilityRevision,
    permissionSummary: [...entry.descriptor.permissionSummary],
    ...invocation,
    candidate: latestCandidate(jokerHome, context.jobs, entry.toolId),
    createdAt: entry.descriptor.createdAt,
    updatedAt: entry.updatedAt
  }
}

function jobOnlyInventoryItem(jokerHome: string, job: ForgeJob): GeneratedToolInventoryItem {
  return {
    toolId: job.toolId,
    displayName: job.spec.displayName,
    description: job.spec.goal,
    scope: job.spec.scope,
    projectId: job.spec.projectId,
    availability: job.status === 'validating' ? 'validating' : job.status === 'failed' ? 'failed' : 'building',
    executable: false,
    executionPolicy: 'unavailable',
    integrity: 'verified',
    issues: [],
    pointerRevision: undefined,
    capabilityRevision: undefined,
    permissionSummary: [
      ...job.spec.permissions.filesystem.read.map((path) => `project read: ${path}`),
      ...job.spec.permissions.filesystem.write.map((path) => `project write: ${path}`)
    ],
    invocationCount: 0,
    candidate: latestCandidate(jokerHome, [job], job.toolId),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  }
}

function qualificationSummary(report: RuntimeQualificationReport | null): GeneratedToolsQualificationSummary | null {
  if (!report) return null
  const candidates = report.candidates.filter((item) => item.candidate === 'quickjs-wasm')
  const dev = candidates.find((item) => item.env === 'dev')
  const packaged = candidates.find((item) => item.env === 'packaged')
  return {
    level: report.level,
    generatedAt: report.generatedAt,
    devStatus: report.environments.dev.status,
    packagedStatus: report.environments.packaged.status,
    candidate: dev?.candidate ?? packaged?.candidate ?? null,
    devCases: (dev?.cases ?? []).map(({ id, status, details }) => ({
      id,
      status,
      details: sanitizeMessage(details, 'Qualification case result')
    })),
    packagedCases: (packaged?.cases ?? []).map(({ id, status, details }) => ({
      id,
      status,
      details: sanitizeMessage(details, 'Qualification case result')
    })),
    limitations: report.limitations.map((item) => sanitizeMessage(item, 'Runtime qualification limitation'))
  }
}

function reportView(report: GeneratedToolValidationReport): GeneratedToolValidationReportView {
  return {
    id: report.id,
    toolId: report.toolId,
    versionId: report.versionId,
    artifactFingerprint: report.artifactFingerprint,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    status: report.status,
    checks: report.checks.map(({ id, category, status, message, evidencePath }) => ({
      id,
      category,
      status,
      message: sanitizeMessage(message, 'Validation check result'),
      hasEvidence: Boolean(evidencePath)
    })),
    declaredPermissions: structuredClone(report.declaredPermissions),
    observedCapabilities: report.observedCapabilities.map((item) => sanitizeMessage(item, 'Observed capability'))
  }
}

function requireCandidateForDiff(jokerHome: string, jobId: string, candidateId: string): import('../../shared/generated-tools').GeneratedToolCandidate | null {
  return readGeneratedToolCandidate(jokerHome, jobId, candidateId)
}

function readCandidateReportForDiff(jokerHome: string, reportId: string): GeneratedToolValidationReport | null {
  return readValidationReport(jokerHome, reportId)
}

function versionView(
  loaded: LoadedVersion,
  activeVersionId?: string,
  lastStableVersionId?: string,
  editDiff?: import('../../shared/generated-tools-management').GeneratedToolEditDiff
): GeneratedToolVersionView | null {
  if (!loaded.version) return null
  return {
    id: loaded.version.id,
    version: loaded.version.version,
    fingerprint: loaded.version.fingerprint,
    manifestHash: loaded.version.manifestHash,
    sourceHash: loaded.version.sourceHash,
    distHash: loaded.version.distHash,
    validationReportId: loaded.version.validationReportId,
    trustState: loaded.version.trustState,
    createdAt: loaded.version.createdAt,
    active: loaded.version.id === activeVersionId,
    stable: loaded.version.id === lastStableVersionId,
    integrity: loaded.integrity,
    issue: loaded.issue,
    manifest: structuredClone(loaded.version.manifest),
    validationReport: loaded.report ? reportView(loaded.report) : undefined,
    editDiff
  }
}

function invocationView(invocation: GeneratedToolInvocation): GeneratedToolInvocationView {
  return {
    id: invocation.id,
    versionId: invocation.versionId,
    sessionId: invocation.sessionId,
    runId: invocation.runId,
    toolCallId: invocation.toolCallId,
    capabilityRevision: invocation.capabilityRevision,
    status: invocation.status,
    policyDecision: invocation.policyDecision,
    outcome: invocation.outcome,
    proposedAt: invocation.proposedAt,
    policyAt: invocation.policyAt,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
    error: invocation.error ? sanitizeMessage(invocation.error, 'Generated Tool invocation failed') : undefined
  }
}

function jobView(job: ForgeJob): GeneratedToolJobView {
  return {
    id: job.id,
    candidateId: job.candidateId,
    candidateFingerprint: job.candidateFingerprint,
    attemptRecordId: job.attemptRecordId,
    mode: job.mode,
    status: job.status,
    jobRevision: job.revision,
    baseVersionId: job.baseVersionId,
    baseFingerprint: job.baseFingerprint,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    currentPhase: job.currentPhase,
    validationReportId: job.validationReportId,
    error: job.error ? sanitizeMessage(job.error, 'Forge job failed') : undefined,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  }
}

export function getForgeJobStatusForManagement(
  jobId: string,
  jokerHome = getJokerHomeDir()
): GeneratedToolJobStatusResult {
  try {
    assertToolForgeId(jobId, 'job id')
    const job = readForgeJob(jokerHome, jobId)
    if (!job) return { success: false, error: { code: 'not-found', message: 'ForgeJob was not found' } }
    const registry = readGeneratedToolRegistry(jokerHome)
    return {
      success: true,
      data: {
        jobId: job.id,
        toolId: job.toolId,
        mode: job.mode,
        status: job.status,
        jobRevision: job.revision,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        currentPhase: job.currentPhase,
        candidateId: job.candidateId,
        candidateFingerprint: job.candidateFingerprint,
        validationReportId: job.validationReportId,
        error: job.error ? sanitizeMessage(job.error, 'Forge job failed') : undefined,
        resumeHint: job.resumeHint ? sanitizeMessage(job.resumeHint, 'Forge job can be resumed') : undefined,
        requiresApproval: jobRequiresApproval(jokerHome, job),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        registryRevision: registry.revision,
        capabilityRevision: registry.capabilityRevision.revision,
        originalTaskComplete: false
      }
    }
  } catch (error) {
    return { success: false, error: readError(error) }
  }
}

export function listGeneratedToolsForManagement(
  jokerHome = getJokerHomeDir()
): GeneratedToolsListResult {
  try {
    const context = loadContext(jokerHome)
    const data: GeneratedToolsInventorySnapshot = {
      registryRevision: context.registryRevision,
      capabilityRevision: context.capabilityRevision,
      invocationRevision: context.invocationRevision,
      qualification: qualificationSummary(context.qualification),
      qualificationOperation: context.qualificationOperation
        ? {
            attemptId: context.qualificationOperation.attemptId,
            status: context.qualificationOperation.status,
            ...(context.qualificationOperation.phase ? { phase: context.qualificationOperation.phase } : {}),
            completedChecks: context.qualificationOperation.completedChecks,
            totalChecks: context.qualificationOperation.totalChecks,
            ...(context.qualificationOperation.startedAt !== undefined ? { startedAt: context.qualificationOperation.startedAt } : {}),
            updatedAt: context.qualificationOperation.updatedAt,
            ...(context.qualificationOperation.finishedAt !== undefined ? { finishedAt: context.qualificationOperation.finishedAt } : {}),
            ...(context.qualificationOperation.error ? { error: sanitizeMessage(context.qualificationOperation.error, 'Qualification failed') } : {})
          }
        : null,
      tools: [
        ...context.entries.map((entry) => inventoryItem(jokerHome, context, entry)),
        ...context.jobs
          .filter((job, index, jobs) =>
            !context.entries.some((entry) => entry.toolId === job.toolId) &&
            jobs.findIndex((candidate) => candidate.toolId === job.toolId) === index
          )
          .map((job) => jobOnlyInventoryItem(jokerHome, job))
      ].sort((left, right) => left.displayName.localeCompare(right.displayName, 'en-US') || left.toolId.localeCompare(right.toolId, 'en-US'))
    }
    return { success: true, data }
  } catch (error) {
    return { success: false, error: readError(error) }
  }
}

export function getGeneratedToolForManagement(
  toolId: string,
  jokerHome = getJokerHomeDir()
): GeneratedToolDetailResult {
  try {
    assertToolForgeId(toolId, 'tool id')
    const context = loadContext(jokerHome)
    const entry = context.entries.find((item) => item.toolId === toolId)
    if (!entry) return { success: false, error: { code: 'not-found', message: 'Generated Tool was not found' } }
    const pointer = context.pointers.get(toolId)
    const versions = entry.versionIds
      .map((versionId) => {
        const loaded = loadVersion(jokerHome, toolId, versionId)
        const matchingJob = context.jobs.find((job) => job.mode === 'edit' && job.candidateId === versionId)
        let diff: import('../../shared/generated-tools-management').GeneratedToolEditDiff | undefined
        if (matchingJob?.candidateId && matchingJob.baseVersionId && matchingJob.validationReportId && loaded.version && loaded.report) {
          const base = loadVersion(jokerHome, toolId, matchingJob.baseVersionId)
          const candidate = requireCandidateForDiff(jokerHome, matchingJob.id, matchingJob.candidateId)
          const candidateReport = readCandidateReportForDiff(jokerHome, matchingJob.validationReportId)
          if (base.version && candidate && candidateReport) diff = buildGeneratedToolEditDiff(base.version, candidate, base.report ?? candidateReport, candidateReport)
        }
        return versionView(loaded, pointer?.activeVersionId, pointer?.lastStableVersionId, diff)
      })
      .filter((version): version is GeneratedToolVersionView => version !== null)
      .sort((left, right) => right.version - left.version || left.id.localeCompare(right.id, 'en-US'))
    const recentInvocations = context.invocations
      .filter((item) => item.toolId === toolId)
      .sort((left, right) => latestInvocationTime(right) - latestInvocationTime(left) || left.id.localeCompare(right.id, 'en-US'))
      .slice(0, MAX_RECENT_INVOCATIONS)
      .map(invocationView)
    const recentJobs = context.jobs
      .filter((item) => item.toolId === toolId)
      .slice(0, MAX_RECENT_JOBS)
      .map(jobView)
    const data: GeneratedToolDetail = {
      summary: inventoryItem(jokerHome, context, entry),
      registryRevision: context.registryRevision,
      capabilityRevision: context.capabilityRevision,
      versions,
      recentInvocations,
      recentJobs
    }
    return { success: true, data }
  } catch (error) {
    return { success: false, error: readError(error) }
  }
}
