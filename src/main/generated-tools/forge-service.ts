import { randomUUID } from 'node:crypto'

import type { LanguageModel } from 'ai'

import type { ForgeJob } from '../../shared/generated-tools'
import type { ToolContext } from '../tools/registry'
import type { PromotionService } from './promotion-service'
import { runForgeAgent, type ForgeAgentRunResult } from './forge-agent'
import {
  listForgeJobs,
  readForgeJob,
  recoverInterruptedForgeJobs,
  updateForgeJob
} from './forge-job-store'
import {
  resumeAndValidateGeneratedToolCandidate,
  resumeInterruptedForgeJob
} from './validator-recovery'
import { GeneratedToolsEventBus } from './event-bus'
import { startTraceSpan, type TraceSink } from './trace'
import { validateGeneratedToolCandidate } from './validator'
import { assertForgeJobTransition } from './forge-state-machine'

const DEFAULT_MAX_CONCURRENCY = 1

export interface ForgeServiceMakerInput {
  jokerHome: string
  jobId: string
  job: ForgeJob
  validationPlan?: import('../../shared/generated-tools').GeneratedToolValidationPlan
  validationPlanHash?: string
  /** @deprecated legacy suite identity accepted for existing callers. */
  validationSuiteId?: string
  validationSuiteHash?: string
  prompt: string
  toolContext: ToolContext
  model?: LanguageModel
  now?: () => number
  createValidationRunId?: () => string
}

export type ForgeServiceMaker = (input: ForgeServiceMakerInput) => Promise<ForgeAgentRunResult>

export type ForgeActivationDriver = PromotionService['advance']

export interface ForgeServiceOptions {
  jokerHome: string
  model?: LanguageModel
  maker?: ForgeServiceMaker
  validateCandidate?: typeof validateGeneratedToolCandidate
  resumeValidation?: typeof resumeAndValidateGeneratedToolCandidate
  now?: () => number
  createValidationRunId?: () => string
  activationDriver?: ForgeActivationDriver
  maxConcurrency?: number
  events?: GeneratedToolsEventBus
  traceSink?: TraceSink
}

export interface ForgeController {
  enqueue(jobId: string): boolean
  cancel(jobId: string, expectedRevision: number): Promise<ForgeJob>
}

interface ActiveForgeJob {
  controller: AbortController
  promise: Promise<void>
}

function terminal(status: ForgeJob['status']): boolean {
  return ['completed', 'cancelled', 'awaiting-policy'].includes(status)
}

function cancelledJob(current: ForgeJob, cancelledAt: number): ForgeJob {
  return {
    ...current,
    revision: current.revision + 1,
    status: 'cancelled',
    updatedAt: Math.max(current.updatedAt, cancelledAt),
    finishedAt: Math.max(current.updatedAt, cancelledAt),
    candidateId: undefined,
    candidateFingerprint: undefined,
    attemptRecordId: undefined,
    validationRunId: undefined,
    validationReportId: undefined,
    error: 'cancelled-by-user',
    currentPhase: 'cancelled'
  }
}

function failedJob(current: ForgeJob, failedAt: number, error: string): ForgeJob {
  return {
    ...current,
    revision: current.revision + 1,
    status: 'failed',
    updatedAt: Math.max(current.updatedAt, failedAt),
    finishedAt: Math.max(current.updatedAt, failedAt),
    error: error.slice(0, 16_000),
    currentPhase: 'forge-failed'
  }
}

function interruptedJob(current: ForgeJob, interruptedAt: number): ForgeJob {
  return {
    ...current,
    revision: current.revision + 1,
    status: 'interrupted',
    updatedAt: Math.max(current.updatedAt, interruptedAt),
    finishedAt: Math.max(current.updatedAt, interruptedAt),
    error: 'forge-service-stopped',
    resumeHint: `resume-from-${current.status}`,
    currentPhase: 'interrupted'
  }
}

export class ForgeService implements ForgeController {
  private readonly active = new Map<string, ActiveForgeJob>()
  private readonly pending = new Set<string>()
  private readonly now: () => number
  private readonly maker: ForgeServiceMaker
  private readonly maxConcurrency: number
  private readonly events?: GeneratedToolsEventBus
  private readonly traceSink?: TraceSink
  private stopping = false

