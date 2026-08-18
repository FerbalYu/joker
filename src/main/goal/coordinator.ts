import type {
  ChatMessage,
  GoalCas,
  GoalState,
  GoalTransitionResult,
  StreamEvent
} from '../../shared/types'
import type { AgentRunResult } from '../agent/loop'
import type { GoalEvaluatorResult } from './evaluator'

export interface GoalCoordinatorDependencies {
  getGoal: (sessionId: string) => GoalState | undefined
  getMessage: (sessionId: string, messageId: string) => ChatMessage | undefined
  claimPhase: (sessionId: string, input: GoalCas & { phase: 'execution' | 'validation'; invocationId: string }) => GoalTransitionResult
  commitExecution: (sessionId: string, input: GoalCas & {
    invocationId: string
    usageOperationId: string
    message: ChatMessage
    usage?: ChatMessage['usage']
  }) => GoalTransitionResult
  commitEvaluation: (sessionId: string, input: GoalCas & {
    invocationId: string
    usageOperationId: string
    usage?: ChatMessage['usage']
    outcome: 'complete' | 'continue' | 'blocked'
    evaluation: string
    feedback?: string
  }) => GoalTransitionResult
  pause: (sessionId: string, input: GoalCas & {
    stopReason?: 'user-paused' | 'execution-error' | 'evaluation-error'
    feedback?: string
  }) => GoalTransitionResult
  execute: (input: {
    sessionId: string
    invocationId: string
    goal: GoalState
    signal: AbortSignal
    onEvent: (event: StreamEvent) => void | Promise<void>
  }) => Promise<AgentRunResult>
  evaluate: (input: {
    objective: string
    generation: number
    round: number
    executionMessage: ChatMessage
    signal?: AbortSignal
  }) => Promise<GoalEvaluatorResult>
  now?: () => number
  uuid?: () => string
}

export interface GoalCoordinatorRunOptions {
  sessionId: string
  signal?: AbortSignal
  onEvent: (event: StreamEvent) => void | Promise<void>
}

export type GoalCoordinatorRunResult =
  | { status: 'completed' | 'blocked' | 'paused' | 'interrupted' | 'superseded'; goal: GoalState }
  | { status: 'not-started'; error: GoalTransitionResult['error'] | 'already-running' }

/**
 * Runs one session-scoped Goal at a time. Every model side effect is preceded by
 * a durable CAS claim, and execution output is committed before validation starts.
 */
export class GoalCoordinator {
  private readonly active = new Map<string, AbortController>()
  private readonly now: () => number
  private readonly uuid: () => string

