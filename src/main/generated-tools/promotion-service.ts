import type { HostApprovalGrant, HostApprovalRequest } from '../tools/registry'
import type { ForgeJob, GeneratedToolDescriptor, GeneratedToolPromotionJournal, GeneratedToolPolicyDecision } from '../../shared/generated-tools'
import { parseGeneratedToolPromotionApprovalReceipt } from '../../shared/generated-tools-schema'
import { readForgeJob, updateForgeJob } from './forge-job-store'
import { evaluateGeneratedToolPolicy } from './policy'
import { assembleGeneratedToolVersion } from './version-assembler'
import { createPromotionJournal, readPromotionJournal, readPromotionJournalByIdempotencyKey, readPromotionJournals, updatePromotionJournal } from './promotion-journal-store'
import { isAuthorizingPromotionApprovalReceipt, readPromotionApprovalReceipt, writePromotionApprovalReceipt } from './promotion-approval-store'
import { promoteGeneratedTool, readGeneratedToolRegistry, registerGeneratedToolVersion, ToolForgeCasError } from './registry'
import { getDefaultContinuationScheduler } from './continuation-scheduler-runtime'

export interface PromoteGeneratedToolInput {
  jobId: string
  expectedJobRevision: number
  registryRevision: number
  expectedCandidateFingerprint: string
  promotionId?: string
  approvalGrant?: HostApprovalGrant
  requestApproval?: (request: HostApprovalRequest) => Promise<HostApprovalGrant | null>
  recovery?: boolean
}

export interface PromoteGeneratedToolResult {
  job: ForgeJob
  journal: GeneratedToolPromotionJournal
  versionId?: string
  capabilityRevision?: number
  action: 'promoted' | 'approval-required' | 'denied'
  reason: string
}

export interface PromotionServiceOptions {
  jokerHome: string
  now?: () => number
  phaseCheckpoint?: (phase: GeneratedToolPromotionJournal['phase'], journal: GeneratedToolPromotionJournal) => void
}

export class PromotionServiceCrash extends Error {
  constructor(readonly phase: GeneratedToolPromotionJournal['phase']) {
    super(`PromotionService crash after ${phase}`)
    this.name = 'PromotionServiceCrash'
  }
}

function descriptorFor(job: ForgeJob, createdAt: number): GeneratedToolDescriptor {
  return {
    id: job.toolId,
    displayName: job.spec.displayName,
    description: job.spec.goal,
    scope: job.spec.scope,
    ...(job.spec.projectId ? { projectId: job.spec.projectId } : {}),
    availability: 'building',
    createdBy: 'joker',
    createdForSessionId: job.spec.requestedBy.sessionId,
    createdForRunId: job.spec.requestedBy.runId,
    permissionSummary: [
      ...job.spec.permissions.filesystem.read.map((path) => `project read: ${path}`),
      ...job.spec.permissions.filesystem.write.map((path) => `project write: ${path}`),
      ...job.spec.permissions.network.hosts.map((host) => `network: ${host}`),
      ...job.spec.permissions.process.commands.map((command) => `process: ${command}`)
    ],
    invocationCount: 0,
    createdAt,
    updatedAt: createdAt
  }
}

function failedJob(current: ForgeJob, now: number, error: string): ForgeJob {
  return {
    ...current,
    revision: current.revision + 1,
    status: 'failed',
    updatedAt: Math.max(current.updatedAt, now),
    finishedAt: Math.max(current.updatedAt, now),
    error: error.slice(0, 16_000),
    currentPhase: 'promotion-failed'
  }
}

function journalFor(job: ForgeJob, policy: GeneratedToolPolicyDecision, registryId: string, registryRevision: number, promotionId: string, createdAt: number): GeneratedToolPromotionJournal {
  return {
    schemaVersion: 1,
    id: promotionId,
    idempotencyKey: `promotion-${job.id}-${job.candidateId}`,
    jobId: job.id,
    jobRevision: job.revision,
    toolId: job.toolId,
    candidateId: job.candidateId!,
    candidateFingerprint: job.candidateFingerprint!,
    validationReportId: job.validationReportId!,
    policy,
    registryId,
    registryRevision,
    registerOperationId: `register-${promotionId}`,
    promoteOperationId: `promote-${promotionId}`,
    phase: 'intent',
    revision: 0,
    createdAt,
    updatedAt: createdAt
  }
}