  constructor(private readonly options: ForgeServiceOptions) {
    this.now = options.now ?? Date.now
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY))
    this.events = options.events
    this.traceSink = options.traceSink
    this.maker = options.maker ?? ((input) => runForgeAgent(input))
  }

  start(): void {
    this.stopping = false
    recoverInterruptedForgeJobs(this.options.jokerHome, this.now())
    for (const job of listForgeJobs(this.options.jokerHome).jobs) {
      // Upgrade jobs that were stopped only by the removed ToolForge gates.
      if (job.status === 'failed' && /validation suite|validation plan|workspace full trust|runtime qualification|unsupported runtime profile/i.test(job.error ?? '')) {
        const reopened = updateForgeJob(this.options.jokerHome, job.id, job.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          status: 'queued',
          updatedAt: this.now(),
          finishedAt: undefined,
          error: undefined,
          currentPhase: 'queued'
        }))
        this.enqueue(reopened.id)
        continue
      }
      if (job.status === 'promoting') continue
      if (job.status === 'queued' || job.status === 'interrupted' || job.status === 'awaiting-policy') this.enqueue(job.id)
    }
  }

  enqueue(jobId: string): boolean {
    if (this.stopping) return false
    if (this.active.has(jobId) || this.pending.has(jobId)) return true
    const job = readForgeJob(this.options.jokerHome, jobId)
    if (!job || (!['queued', 'interrupted', 'awaiting-policy'].includes(job.status))) return false
    this.pending.add(jobId)
    this.events?.emit('forge.job.queued', { jobId: job.id, toolId: job.toolId, status: job.status })
    queueMicrotask(() => this.drain())
    return true
  }

  async cancel(jobId: string, expectedRevision: number): Promise<ForgeJob> {
    const cancelled = updateForgeJob(
      this.options.jokerHome,
      jobId,
      expectedRevision,
      (current) => cancelledJob(current, this.now())
    )
    this.pending.delete(jobId)
    this.active.get(jobId)?.controller.abort(new DOMException('ForgeJob cancelled by user', 'AbortError'))
    return cancelled
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.pending.clear()
    const active = [...this.active.values()]
    for (const item of active) item.controller.abort(new DOMException('ForgeService stopped', 'AbortError'))
    await Promise.allSettled(active.map((item) => item.promise))
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0 || this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((item) => item.promise))
      if (this.pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  private drain(): void {
    if (this.stopping) return
    while (this.active.size < this.maxConcurrency) {
      const jobId = this.pending.values().next().value as string | undefined
      if (!jobId) return
      this.pending.delete(jobId)
      if (this.active.has(jobId)) continue
      const controller = new AbortController()
      const promise = this.runJob(jobId, controller.signal)
        .catch((error) => this.handleRunError(jobId, error))
        .finally(() => {
          this.active.delete(jobId)
          this.drain()
        })
      this.active.set(jobId, { controller, promise })
    }
  }

  private async runJob(jobId: string, signal: AbortSignal): Promise<void> {
    const span = startTraceSpan(this.traceSink, 'forge.job', { jobId })
    try {
      await this.runJobInternal(jobId, signal)
      span.end('ok')
    } catch (error) {
      span.end('error', error)
      throw error
    }
  }

  private async runJobInternal(jobId: string, signal: AbortSignal): Promise<void> {
    let job = readForgeJob(this.options.jokerHome, jobId)
    if (!job || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return

    if (job.status === 'interrupted') {
      if (job.resumeHint?.includes('validating')) {
        const result = await (this.options.resumeValidation ?? resumeAndValidateGeneratedToolCandidate)(
          this.options.jokerHome,
          job.id,
          job.revision,
          signal
        )
        job = result.job
      } else {
        job = resumeInterruptedForgeJob(this.options.jokerHome, job.id, job.revision, this.now())
      }
    }

    if (job.status === 'queued') {
      assertForgeJobTransition(job.status, 'planning')
      job = updateForgeJob(this.options.jokerHome, job.id, job.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        status: 'planning',
        startedAt: this.now(),
        updatedAt: Math.max(current.updatedAt, this.now()),
        currentPhase: 'planning'
      }))
      this.events?.emit('forge.job.phase', { jobId: job.id, toolId: job.toolId, from: 'queued', to: 'planning' })
    }

    if (job.status === 'planning') {
      assertForgeJobTransition(job.status, 'building')
      job = updateForgeJob(this.options.jokerHome, job.id, job.revision, (current) => ({
        ...current,
        revision: current.revision + 1,
        status: 'building',
        updatedAt: Math.max(current.updatedAt, this.now()),
        currentPhase: 'building-candidate'
      }))
    }

    if (job.status === 'building') {
      assertForgeJobTransition(job.status, 'validating')
      await this.maker({
        jokerHome: this.options.jokerHome,
        jobId: job.id,
        job,
        prompt: this.promptFor(job),
        toolContext: {
          workspacePath: null,
          sessionId: job.spec.requestedBy.sessionId,
          runId: `forge-agent-${job.id}-${job.attempt}`,
          approvalGate: async () => ({ outcome: 'deny', risk: 'external', reason: 'ForgeService has no ambient approval authority' }),
          abortSignal: signal
        },
        model: this.options.model,
        now: this.now,
        createValidationRunId: this.options.createValidationRunId ?? (() => `validation-${randomUUID()}`)
      })
      const submitted = readForgeJob(this.options.jokerHome, job.id)
      if (!submitted) throw new Error(`ForgeJob disappeared: ${job.id}`)
      if (submitted.status === 'cancelled') return
      if (submitted.status !== 'validating' || !submitted.candidateId) {
        throw new Error('ForgeAgent ended without submitting an immutable candidate')
      }
      job = submitted
    }

    if (job.status === 'validating') {
      const result = await (this.options.validateCandidate ?? validateGeneratedToolCandidate)(this.options.jokerHome, job.id, job.revision, signal)
      const retryableFailure = result.report?.status === 'failed' && result.job.attempt < result.job.maxAttempts
      if (result.outcome === 'completed' && retryableFailure) {
        const retryAt = this.now()
        const repair = updateForgeJob(this.options.jokerHome, result.job.id, result.job.revision, (current) => ({
          ...current,
          revision: current.revision + 1,
          status: 'building',
          attempt: current.attempt + 1,
          updatedAt: Math.max(current.updatedAt, retryAt),
          finishedAt: undefined,
          candidateId: undefined,
          candidateFingerprint: undefined,
          attemptRecordId: undefined,
          validationRunId: undefined,
          validationReportId: undefined,
          error: undefined,
          currentPhase: 'repairing-validation-failure'
        }))
        this.pending.add(repair.id)
      } else if (result.job.status === 'awaiting-policy') {
        job = result.job
      }
    }

    if (!job) return
    if (job.status === 'awaiting-policy') {
      if (!this.options.activationDriver) return
      await this.options.activationDriver(job.id)
      this.events?.emit('forge.job.completed', { jobId: job.id, toolId: job.toolId, status: 'completed' })
    }
  }

  private async handleRunError(jobId: string, error: unknown): Promise<void> {
    const job = readForgeJob(this.options.jokerHome, jobId)
    if (!job || terminal(job.status) || job.status === 'failed' || job.status === 'cancelled') return
    try {
      if (this.stopping && ['planning', 'building', 'validating', 'promoting'].includes(job.status)) {
        updateForgeJob(this.options.jokerHome, job.id, job.revision, (current) => interruptedJob(current, this.now()))
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.events?.emit('forge.job.failed', { jobId, toolId: job.toolId, error: message.slice(0, 2_000) })
      updateForgeJob(this.options.jokerHome, job.id, job.revision, (current) => failedJob(current, this.now(), message))
    } catch (persistError) {
      const latest = readForgeJob(this.options.jokerHome, jobId)
      if (!latest || terminal(latest.status) || latest.status === 'cancelled') return
      console.error('ForgeService failed to persist ForgeJob failure', persistError)
    }
  }

  private promptFor(job: ForgeJob): string {
    return [
      `Manufacture Generated Tool ${job.toolId} for attempt ${job.attempt} of ${job.maxAttempts}.`,
      `Mode: ${job.mode}.`,
        ...(job.baseVersionId ? [
          `Base stable version: ${job.baseVersionId}. Preserve the stable version until this edit is independently validated and promoted.`
        ] : []),

      `Goal: ${job.spec.goal}`,
      `Edit instruction: ${job.spec.reason}`,
      `Acceptance: ${job.spec.acceptance.join(' | ')}`,
      'Read the immutable spec, create manifest.json plus source and dist artifacts, run the host check, then submit the candidate.'
    ].join('\n')
  }
}
