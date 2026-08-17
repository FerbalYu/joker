import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, GoalState, GoalTransitionResult } from '../../shared/types'
import type { AgentRunResult } from '../agent/loop'
import type { GoalEvaluation } from './evaluator'
import { GoalCoordinator, type GoalCoordinatorDependencies } from './coordinator'

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'goal-1',
    objective: 'Ship a verified Goal loop',
    status: 'queued',
    generation: 1,
    revision: 0,
    currentRound: 1,
    history: [],
    currentInvocationIds: {},
    executionContext: { skillIds: [], reasoningLevel: 'auto' },
    cumulativeUsage: {},
    appliedUsageOperations: [],
    maxRounds: 3,
    tokenLimit: 100_000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function execution(messageId = 'message-1'): AgentRunResult {
  return {
    status: 'completed',
    messageId,
    text: 'Implemented and verified the requested change.',
    segments: [{ type: 'text', text: 'Implemented and verified the requested change.' }],
    toolCalls: [],
    usage: { totalTokens: 10 },
    durationMs: 1_200,
    steps: { count: 1, limit: 50, finishReason: 'stop' },
    finishReason: 'stop'
  }
}

function evaluation(decision: GoalEvaluation['decision'], nextFeedback = ''): GoalEvaluation {
  return {
    decision,
    criteria: [{ criterion: 'The change is implemented', satisfied: decision === 'complete' }],
    evidenceReferences: decision === 'complete' ? [{ source: 'assistant_quote', generation: 1, round: 1, messageId: 'message-1', quote: 'Implemented' }] : [],
    unmetCriteria: decision === 'complete' ? [] : ['The change is implemented'],
    nextFeedback
  }
}

function harness(
  decisions: GoalEvaluation['decision'][],
  executeResult?: () => AgentRunResult
): {
  coordinator: GoalCoordinator
  persistedMessages: ChatMessage[]
  order: string[]
  current: () => GoalState
} {
  let current = goal()
  const persistedMessages: ChatMessage[] = []
  const order: string[] = []
  let id = 0
  const result = (): GoalTransitionResult => ({ success: true, changed: true, goal: structuredClone(current) })
  const dependencies: GoalCoordinatorDependencies = {
    getGoal: () => structuredClone(current),
    getMessage: (_sessionId, messageId) => persistedMessages.find((message) => message.id === messageId),
    claimPhase: (_sessionId, input) => {
      order.push(`claim:${input.phase}`)
      current = {
        ...current,
        revision: current.revision + 1,
        status: input.phase === 'execution' ? 'executing' : 'validating',
        currentInvocationIds: input.phase === 'execution' ? { execution: input.invocationId } : { validation: input.invocationId }
      }
      return result()
    },
    commitExecution: (_sessionId, input) => {
      order.push('commit:execution')
      persistedMessages.push(input.message)
      current = { ...current, revision: current.revision + 1, status: 'validating', currentInvocationIds: {} }
      return result()
    },
    commitEvaluation: (_sessionId, input) => {
      order.push(`commit:evaluation:${input.outcome}`)
      current = input.outcome === 'continue'
        ? { ...current, revision: current.revision + 1, status: 'queued', currentRound: current.currentRound + 1, currentInvocationIds: {}, cumulativeUsage: { totalTokens: (current.cumulativeUsage.totalTokens ?? 0) + (input.usage?.totalTokens ?? 0) } }
        : { ...current, revision: current.revision + 1, status: input.outcome === 'complete' ? 'completed' : 'blocked', currentInvocationIds: {}, cumulativeUsage: { totalTokens: (current.cumulativeUsage.totalTokens ?? 0) + (input.usage?.totalTokens ?? 0) } }
      return result()
    },
    pause: (_sessionId, input) => {
      order.push(`pause:${input.stopReason}`)
      current = { ...current, revision: current.revision + 1, status: 'paused', currentInvocationIds: {}, stopReason: input.stopReason, feedback: input.feedback }
      return result()
    },
    execute: async () => {
      order.push('execute')
      return executeResult?.() ?? execution(`message-${current.currentRound}`)
    },
    evaluate: async () => {
      order.push(`evaluate:persisted=${persistedMessages.length}`)
      const decision = decisions.shift() ?? 'complete'
      return { success: true, evaluation: evaluation(decision, decision === 'continue' ? 'Run the next verification.' : ''), usage: { totalTokens: 3 }, finishReason: 'stop' }
    },
    now: () => 10,
    uuid: () => `id-${++id}`
  }
  return { coordinator: new GoalCoordinator(dependencies), persistedMessages, order, current: () => current }
}

