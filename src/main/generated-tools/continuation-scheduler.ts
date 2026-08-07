import { randomUUID } from 'node:crypto'

import type { ToolForgeContinuationV2 } from '../../shared/generated-tools'
import { createContinuationV2, readContinuationV2, readContinuationV2State, updateContinuationV2 } from './continuation-v2'
import { ToolForgeCasError } from './registry'

export interface ContinuationIntentInput {
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
  request: ToolForgeContinuationV2['request']
  createdAt?: number
  continuationId?: string
}

export interface ContinuationDispatchContext {
  dispatch: (continuation: ToolForgeContinuationV2) => Promise<void> | void
  isSessionRunning: (sessionId: string) => boolean
}

export interface ContinuationSchedulerOptions {
  jokerHome: string
  now?: () => number
  createId?: () => string
}

function terminal(status: ToolForgeContinuationV2['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
}

export class ContinuationScheduler {
  private readonly now: () => number
  private readonly createId: () => string
  private readonly dispatchers = new Map<number, ContinuationDispatchContext>()

  constructor(private readonly options: ContinuationSchedulerOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  recover(): ToolForgeContinuationV2[] {
    const recovered: ToolForgeContinuationV2[] = []
    for (const continuation of readContinuationV2State(this.options.jokerHome).continuations) {
      if (!['dispatched', 'running'].includes(continuation.status)) continue
      if (continuation.attempt >= 3) {
        recovered.push(updateContinuationV2(this.options.jokerHome, continuation.id, continuation.revision, (current) => ({
          ...current,
          status: 'interrupted',
          updatedAt: Math.max(current.updatedAt, this.now()),
          finishedAt: Math.max(current.updatedAt, this.now()),
          error: 'continuation-retry-limit-exhausted',
          revision: current.revision + 1
        })))
        continue
      }
      recovered.push(updateContinuationV2(this.options.jokerHome, continuation.id, continuation.revision, (current) => ({
        ...current,
        status: 'ready',
        continuationRunId: undefined,
        attempt: current.attempt + 1,
        updatedAt: Math.max(current.updatedAt, this.now()),
        error: 'recovered-after-restart',
        revision: current.revision + 1
      })))
    }
    return recovered
  }

  ensureReady(input: ContinuationIntentInput): ToolForgeContinuationV2 {
    const createdAt = input.createdAt ?? this.now()
    return createContinuationV2(this.options.jokerHome, {
      schemaVersion: 2,
      id: input.continuationId ?? `continuation-${this.createId()}`,
      jobId: input.jobId,
      toolId: input.toolId,
      versionId: input.versionId,
      fingerprint: input.fingerprint,
      validationReportId: input.validationReportId,
      sessionId: input.sessionId,
      sourceRunId: input.sourceRunId,
      sourceUserMessageId: input.sourceUserMessageId,
      specHash: input.specHash,
      fromCapabilityRevision: input.fromCapabilityRevision,
      toCapabilityRevision: input.toCapabilityRevision,
      userIntentRevision: input.userIntentRevision,
      status: 'ready',
      request: input.request,
      attempt: 1,
      revision: 0,
      createdAt,
      updatedAt: createdAt
    }).continuation
  }

  attach(dispatcherId: number, context: ContinuationDispatchContext): void {
    this.dispatchers.set(dispatcherId, context)
    void this.dispatchReady()
  }

  detach(dispatcherId: number): void {
    this.dispatchers.delete(dispatcherId)
  }

  async dispatchReady(): Promise<void> {
    const contexts = [...this.dispatchers.values()]
    if (contexts.length === 0) return
    for (const continuation of readContinuationV2State(this.options.jokerHome).continuations) {
      if (continuation.status !== 'ready') continue
      const context = contexts.find((candidate) => !candidate.isSessionRunning(continuation.sessionId))
      if (!context) continue
      const runId = `continuation-run-${this.createId()}`
      let dispatched: ToolForgeContinuationV2
      try {
        dispatched = updateContinuationV2(this.options.jokerHome, continuation.id, continuation.revision, (current) => ({
          ...current,
          status: 'dispatched',
          continuationRunId: runId,
          updatedAt: Math.max(current.updatedAt, this.now()),
          revision: current.revision + 1
        }))
      } catch (error) {
        if (error instanceof ToolForgeCasError) continue
        throw error
      }
      try {
        await context.dispatch(dispatched)
      } catch (error) {
        const latest = readContinuationV2(this.options.jokerHome, dispatched.id)
        if (latest && latest.status === 'dispatched' && latest.continuationRunId === runId) {
          this.interrupt(latest.id, latest.revision, error instanceof Error ? error.message : 'continuation dispatch failed')
        }
      }
    }
  }

  markRunning(continuationId: string, expectedRevision: number): ToolForgeContinuationV2 {
    return updateContinuationV2(this.options.jokerHome, continuationId, expectedRevision, (current) => ({
      ...current,
      status: 'running',
      startedAt: current.startedAt ?? this.now(),
      updatedAt: Math.max(current.updatedAt, this.now()),
      revision: current.revision + 1
    }))
  }

  complete(continuationId: string, expectedRevision: number): ToolForgeContinuationV2 {
    return updateContinuationV2(this.options.jokerHome, continuationId, expectedRevision, (current) => ({
      ...current,
      status: 'completed',
      finishedAt: this.now(),
      updatedAt: Math.max(current.updatedAt, this.now()),
      revision: current.revision + 1
    }))
  }

  fail(continuationId: string, expectedRevision: number, error: string): ToolForgeContinuationV2 {
    return updateContinuationV2(this.options.jokerHome, continuationId, expectedRevision, (current) => ({
      ...current,
      status: 'failed',
      finishedAt: this.now(),
      updatedAt: Math.max(current.updatedAt, this.now()),
      error: error.slice(0, 16_000),
      revision: current.revision + 1
    }))
  }

  cancel(continuationId: string, expectedRevision: number, reason = 'cancelled-by-user'): ToolForgeContinuationV2 {
    return updateContinuationV2(this.options.jokerHome, continuationId, expectedRevision, (current) => ({
      ...current,
      status: 'cancelled',
      finishedAt: this.now(),
      updatedAt: Math.max(current.updatedAt, this.now()),
      error: reason,
      revision: current.revision + 1
    }))
  }

  interrupt(continuationId: string, expectedRevision: number, error: string): ToolForgeContinuationV2 {
    return updateContinuationV2(this.options.jokerHome, continuationId, expectedRevision, (current) => ({
      ...current,
      status: 'interrupted',
      finishedAt: this.now(),
      updatedAt: Math.max(current.updatedAt, this.now()),
      error: error.slice(0, 16_000),
      revision: current.revision + 1
    }))
  }

  read(continuationId: string): ToolForgeContinuationV2 | null {
    return readContinuationV2(this.options.jokerHome, continuationId)
  }

  canDispatch(continuation: ToolForgeContinuationV2): boolean {
    return continuation.status === 'ready' && !terminal(continuation.status)
  }
}