  constructor(private readonly dependencies: GoalCoordinatorDependencies) {
    this.now = dependencies.now ?? Date.now
    this.uuid = dependencies.uuid ?? (() => crypto.randomUUID())
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  stop(sessionId: string): boolean {
    const controller = this.active.get(sessionId)
    if (!controller) return false
    controller.abort()
    return true
  }

  async run(options: GoalCoordinatorRunOptions): Promise<GoalCoordinatorRunResult> {
    if (this.active.has(options.sessionId)) return { status: 'not-started', error: 'already-running' }
    const controller = new AbortController()
    const unlink = linkAbortSignal(options.signal, controller)
    this.active.set(options.sessionId, controller)
    try {
      return await this.runLoop(options.sessionId, controller.signal, options.onEvent)
    } finally {
      unlink()
      if (this.active.get(options.sessionId) === controller) this.active.delete(options.sessionId)
    }
  }

  private async runLoop(
    sessionId: string,
    signal: AbortSignal,
    onEvent: GoalCoordinatorRunOptions['onEvent']
  ): Promise<GoalCoordinatorRunResult> {
    let runIdentity: Pick<GoalState, 'id' | 'generation'> | undefined
    while (true) {
      const current = this.dependencies.getGoal(sessionId)
      if (!current) return { status: 'not-started', error: 'no-goal' }
      runIdentity ??= { id: current.id, generation: current.generation }
      if (!sameGoalIdentity(current, runIdentity)) return { status: 'superseded', goal: current }
      if (current.status === 'validating' && current.resumePhase === undefined && current.currentInvocationIds.validation === undefined) {
        const executionMessage = this.latestExecutionMessage(sessionId, current)
        if (!executionMessage) return this.pauseOwned(sessionId, runIdentity, 'evaluation-error', 'The committed execution evidence is unavailable for validation.')
        const resumed = await this.runValidation(sessionId, runIdentity, current, executionMessage, signal, onEvent)
        if (resumed.status !== 'continue') return resumed.result
        continue
      }
      if (current.status !== 'queued') return terminalResult(current)
      if (signal.aborted) return this.pauseOwned(sessionId, runIdentity, 'user-paused')

      const executionInvocationId = this.uuid()
      const executionClaim = this.dependencies.claimPhase(sessionId, {
        ...goalCas(current),
        phase: 'execution',
        invocationId: executionInvocationId
      })
      if (!executionClaim.success || !executionClaim.goal) {
        return { status: 'not-started', error: executionClaim.error }
      }
      await onEvent({ type: 'goal-update', sessionId, goal: executionClaim.goal })

      let execution: AgentRunResult
      try {
        execution = await this.dependencies.execute({
          sessionId,
          invocationId: executionInvocationId,
          goal: executionClaim.goal,
          signal,
          onEvent
        })
      } catch (error) {
        return this.pauseOwned(sessionId, runIdentity, signal.aborted ? 'user-paused' : 'execution-error',
          signal.aborted ? undefined : boundedFeedback(errorMessage(error)))
      }
      if (execution.status === 'aborted' || signal.aborted) {
        return this.pauseOwned(sessionId, runIdentity, 'user-paused')
      }
      if (execution.status === 'needs-user-action') {
        return this.pauseOwned(sessionId, runIdentity, 'user-paused', `Tool recovery requires user action: ${execution.recoveryIds.join(', ')}`)
      }
      if (execution.status !== 'completed' && execution.status !== 'step-limit' && execution.status !== 'repetition') {
        const feedback = execution.status === 'error' || execution.status === 'empty'
          ? boundedFeedback(execution.error)
          : 'Goal execution did not produce a durable assistant result.'
        return this.pauseOwned(sessionId, runIdentity, 'execution-error', feedback)
      }

      const assistantMessage: ChatMessage = {
        id: execution.messageId,
        role: 'assistant',
        content: execution.text,
        ...(execution.segments.length > 0 ? { segments: execution.segments } : {}),
        ...(execution.toolCalls.length > 0 ? { toolCalls: execution.toolCalls } : {}),
        usage: execution.usage,
        durationMs: execution.durationMs,
        runMode: 'chat',
        createdAt: this.now()
      }
      const executionCommit = this.dependencies.commitExecution(sessionId, {
        ...goalCas(executionClaim.goal),
        invocationId: executionInvocationId,
        usageOperationId: this.uuid(),
        message: assistantMessage,
        usage: execution.usage
      })
      if (!executionCommit.success || !executionCommit.goal) {
        return { status: 'not-started', error: executionCommit.error }
      }
      await onEvent({ type: 'goal-update', sessionId, goal: executionCommit.goal })
      if (executionCommit.goal.status === 'blocked') return terminalResult(executionCommit.goal)
      if (execution.status === 'repetition') {
        return this.pauseOwned(sessionId, runIdentity, 'execution-error', boundedFeedback(execution.error))
      }

      if (signal.aborted) return this.pauseOwned(sessionId, runIdentity, 'user-paused')
      const validation = await this.runValidation(sessionId, runIdentity, executionCommit.goal, assistantMessage, signal, onEvent)
      if (validation.status !== 'continue') return validation.result
    }
  }

  private async runValidation(
    sessionId: string,
    identity: Pick<GoalState, 'id' | 'generation'>,
    goal: GoalState,
    assistantMessage: ChatMessage,
    signal: AbortSignal,
    onEvent: GoalCoordinatorRunOptions['onEvent']
  ): Promise<{ status: 'continue' } | { status: 'terminal'; result: GoalCoordinatorRunResult }> {
    const validationInvocationId = this.uuid()
    const validationClaim = this.dependencies.claimPhase(sessionId, {
      ...goalCas(goal),
      phase: 'validation',
      invocationId: validationInvocationId
    })
    if (!validationClaim.success || !validationClaim.goal) {
      return { status: 'terminal', result: { status: 'not-started', error: validationClaim.error } }
    }
    await onEvent({ type: 'goal-update', sessionId, goal: validationClaim.goal })

    let evaluated: GoalEvaluatorResult
    try {
      evaluated = await this.dependencies.evaluate({
        objective: validationClaim.goal.objective,
        generation: validationClaim.goal.generation,
        round: validationClaim.goal.currentRound,
        executionMessage: assistantMessage,
        signal
      })
    } catch (error) {
      return { status: 'terminal', result: this.pauseOwned(sessionId, identity, signal.aborted ? 'user-paused' : 'evaluation-error',
        signal.aborted ? undefined : boundedFeedback(errorMessage(error))) }
    }
    if (signal.aborted) return { status: 'terminal', result: this.pauseOwned(sessionId, identity, 'user-paused') }
    if (!evaluated.success) {
      return { status: 'terminal', result: this.pauseOwned(sessionId, identity, 'evaluation-error', boundedFeedback(evaluated.message)) }
    }

    const evaluationText = JSON.stringify(evaluated.evaluation)
    if (evaluationText.length > 16_000) {
      return { status: 'terminal', result: this.pauseOwned(sessionId, identity, 'evaluation-error', 'The evaluator response exceeded the durable Goal limit.') }
    }
    const feedback = evaluated.evaluation.nextFeedback.trim() || undefined
    const evaluationCommit = this.dependencies.commitEvaluation(sessionId, {
      ...goalCas(validationClaim.goal),
      invocationId: validationInvocationId,
      usageOperationId: this.uuid(),
      usage: evaluated.usage,
      outcome: evaluated.evaluation.decision,
      evaluation: evaluationText,
      ...(feedback ? { feedback } : {})
    })
    if (!evaluationCommit.success || !evaluationCommit.goal) {
      return { status: 'terminal', result: this.pauseOwned(sessionId, identity, 'evaluation-error', `Goal evaluation commit failed: ${evaluationCommit.error ?? 'invalid-transition'}`) }
    }
    await onEvent({ type: 'goal-update', sessionId, goal: evaluationCommit.goal })
    if (evaluationCommit.goal.status !== 'queued') return { status: 'terminal', result: terminalResult(evaluationCommit.goal) }
    return { status: 'continue' }
  }

  private latestExecutionMessage(sessionId: string, goal: GoalState): ChatMessage | undefined {
    const history = [...goal.history].reverse().find((entry) => entry.phase === 'execution' && entry.round === goal.currentRound && entry.messageId)
    return history?.messageId ? this.dependencies.getMessage(sessionId, history.messageId) : undefined
  }

  private pauseOwned(
    sessionId: string,
    identity: Pick<GoalState, 'id' | 'generation'>,
    stopReason: 'user-paused' | 'execution-error' | 'evaluation-error',
    feedback?: string
  ): GoalCoordinatorRunResult {
    const latest = this.dependencies.getGoal(sessionId)
    if (!latest) return { status: 'not-started', error: 'no-goal' }
    if (!sameGoalIdentity(latest, identity)) return { status: 'superseded', goal: latest }
    if (latest.status === 'paused') return { status: 'paused', goal: latest }
    const paused = this.dependencies.pause(sessionId, {
      ...goalCas(latest),
      stopReason,
      ...(feedback ? { feedback } : {})
    })
    if (!paused.success || !paused.goal) return { status: 'not-started', error: paused.error }
    return { status: 'paused', goal: paused.goal }
  }
}

function goalCas(goal: GoalState): GoalCas {
  return { goalId: goal.id, generation: goal.generation, revision: goal.revision }
}

function sameGoalIdentity(goal: GoalState, identity: Pick<GoalState, 'id' | 'generation'>): boolean {
  return goal.id === identity.id && goal.generation === identity.generation
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function terminalResult(goal: GoalState): GoalCoordinatorRunResult {
  if (goal.status === 'completed') return { status: 'completed', goal }
  if (goal.status === 'blocked') return { status: 'blocked', goal }
  if (goal.status === 'paused') return { status: 'paused', goal }
  if (goal.status === 'interrupted') return { status: 'interrupted', goal }
  return { status: 'not-started', error: 'invalid-transition' }
}

function boundedFeedback(value: string): string {
  const trimmed = value.trim() || 'Goal round failed.'
  return trimmed.slice(0, 8_000)
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined
  if (source.aborted) {
    target.abort()
    return () => undefined
  }
  const abort = (): void => target.abort()
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}