function journalPhaseRank(phase: GeneratedToolPromotionJournal['phase']): number {
  if (phase === 'interrupted') return -1
  return [
    'intent',
    'policy-resolved',
    'assembled',
    'published',
    'registered',
    'pointer-switched',
    'continuation-ready',
    'completed'
  ].indexOf(phase)
}

function isRecoverablePromotionPhase(phase: GeneratedToolPromotionJournal['phase']): boolean {
  return phase !== 'completed' && phase !== 'failed'
}

export class PromotionService {
  private readonly now: () => number

  constructor(private readonly options: PromotionServiceOptions) {
    this.now = options.now ?? Date.now
  }

  private checkpoint(journal: GeneratedToolPromotionJournal): void {
    this.options.phaseCheckpoint?.(journal.phase, journal)
  }

  async advance(jobId: string, options?: {
    approvalGrant?: HostApprovalGrant
    requestApproval?: (request: HostApprovalRequest) => Promise<HostApprovalGrant | null>
  }): Promise<PromoteGeneratedToolResult> {
    const job = readForgeJob(this.options.jokerHome, jobId)
    if (!job) throw new Error(`ForgeJob not found: ${jobId}`)
    if (!job.candidateFingerprint) throw new Error('ForgeJob has no authoritative candidate fingerprint')
    const registry = readGeneratedToolRegistry(this.options.jokerHome)
    return this.promote({
      jobId: job.id,
      expectedJobRevision: job.revision,
      registryRevision: registry.revision,
      expectedCandidateFingerprint: job.candidateFingerprint,
      ...options
    })
  }