void test('persists execution assistant before independent validation', async () => {
  const testHarness = harness(['complete'])
  const result = await testHarness.coordinator.run({ sessionId: 'session-1', onEvent: () => undefined })
  assert.equal(result.status, 'completed')
  assert.equal(testHarness.persistedMessages.length, 1)
  assert.deepEqual(testHarness.order, [
    'claim:execution',
    'execute',
    'commit:execution',
    'claim:validation',
    'evaluate:persisted=1',
    'commit:evaluation:complete'
  ])
})

void test('repetition output is committed before the Goal pauses without validation', async () => {
  const message = '继续。\n下一步。\n\n> 检测到重复输出，已自动停止。'
  const testHarness = harness([], () => ({
    status: 'repetition',
    messageId: 'message-repetition',
    text: message,
    segments: [{ type: 'text', text: message }],
    toolCalls: [],
    usage: { totalTokens: 12 },
    durationMs: 800,
    steps: { count: 1, limit: 50 },
    error: 'Model output was stopped because it entered a repetition loop'
  }))

  const result = await testHarness.coordinator.run({ sessionId: 'session-1', onEvent: () => undefined })

  assert.equal(result.status, 'paused')
  assert.equal(testHarness.persistedMessages.length, 1)
  assert.equal(testHarness.persistedMessages[0]?.content, message)
  assert.deepEqual(testHarness.order, [
    'claim:execution',
    'execute',
    'commit:execution',
    'pause:execution-error'
  ])
  assert.equal(testHarness.current().stopReason, 'execution-error')
  assert.match(testHarness.current().feedback ?? '', /repetition loop/)
})

void test('continues only after a committed independent continue decision', async () => {
  const testHarness = harness(['continue', 'complete'])
  const result = await testHarness.coordinator.run({ sessionId: 'session-1', onEvent: () => undefined })
  assert.equal(result.status, 'completed')
  assert.equal(testHarness.persistedMessages.length, 2)
  assert.equal(testHarness.current().currentRound, 2)
  assert.equal(testHarness.current().cumulativeUsage.totalTokens, 6)
  assert.equal(testHarness.order.filter((item) => item === 'execute').length, 2)
})

void test('stop aborts execution and durably pauses the latest Goal', async () => {
  let current = goal()
  let release: (() => void) | undefined
  const started = new Promise<void>((resolve) => { release = resolve })
  const dependencies: GoalCoordinatorDependencies = {
    getGoal: () => structuredClone(current),
    getMessage: () => undefined,
    claimPhase: (_sessionId, input) => {
      current = { ...current, revision: 1, status: 'executing', currentInvocationIds: { execution: input.invocationId } }
      return { success: true, goal: structuredClone(current) }
    },
    commitExecution: () => ({ success: false, error: 'invalid-transition' }),
    commitEvaluation: () => ({ success: false, error: 'invalid-transition' }),
    pause: (_sessionId, input) => {
      current = { ...current, revision: current.revision + 1, status: 'paused', currentInvocationIds: {}, stopReason: input.stopReason }
      return { success: true, goal: structuredClone(current) }
    },
    execute: async ({ signal }) => {
      release?.()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'aborted', text: '', segments: [], toolCalls: [], durationMs: 0, steps: { count: 0, limit: 50 } }
    },
    evaluate: async () => ({ success: false, error: 'model-error', message: 'unused', usage: {} }),
    uuid: () => 'invocation-1'
  }
  const coordinator = new GoalCoordinator(dependencies)
  const running = coordinator.run({ sessionId: 'session-1', onEvent: () => undefined })
  await started
  assert.equal(coordinator.stop('session-1'), true)
  const result = await running
  assert.equal(result.status, 'paused')
  assert.equal(current.stopReason, 'user-paused')
})

void test('stale aborted execution cannot pause a replacement Goal', async () => {
  let current = goal()
  let release: (() => void) | undefined
  const started = new Promise<void>((resolve) => { release = resolve })
  let pauseCalls = 0
  const coordinator = new GoalCoordinator({
    getGoal: () => structuredClone(current),
    getMessage: () => undefined,
    claimPhase: (_sessionId, input) => {
      current = { ...current, revision: current.revision + 1, status: 'executing', currentInvocationIds: { execution: input.invocationId } }
      return { success: true, goal: structuredClone(current) }
    },
    commitExecution: () => ({ success: false, error: 'stale-goal' }),
    commitEvaluation: () => ({ success: false, error: 'stale-goal' }),
    pause: () => { pauseCalls += 1; return { success: false, error: 'stale-goal' } },
    execute: async ({ signal }) => {
      release?.()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'aborted', text: '', segments: [], toolCalls: [], durationMs: 0, steps: { count: 0, limit: 50 } }
    },
    evaluate: async () => ({ success: false, error: 'model-error', message: 'unused', usage: {} }),
    uuid: () => 'old-invocation'
  })
  const running = coordinator.run({ sessionId: 'session-1', onEvent: () => undefined })
  await started
  current = goal({ id: 'goal-2', objective: 'Replacement', generation: 2, revision: 0 })
  coordinator.stop('session-1')
  const result = await running
  assert.equal(result.status, 'superseded')
  assert.equal(current.status, 'queued')
  assert.equal(pauseCalls, 0)
})