  async recover(): Promise<GeneratedToolPromotionJournal[]> {
    const recovered: GeneratedToolPromotionJournal[] = []
    for (const storedJournal of readPromotionJournals(this.options.jokerHome).journals) {
      if (!isRecoverablePromotionPhase(storedJournal.phase)) continue
      let journal = storedJournal
      if (journal.phase === 'interrupted') {
        const registry = readGeneratedToolRegistry(this.options.jokerHome)
        const pointer = registry.activePointers.find((item) => item.toolId === journal.toolId)
        if (
          journal.versionId === undefined ||
          journal.capabilityRevision === undefined ||
          pointer?.activeVersionId !== journal.versionId ||
          registry.capabilityRevision.revision < journal.capabilityRevision
        ) {
          recovered.push(updatePromotionJournal(this.options.jokerHome, journal.id, journal.revision, (current) => ({
            ...current,
            revision: current.revision + 1,
            phase: 'failed',
            error: 'interrupted-promotion-pointer-state-mismatch',
            updatedAt: Math.max(current.updatedAt, this.now())
          })))
          continue
        }
        const continuation = getDefaultContinuationScheduler()?.read(`continuation-${journal.id}`)
        journal = updatePromotionJournal(this.options.jokerHome, journal.id, journal.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          phase: continuation ? 'continuation-ready' : 'pointer-switched',
          error: undefined,
          updatedAt: Math.max(current.updatedAt, this.now())
        }))
      }
      const job = readForgeJob(this.options.jokerHome, journal.jobId)
      if (!job) {
        recovered.push(updatePromotionJournal(this.options.jokerHome, journal.id, journal.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          phase: 'failed',
          error: 'promotion-job-missing',
          updatedAt: Math.max(current.updatedAt, this.now())
        })))
        continue
      }
      if (job.status === 'completed' && journal.phase !== 'completed') {
        recovered.push(updatePromotionJournal(this.options.jokerHome, journal.id, journal.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          phase: current.capabilityRevision !== undefined ? 'completed' : 'interrupted',
          ...(current.capabilityRevision === undefined ? { error: 'completed-job-missing-capability-revision' } : {}),
          updatedAt: Math.max(current.updatedAt, this.now())
        })))
        continue
      }
      if (job.status !== 'promoting') continue
      try {
        const result = await this.promote({
          jobId: job.id,
          expectedJobRevision: job.revision,
          registryRevision: readGeneratedToolRegistry(this.options.jokerHome).revision,
          expectedCandidateFingerprint: journal.candidateFingerprint,
          promotionId: journal.id,
          recovery: true
        })
        recovered.push(result.journal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const latest = readPromotionJournal(this.options.jokerHome, journal.id)
        if (latest && isRecoverablePromotionPhase(latest.phase)) {
          recovered.push(updatePromotionJournal(this.options.jokerHome, latest.id, latest.revision, (current) => ({
            ...current,
            revision: current.revision + 1,
            phase: 'interrupted',
            error: `promotion-recovery-failed: ${message}`,
            updatedAt: Math.max(current.updatedAt, this.now())
          })))
        }
      }
    }
    return recovered
  }

  async promote(input: PromoteGeneratedToolInput): Promise<PromoteGeneratedToolResult> {
    const current = readForgeJob(this.options.jokerHome, input.jobId)
    if (!current) throw new Error(`ForgeJob not found: ${input.jobId}`)
    const promotionKey = `promotion-${current.id}-${current.candidateId ?? 'candidate'}`
    const existingJournal = readPromotionJournalByIdempotencyKey(this.options.jokerHome, promotionKey)
    const promotionId = existingJournal?.id ?? input.promotionId ?? promotionKey
    if (input.promotionId && existingJournal && input.promotionId !== existingJournal.id) throw new ToolForgeCasError('Promotion id does not match the durable promotion identity')
    if (current.status === 'completed') {
      const completed = existingJournal ?? readPromotionJournal(this.options.jokerHome, promotionId)
      if (completed?.phase === 'completed') return { job: current, journal: completed, versionId: completed.versionId, capabilityRevision: completed.capabilityRevision, action: 'promoted', reason: 'Promotion already completed' }
      if (completed && ['pointer-switched', 'continuation-ready'].includes(completed.phase) && completed.capabilityRevision !== undefined) {
        const done = updatePromotionJournal(this.options.jokerHome, completed.id, completed.revision, (item) => ({ ...item, revision: item.revision + 1, phase: 'completed', updatedAt: Math.max(item.updatedAt, this.now()) }))
        return { job: current, journal: done, versionId: done.versionId, capabilityRevision: done.capabilityRevision, action: 'promoted', reason: 'Promotion already completed; journal finalized' }
      }
      if (completed?.phase === 'interrupted') return { job: current, journal: completed, versionId: completed.versionId, capabilityRevision: completed.capabilityRevision, action: 'denied', reason: completed.error ?? 'Promotion was interrupted' }
    }
    if (current.status === 'promoting' && existingJournal?.phase === 'completed' && existingJournal.capabilityRevision !== undefined) {
      const completed = updateForgeJob(this.options.jokerHome, current.id, current.revision, (job) => ({
        ...job,
        revision: job.revision + 1,
        status: 'completed',
        finishedAt: this.now(),
        updatedAt: this.now(),
        validationReportId: existingJournal.validationReportId,
        currentPhase: 'completed'
      }))
      return { job: completed, journal: existingJournal, versionId: existingJournal.versionId, capabilityRevision: existingJournal.capabilityRevision, action: 'promoted', reason: 'Promotion resumed from completed durable journal' }
    }
    if (current.status !== 'awaiting-policy' && current.status !== 'promoting') throw new Error('ForgeJob is not awaiting promotion policy')
    if (current.revision !== input.expectedJobRevision) throw new ToolForgeCasError('ForgeJob revision is stale')
    if (current.candidateFingerprint !== input.expectedCandidateFingerprint) throw new Error('Promotion candidate fingerprint is stale')

    let receipt = readPromotionApprovalReceipt(this.options.jokerHome, promotionId)
    const evaluation = evaluateGeneratedToolPolicy({
      jokerHome: this.options.jokerHome,
      jobId: current.id,
      operation: 'promote',
      approvalMode: 'suggest',
      evaluatedAt: this.now(),
      expectedRegistryRevision: input.recovery && existingJournal
        ? undefined
        : input.registryRevision
    })
    const existingPolicy = existingJournal?.policy
    const receiptPolicyHash = existingPolicy?.inputHash ?? evaluation.decision.inputHash
    if (receipt && (receipt.jobId !== current.id || receipt.toolId !== current.toolId || receipt.candidateId !== evaluation.candidate.id || receipt.candidateFingerprint !== evaluation.candidate.artifactFingerprint || receipt.validationReportId !== evaluation.report.id || receipt.policyInputHash !== receiptPolicyHash)) {
      throw new ToolForgeCasError('Promotion approval receipt is stale for the current candidate and policy input')
    }
    let authorizingReceipt = isAuthorizingPromotionApprovalReceipt(receipt) ? receipt : null
    if (existingPolicy && existingPolicy.inputHash !== evaluation.decision.inputHash && journalPhaseRank(existingJournal.phase) < journalPhaseRank('registered')) {
      throw new ToolForgeCasError('Durable promotion policy no longer matches the current host input')
    }
    const policy = existingPolicy ?? evaluation.decision
    const registry = readGeneratedToolRegistry(this.options.jokerHome)
    const journal = existingJournal ?? createPromotionJournal(this.options.jokerHome, journalFor(current, policy, registry.registryId, evaluation.input.registryRevision, promotionId, this.now()))
    if (policy.action === 'deny') {
      const failed = updateForgeJob(this.options.jokerHome, current.id, current.revision, (job) => failedJob(job, this.now(), policy.reason))
      const updated = journal.phase === 'failed' ? journal : updatePromotionJournal(this.options.jokerHome, journal.id, journal.revision, (item) => ({ ...item, revision: item.revision + 1, phase: 'failed', error: policy.reason, updatedAt: this.now() }))
      return { job: failed, journal: updated, action: 'denied', reason: policy.reason }
    }
    if (policy.action === 'ask' && !authorizingReceipt) {
      const grant = input.approvalGrant ?? await input.requestApproval?.({
        toolName: 'GeneratedToolEnable',
        sessionId: current.spec.requestedBy.sessionId,
        runId: current.spec.requestedBy.runId,
        input: {
          promotionId,
          jobId: current.id,
          toolId: current.toolId,
          candidateId: evaluation.candidate.id,
          candidateFingerprint: evaluation.candidate.artifactFingerprint,
          validationReportId: evaluation.report.id,
          policyInputHash: evaluation.decision.inputHash
        }
      })
      if (!grant) return { job: current, journal, action: 'approval-required', reason: policy.reason }
      if (grant.sessionId !== current.spec.requestedBy.sessionId || grant.runId !== current.spec.requestedBy.runId || grant.toolName !== 'GeneratedToolEnable') {
        throw new ToolForgeCasError('Promotion approval grant is not bound to the owning session and run')
      }
      const writtenReceipt = writePromotionApprovalReceipt(this.options.jokerHome, parseGeneratedToolPromotionApprovalReceipt({
        schemaVersion: 2,
        id: `approval-${promotionId}`,
        promotionId,
        jobId: current.id,
        toolId: current.toolId,
        candidateId: evaluation.candidate.id,
        candidateFingerprint: evaluation.candidate.artifactFingerprint,
        validationReportId: evaluation.report.id,
        policyInputHash: evaluation.decision.inputHash,
        requestId: grant.requestId,
        requestHash: grant.requestHash,
        webContentsId: grant.webContentsId,
        sessionId: grant.sessionId,
        runId: grant.runId,
        approvedAt: grant.approvedAt,
        revision: 0
      }))
      if (!isAuthorizingPromotionApprovalReceipt(writtenReceipt)) throw new Error('Host wrote a non-authorizing promotion receipt')
      authorizingReceipt = writtenReceipt
      receipt = authorizingReceipt
    }

    const promoting = current.status === 'promoting'
      ? current
      : updateForgeJob(this.options.jokerHome, current.id, current.revision, (job) => ({ ...job, revision: job.revision + 1, status: 'promoting', updatedAt: this.now(), currentPhase: 'promoting' }))
    try {
      let phase = journal
      if (phase.phase === 'intent') {
        phase = updatePromotionJournal(this.options.jokerHome, phase.id, phase.revision, (item) => ({ ...item, revision: item.revision + 1, phase: 'policy-resolved', ...(receipt ? { approvalReceiptId: receipt.id } : {}), updatedAt: this.now() }))
        this.checkpoint(phase)
      }
      const assembled = assembleGeneratedToolVersion({ jokerHome: this.options.jokerHome, jobId: promoting.id, promotionId, policy, approvalGranted: Boolean(authorizingReceipt), expectedCandidateFingerprint: promoting.candidateFingerprint! })
      if (phase.phase === 'policy-resolved') {
        phase = updatePromotionJournal(this.options.jokerHome, phase.id, phase.revision, (item) => ({ ...item, revision: item.revision + 1, phase: 'assembled', versionId: assembled.version.id, versionNumber: assembled.version.version, updatedAt: this.now() }))
        this.checkpoint(phase)
      }
      if (phase.phase === 'assembled') {
        phase = updatePromotionJournal(this.options.jokerHome, phase.id, phase.revision, (item) => ({ ...item, revision: item.revision + 1, phase: 'published', versionId: assembled.version.id, versionNumber: assembled.version.version, updatedAt: this.now() }))
        this.checkpoint(phase)
      }
      const latestRegistry = readGeneratedToolRegistry(this.options.jokerHome)
      const registered = journalPhaseRank(phase.phase) >= journalPhaseRank('registered')
        ? latestRegistry
        : registerGeneratedToolVersion({ jokerHome: this.options.jokerHome, registryId: latestRegistry.registryId, expectedRevision: latestRegistry.revision, operationId: phase.registerOperationId, createdAt: this.now(), descriptor: descriptorFor(promoting, phase.createdAt), version: assembled.version }).state
      if (phase.phase === 'published') {
        phase = updatePromotionJournal(this.options.jokerHome, phase.id, phase.revision, (item) => ({ ...item, revision: item.revision + 1, phase: 'registered', registryRevision: registered.revision, updatedAt: this.now() }))
        this.checkpoint(phase)
      }
      const promoted = journalPhaseRank(phase.phase) >= journalPhaseRank('pointer-switched')
        ? registered
        : promoteGeneratedTool({ jokerHome: this.options.jokerHome, registryId: registered.registryId, expectedRevision: registered.revision, operationId: phase.promoteOperationId, createdAt: this.now(), toolId: promoting.toolId, versionId: assembled.version.id }).state
      if (phase.phase === 'registered') {
        phase = updatePromotionJournal(this.options.jokerHome, phase.id, phase.revision, (item) => ({ ...item, revision: item.revision + 1, phase: 'pointer-switched', registryRevision: promoted.revision, capabilityRevision: promoted.capabilityRevision.revision, versionId: assembled.version.id, versionNumber: assembled.version.version, updatedAt: this.now() }))
        this.checkpoint(phase)
      }
      const scheduler = getDefaultContinuationScheduler()
      if (!scheduler) throw new Error('Continuation scheduler is unavailable; promotion cannot complete safely')
      const existingContinuation = scheduler.read(`continuation-${promotionId}`)
      const continuation = existingContinuation ?? scheduler.ensureReady({
        jobId: promoting.id,
        toolId: promoting.toolId,
        versionId: assembled.version.id,
        fingerprint: assembled.version.fingerprint,
        validationReportId: assembled.version.validationReportId,
        sessionId: promoting.spec.requestedBy.sessionId,
        sourceRunId: promoting.spec.requestedBy.runId,
        sourceUserMessageId: promoting.spec.requestedBy.userMessageId,
        specHash: promoting.specHash,
        fromCapabilityRevision: phase.capabilityRevision !== undefined
          ? Math.max(0, phase.capabilityRevision - 1)
          : evaluation.input.capabilityRevision,
        toCapabilityRevision: promoted.capabilityRevision.revision,
        userIntentRevision: promoting.revision,
        request: { reasoningLevel: 'auto', runMode: 'chat', ...(promoting.spec.projectId ? { projectId: promoting.spec.projectId } : {}) },
        createdAt: this.now(),
        continuationId: `continuation-${promotionId}`
      })
      if (continuation && phase.phase !== 'continuation-ready') {
        phase = updatePromotionJournal(this.options.jokerHome, phase.id, phase.revision, (item) => ({ ...item, revision: item.revision + 1, phase: 'continuation-ready', updatedAt: this.now() }))
        this.checkpoint(phase)
      }
      await scheduler.dispatchReady()
      const currentContinuation = scheduler.read(continuation.id)
      if (!currentContinuation || ['failed', 'cancelled', 'interrupted'].includes(currentContinuation.status)) {
        throw new Error(`Continuation dispatch did not remain runnable: ${currentContinuation?.status ?? 'missing'}`)
      }
      // The source run may still own the session. In that case the scheduler
      // deliberately leaves the continuation ready; releaseRun() performs the
      // authoritative post-release dispatch. Do not mark a ready continuation
      // as a promotion failure or pretend it has already executed.
      if (currentContinuation.status === 'ready') {
        const completed = updateForgeJob(this.options.jokerHome, promoting.id, promoting.revision, (job) => ({ ...job, revision: job.revision + 1, status: 'completed', finishedAt: this.now(), updatedAt: this.now(), validationReportId: assembled.version.validationReportId, currentPhase: 'completed' }))
        const done = updatePromotionJournal(this.options.jokerHome, phase.id, phase.revision, (item) => ({ ...item, revision: item.revision + 1, phase: 'completed', updatedAt: this.now() }))
        this.checkpoint(done)
        return { job: completed, journal: done, versionId: assembled.version.id, capabilityRevision: promoted.capabilityRevision.revision, action: 'promoted', reason: 'Generated Tool promoted; continuation is durably ready for post-run dispatch' }
      }
      const completed = updateForgeJob(this.options.jokerHome, promoting.id, promoting.revision, (job) => ({ ...job, revision: job.revision + 1, status: 'completed', finishedAt: this.now(), updatedAt: this.now(), validationReportId: assembled.version.validationReportId, currentPhase: 'completed' }))
      const done = updatePromotionJournal(this.options.jokerHome, phase.id, phase.revision, (item) => ({ ...item, revision: item.revision + 1, phase: 'completed', updatedAt: this.now() }))
      this.checkpoint(done)
      return { job: completed, journal: done, versionId: assembled.version.id, capabilityRevision: promoted.capabilityRevision.revision, action: 'promoted', reason: 'Generated Tool promoted successfully' }
    } catch (error) {
      if (error instanceof PromotionServiceCrash) throw error
      const message = error instanceof Error ? error.message : String(error)
      const latest = readForgeJob(this.options.jokerHome, promoting.id)
      const latestJournal = readPromotionJournal(this.options.jokerHome, journal.id)
      const postPointer = latestJournal && ['pointer-switched', 'continuation-ready', 'completed'].includes(latestJournal.phase)
      const failed = latest && latest.status === 'promoting' && !postPointer ? updateForgeJob(this.options.jokerHome, latest.id, latest.revision, (job) => failedJob(job, this.now(), message)) : latest ?? promoting
      const failedJournal = latestJournal && !['completed', 'failed'].includes(latestJournal.phase)
        ? updatePromotionJournal(this.options.jokerHome, latestJournal.id, latestJournal.revision, (item) => ({ ...item, revision: item.revision + 1, phase: postPointer ? 'interrupted' : 'failed', error: message, updatedAt: this.now() }))
        : latestJournal ?? journal
      return { job: failed, journal: failedJournal, versionId: failedJournal.versionId, capabilityRevision: failedJournal.capabilityRevision, action: 'denied', reason: message }
    }
  }
}