void test('execution setup failures durably pause the owned Goal', async () => {
  let current = goal()
  const coordinator = new GoalCoordinator({
    getGoal: () => structuredClone(current),
    getMessage: () => undefined,
    claimPhase: (_sessionId, input) => {
      current = { ...current, revision: current.revision + 1, status: 'executing', currentInvocationIds: { execution: input.invocationId } }
      return { success: true, goal: structuredClone(current) }
    },
    commitExecution: () => ({ success: false, error: 'invalid-transition' }),
    commitEvaluation: () => ({ success: false, error: 'invalid-transition' }),
    pause: (_sessionId, input) => {
      current = { ...current, revision: current.revision + 1, status: 'paused', currentInvocationIds: {}, stopReason: input.stopReason, feedback: input.feedback, resumePhase: 'execution' }
      return { success: true, goal: structuredClone(current) }
    },
    execute: async () => { throw new Error('Unavailable project') },
    evaluate: async () => ({ success: false, error: 'model-error', message: 'unused', usage: {} }),
    uuid: () => 'setup-invocation'
  })
  const result = await coordinator.run({ sessionId: 'session-1', onEvent: () => undefined })
  assert.equal(result.status, 'paused')
  assert.equal(current.stopReason, 'execution-error')
  assert.match(current.feedback ?? '', /Unavailable project/)
})

void test('resumed validation reuses the committed execution message without executing again', async () => {
  const message: ChatMessage = { id: 'message-1', role: 'assistant', content: 'Implemented evidence', createdAt: 2 }
  let current = goal({
    status: 'validating',
    revision: 3,
    history: [{ phase: 'execution', status: 'validating', round: 1, revision: 2, createdAt: 2, invocationId: 'execution-1', messageId: message.id }]
  })
  let executions = 0
  const coordinator = new GoalCoordinator({
    getGoal: () => structuredClone(current),
    getMessage: (_sessionId, messageId) => messageId === message.id ? message : undefined,
    claimPhase: (_sessionId, input) => {
      current = { ...current, revision: current.revision + 1, status: 'validating', currentInvocationIds: { validation: input.invocationId } }
      return { success: true, goal: structuredClone(current) }
    },
    commitExecution: () => ({ success: false, error: 'invalid-transition' }),
    commitEvaluation: (_sessionId, input) => {
      current = { ...current, revision: current.revision + 1, status: 'completed', currentInvocationIds: {}, completedAt: 10, stopReason: 'completed', cumulativeUsage: input.usage ?? {} }
      return { success: true, goal: structuredClone(current) }
    },
    pause: () => ({ success: false, error: 'invalid-transition' }),
    execute: async () => { executions += 1; return execution() },
    evaluate: async () => ({ success: true, evaluation: evaluation('complete'), usage: { totalTokens: 4 }, finishReason: 'stop' }),
    uuid: () => 'validation-resume'
  })
  const result = await coordinator.run({ sessionId: 'session-1', onEvent: () => undefined })
  assert.equal(result.status, 'completed')
  assert.equal(executions, 0)
  assert.equal(current.cumulativeUsage.totalTokens, 4)
})

void test('does not spend when persisted Goal is not explicitly queued', async () => {
  let executions = 0
  const interrupted = goal({ status: 'interrupted', stopReason: 'recovered-after-restart' })
  const dependencies = {
    ...harness([]),
    getGoal: () => interrupted
  }
  const coordinator = new GoalCoordinator({
    getGoal: dependencies.getGoal,
    getMessage: () => undefined,
    claimPhase: () => ({ success: false, error: 'invalid-transition' }),
    commitExecution: () => ({ success: false, error: 'invalid-transition' }),
    commitEvaluation: () => ({ success: false, error: 'invalid-transition' }),
    pause: () => ({ success: false, error: 'invalid-transition' }),
    execute: async () => { executions += 1; return execution() },
    evaluate: async () => ({ success: false, error: 'model-error', message: 'unused', usage: {} })
  })
  const result = await coordinator.run({ sessionId: 'session-1', onEvent: () => undefined })
  assert.equal(result.status, 'interrupted')
  assert.equal(executions, 0)
})
