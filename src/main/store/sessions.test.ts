import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendMessage,
  cancelPendingUserMessage,
  claimGoalPhase,
  claimNextPendingUserMessage,
  claimPendingUserMessage,
  clearGoal,
  commitGoalEvaluation,
  commitGoalExecution,
  completePendingUserMessage,
  createOrReplaceGoal,
  createSession,
  deleteSession,
  downgradePendingSteer,
  enqueuePendingUserMessage,
  getSession,
  inspectGoal,
  listPendingUserMessages,
  listSessions,
  markSessionRunActivitySeen,
  normalizeGoalRecovery,
  pauseGoal,
  replaceMessages,
  restorePendingUserMessageClaim,
  resumeGoal,
  steerPendingUserMessage,
  setContextCheckpoint,
  setSessionGoal,
  setSessionProject,
  setSessionsDataDirForTests,
  startSessionRunActivity,
  finishSessionRunActivity,
  getSessionRunActivity,
  hashSessionMessageRange,
  MAX_SESSION_GOAL_LENGTH
} from './sessions'
import { DEFAULT_CONTEXT_POLICY_VERSION } from '../../shared/context'
import { LEGACY_DEFAULT_GOAL_TOKEN_LIMIT } from '../goal/state'
import { hashChatMessages } from '../session-context'

const dataDir = mkdtempSync(join(tmpdir(), 'joker-sessions-'))

before(() => setSessionsDataDirForTests(dataDir))
after(() => setSessionsDataDirForTests(null))

test('session run activity persists terminal revisions and marks only observed completion seen', () => {
  const session = createSession('run activity')
  try {
    assert.deepEqual(getSessionRunActivity(session.id), {
      state: 'idle',
      terminalRevision: 0,
      seenTerminalRevision: 0
    })
    const running = startSessionRunActivity(session.id, 'run-one', 'chat', 100)
    assert.equal(running?.state, 'running')
    assert.equal(running?.runId, 'run-one')
    const completed = finishSessionRunActivity(session.id, 'run-one', 'completed', undefined, 200)
    assert.equal(completed?.terminalRevision, 1)
    assert.equal(completed?.seenTerminalRevision, 0)

    startSessionRunActivity(session.id, 'run-two', 'chat', 300)
    const failed = finishSessionRunActivity(session.id, 'run-two', 'failed', 'provider failed', 400)
    assert.equal(failed?.terminalRevision, 2)
    assert.equal(failed?.seenTerminalRevision, 0)

    const staleSeen = markSessionRunActivitySeen(session.id, 1)
    assert.equal(staleSeen?.terminalRevision, 2)
    assert.equal(staleSeen?.seenTerminalRevision, 1)
    const currentSeen = markSessionRunActivitySeen(session.id, 2)
    assert.equal(currentSeen?.seenTerminalRevision, 2)
  } finally {
    deleteSession(session.id)
  }
})

test('persisted running session activity recovers as interrupted after restart', () => {
  const session = createSession('run activity recovery')
  try {
    startSessionRunActivity(session.id, 'run-restart', 'goal', 500)
    setSessionsDataDirForTests(null)
    setSessionsDataDirForTests(dataDir)
    const recovered = getSessionRunActivity(session.id)
    assert.equal(recovered?.state, 'interrupted')
    assert.equal(recovered?.terminalRevision, 1)
    assert.equal(recovered?.seenTerminalRevision, 0)
    assert.equal(recovered?.error, 'recovered-after-restart')
  } finally {
    deleteSession(session.id)
  }
})

test('session goal saves trimmed text, clears on empty input, and is exposed by get/list', () => {
  const session = createSession('session goal test')
  try {
    assert.deepEqual(setSessionGoal(session.id, '  Ship the plan semantics  '), { success: true, goal: 'Ship the plan semantics' })
    assert.equal(getSession(session.id)?.goal?.objective, 'Ship the plan semantics')
    assert.equal(getSession(session.id)?.goal?.status, 'queued')
    assert.equal(listSessions().find((item) => item.id === session.id)?.goal?.objective, 'Ship the plan semantics')

    assert.deepEqual(setSessionGoal(session.id, '   '), { success: true })
    assert.equal(getSession(session.id)?.goal, undefined)
    assert.equal(listSessions().find((item) => item.id === session.id)?.goal, undefined)
  } finally {
    deleteSession(session.id)
  }
})

test('inspectGoal returns a detached current snapshot without mutating revision', () => {
  const session = createSession('goal inspect')
  try {
    assert.deepEqual(inspectGoal(session.id), { success: false, error: 'no-goal' })
    assert.deepEqual(inspectGoal('missing-session'), { success: false, error: 'invalid-session' })
    const created = createOrReplaceGoal(session.id, 'Inspect safely').goal!
    const inspected = inspectGoal(session.id)
    assert.equal(inspected.success, true)
    assert.equal(inspected.changed, false)
    assert.deepEqual(inspected.goal, created)
    inspected.goal!.objective = 'mutated caller copy'
    assert.equal(getSession(session.id)?.goal?.objective, 'Inspect safely')
    assert.equal(getSession(session.id)?.goal?.revision, created.revision)
  } finally {
    deleteSession(session.id)
  }
})

test('session goal validates type and maximum length without changing stored state', () => {
  const session = createSession('session goal validation')
  try {
    assert.deepEqual(setSessionGoal(session.id, 'valid'), { success: true, goal: 'valid' })
    assert.deepEqual(setSessionGoal(session.id, 42), { success: false, error: 'invalid-goal' })
    assert.deepEqual(setSessionGoal(session.id, 'x'.repeat(MAX_SESSION_GOAL_LENGTH + 1)), { success: false, error: 'invalid-goal' })
    assert.equal(getSession(session.id)?.goal?.objective, 'valid')
    assert.deepEqual(setSessionGoal('missing-session', 'goal'), { success: false, error: 'invalid-session' })
  } finally {
    deleteSession(session.id)
  }
})

test('session goal persists across store reloads', () => {
  const session = createSession('session goal restart')
  try {
    assert.deepEqual(setSessionGoal(session.id, 'Persist across restart'), { success: true, goal: 'Persist across restart' })
    setSessionsDataDirForTests(null)
    setSessionsDataDirForTests(dataDir)
    assert.equal(getSession(session.id)?.goal?.objective, 'Persist across restart')
  } finally {
    deleteSession(session.id)
  }
})

test('goals are unlimited unless a token limit is explicitly provided', () => {
  const unlimitedSession = createSession('goal without token limit')
  const limitedSession = createSession('goal with explicit token limit')
  try {
    const unlimited = createOrReplaceGoal(unlimitedSession.id, 'Do not invent a token limit').goal!
    assert.equal(unlimited.tokenLimit, undefined)
    const unlimitedStored = JSON.parse(readFileSync(join(dataDir, `${unlimitedSession.id}.json`), 'utf8'))
    assert.equal(unlimitedStored.schemaVersion, 7)
    assert.equal(Object.hasOwn(unlimitedStored.data.goal, 'tokenLimit'), false)

    const limited = createOrReplaceGoal(limitedSession.id, {
      objective: 'Respect the explicit token limit',
      tokenLimit: LEGACY_DEFAULT_GOAL_TOKEN_LIMIT
    }).goal!
    assert.equal(limited.tokenLimit, LEGACY_DEFAULT_GOAL_TOKEN_LIMIT)
    setSessionsDataDirForTests(null)
    setSessionsDataDirForTests(dataDir)
    assert.equal(getSession(unlimitedSession.id)?.goal?.tokenLimit, undefined)
    assert.equal(getSession(limitedSession.id)?.goal?.tokenLimit, LEGACY_DEFAULT_GOAL_TOKEN_LIMIT)
  } finally {
    deleteSession(unlimitedSession.id)
    deleteSession(limitedSession.id)
  }
})

test('unlimited goals continue beyond the former default token limit', () => {
  const session = createSession('goal unlimited usage')
  try {
    const created = createOrReplaceGoal(session.id, { objective: 'Continue without an invented limit', maxRounds: 2 }).goal!
    const executing = claimGoalPhase(session.id, {
      goalId: created.id, generation: created.generation, revision: created.revision,
      phase: 'execution', invocationId: 'execute-unlimited'
    }).goal!
    const committed = commitGoalExecution(session.id, {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      invocationId: 'execute-unlimited', usageOperationId: 'usage-unlimited',
      message: { id: 'message-unlimited', role: 'assistant', content: 'large result', createdAt: 12 },
      usage: { totalTokens: LEGACY_DEFAULT_GOAL_TOKEN_LIMIT + 1 }
    }).goal!
    assert.equal(committed.status, 'validating')
    assert.equal(committed.stopReason, undefined)
    const validating = claimGoalPhase(session.id, {
      goalId: committed.id, generation: committed.generation, revision: committed.revision,
      phase: 'validation', invocationId: 'validate-unlimited'
    }).goal!
    const continued = commitGoalEvaluation(session.id, {
      goalId: validating.id, generation: validating.generation, revision: validating.revision,
      invocationId: 'validate-unlimited', usageOperationId: 'evaluation-unlimited',
      usage: { totalTokens: LEGACY_DEFAULT_GOAL_TOKEN_LIMIT + 1 }, outcome: 'continue', evaluation: 'continue safely'
    }).goal!
    assert.equal(continued.status, 'queued')
    assert.equal(continued.currentRound, 2)
    assert.equal(continued.stopReason, undefined)
  } finally {
    deleteSession(session.id)
  }
})

test('goal CAS rejects stale revisions and invocation ids across execution and validation', () => {
  const session = createSession('goal cas fencing')
  try {
    const created = createOrReplaceGoal(session.id, {
      objective: 'Implement the persistent state machine',
      executionContext: { projectId: 'project_1234', skillIds: ['engineering'], reasoningLevel: 'high' },
      maxRounds: 3,
      tokenLimit: 10_000
    })
    assert.equal(created.success, true)
    assert.equal(created.goal?.generation, 1)
    const initial = created.goal!
    const execution = claimGoalPhase(session.id, {
      goalId: initial.id, generation: initial.generation, revision: initial.revision,
      phase: 'execution', invocationId: 'execution-1'
    })
    assert.equal(execution.goal?.status, 'executing')
    assert.deepEqual(claimGoalPhase(session.id, {
      goalId: initial.id, generation: initial.generation, revision: initial.revision,
      phase: 'execution', invocationId: 'execution-stale'
    }), { success: false, error: 'stale-goal' })

    const executing = execution.goal!
    assert.deepEqual(commitGoalExecution(session.id, {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      invocationId: 'wrong-execution', usageOperationId: 'usage-wrong',
      message: { id: 'assistant-wrong', role: 'assistant', content: 'wrong', createdAt: 10 }, usage: { totalTokens: 1 }
    }), { success: false, error: 'invalid-transition' })

    const committed = commitGoalExecution(session.id, {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      invocationId: 'execution-1', usageOperationId: 'usage-1',
      message: { id: 'assistant-1', role: 'assistant', content: 'implemented', createdAt: 11 },
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }
    })
    assert.equal(committed.goal?.status, 'validating')
    const validating = claimGoalPhase(session.id, {
      goalId: committed.goal!.id, generation: committed.goal!.generation, revision: committed.goal!.revision,
      phase: 'validation', invocationId: 'validation-1'
    })
    assert.equal(validating.goal?.currentInvocationIds.validation, 'validation-1')
    assert.deepEqual(commitGoalEvaluation(session.id, {
      goalId: validating.goal!.id, generation: validating.goal!.generation, revision: validating.goal!.revision,
      invocationId: 'validation-late', outcome: 'complete', evaluation: 'looks good'
    }), { success: false, error: 'invalid-transition' })
    const continued = commitGoalEvaluation(session.id, {
      goalId: validating.goal!.id, generation: validating.goal!.generation, revision: validating.goal!.revision,
      invocationId: 'validation-1', outcome: 'continue', evaluation: 'One more pass is needed', feedback: 'Add a recovery assertion'
    })
    assert.equal(continued.goal?.status, 'queued')
    assert.equal(continued.goal?.currentRound, 2)
    assert.equal(continued.goal?.feedback, 'Add a recovery assertion')
  } finally {
    deleteSession(session.id)
  }
})

test('execution commit appends message and usage exactly once for an idempotency operation', () => {
  const session = createSession('goal idempotency')
  try {
    const created = createOrReplaceGoal(session.id, 'Commit once').goal!
    const executing = claimGoalPhase(session.id, {
      goalId: created.id, generation: created.generation, revision: created.revision,
      phase: 'execution', invocationId: 'execution-idempotent'
    }).goal!
    const input = {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      invocationId: 'execution-idempotent', usageOperationId: 'usage-idempotent',
      message: { id: 'assistant-idempotent', role: 'assistant' as const, content: 'one result', createdAt: 20 },
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }
    }
    const first = commitGoalExecution(session.id, input)
    assert.equal(first.changed, true)
    const replay = commitGoalExecution(session.id, input)
    assert.equal(replay.success, true)
    assert.equal(replay.changed, false)
    const stored = getSession(session.id)!
    assert.equal(stored.messages.filter((message) => message.id === input.message.id).length, 1)
    assert.deepEqual(stored.goal?.cumulativeUsage, input.usage)
    assert.equal(stored.goal?.appliedUsageOperations.length, 1)
    assert.deepEqual(commitGoalExecution(session.id, { ...input, usage: { totalTokens: 13 } }), { success: false, error: 'conflict' })
  } finally {
    deleteSession(session.id)
  }
})

test('pause, replace, and clear fence late execution results with revision and generation', () => {
  const session = createSession('goal lifecycle fences')
  try {
    const first = createOrReplaceGoal(session.id, 'First objective').goal!
    const executing = claimGoalPhase(session.id, {
      goalId: first.id, generation: first.generation, revision: first.revision,
      phase: 'execution', invocationId: 'execution-first'
    }).goal!
    const paused = pauseGoal(session.id, {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      stopReason: 'user-paused'
    }).goal!
    assert.equal(paused.status, 'paused')
    assert.deepEqual(commitGoalExecution(session.id, {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      invocationId: 'execution-first', usageOperationId: 'late-paused',
      message: { id: 'late-paused-message', role: 'assistant', content: 'late', createdAt: 30 }
    }), { success: false, error: 'stale-goal' })
    const resumed = resumeGoal(session.id, {
      goalId: paused.id, generation: paused.generation, revision: paused.revision
    }).goal!
    assert.equal(resumed.status, 'queued')

    const second = createOrReplaceGoal(session.id, 'Replacement objective').goal!
    assert.equal(second.generation, first.generation + 1)
    assert.deepEqual(commitGoalExecution(session.id, {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      invocationId: 'execution-first', usageOperationId: 'late-replaced',
      message: { id: 'late-replaced-message', role: 'assistant', content: 'late', createdAt: 31 }
    }), { success: false, error: 'stale-goal' })
    assert.equal(clearGoal(session.id, { goalId: second.id, generation: second.generation, revision: second.revision }).success, true)
    assert.equal(getSession(session.id)?.goal, undefined)
    const third = createOrReplaceGoal(session.id, 'After clear').goal!
    assert.equal(third.generation, second.generation + 1)
    assert.deepEqual(commitGoalExecution(session.id, {
      goalId: second.id, generation: second.generation, revision: second.revision,
      invocationId: 'execution-second', usageOperationId: 'late-cleared',
      message: { id: 'late-cleared-message', role: 'assistant', content: 'late', createdAt: 32 }
    }), { success: false, error: 'stale-goal' })
  } finally {
    deleteSession(session.id)
  }
})

test('recovery normalizes active invocations to interrupted once and fences their late results', () => {
  const session = createSession('goal recovery')
  try {
    const created = createOrReplaceGoal(session.id, 'Recover after restart').goal!
    const executing = claimGoalPhase(session.id, {
      goalId: created.id, generation: created.generation, revision: created.revision,
      phase: 'execution', invocationId: 'execution-recovery'
    }).goal!
    setSessionsDataDirForTests(null)
    setSessionsDataDirForTests(dataDir)
    const recovered = getSession(session.id)?.goal
    assert.equal(recovered?.status, 'interrupted')
    assert.equal(recovered?.stopReason, 'recovered-after-restart')
    assert.equal(recovered?.tokenLimit, undefined)
    assert.deepEqual(recovered?.currentInvocationIds, {})
    assert.equal(recovered?.revision, executing.revision + 1)
    assert.equal(getSession(session.id)?.goal?.revision, recovered?.revision)
    assert.equal(normalizeGoalRecovery(session.id).changed, false)
    assert.deepEqual(commitGoalExecution(session.id, {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      invocationId: 'execution-recovery', usageOperationId: 'late-recovery',
      message: { id: 'late-recovery-message', role: 'assistant', content: 'late', createdAt: 40 }
    }), { success: false, error: 'stale-goal' })
  } finally {
    deleteSession(session.id)
  }
})

test('execution crossing the token limit blocks before validation', () => {
  const session = createSession('goal execution limit')
  try {
    const created = createOrReplaceGoal(session.id, { objective: 'Bound execution', tokenLimit: 5 }).goal!
    const executing = claimGoalPhase(session.id, { goalId: created.id, generation: created.generation, revision: created.revision, phase: 'execution', invocationId: 'execute-limit' }).goal!
    const committed = commitGoalExecution(session.id, {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      invocationId: 'execute-limit', usageOperationId: 'usage-limit',
      message: { id: 'message-limit', role: 'assistant', content: 'result', createdAt: 40 }, usage: { totalTokens: 5 }
    }).goal!
    assert.equal(committed.status, 'blocked')
    assert.equal(committed.stopReason, 'token-limit')
    assert.deepEqual(claimGoalPhase(session.id, { goalId: committed.id, generation: committed.generation, revision: committed.revision, phase: 'validation', invocationId: 'validate-limit' }), { success: false, error: 'invalid-transition' })
  } finally {
    deleteSession(session.id)
  }
})

test('evaluation usage is durable and contributes to the token limit', () => {
  const session = createSession('goal evaluator usage')
  try {
    const created = createOrReplaceGoal(session.id, { objective: 'Count validation', maxRounds: 2, tokenLimit: 10 }).goal!
    const executing = claimGoalPhase(session.id, {
      goalId: created.id, generation: created.generation, revision: created.revision,
      phase: 'execution', invocationId: 'execute-usage'
    }).goal!
    const committed = commitGoalExecution(session.id, {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      invocationId: 'execute-usage', usageOperationId: 'execution-usage',
      message: { id: 'message-usage', role: 'assistant', content: 'evidence', createdAt: 50 },
      usage: { totalTokens: 6 }
    }).goal!
    const validating = claimGoalPhase(session.id, {
      goalId: committed.id, generation: committed.generation, revision: committed.revision,
      phase: 'validation', invocationId: 'validate-usage'
    }).goal!
    const result = commitGoalEvaluation(session.id, {
      goalId: validating.id, generation: validating.generation, revision: validating.revision,
      invocationId: 'validate-usage', usageOperationId: 'evaluation-usage', usage: { inputTokens: 3, outputTokens: 2 },
      outcome: 'continue', evaluation: 'more work'
    })
    assert.equal(result.goal?.status, 'blocked')
    assert.equal(result.goal?.stopReason, 'token-limit')
    assert.equal(result.goal?.cumulativeUsage.totalTokens, 11)
    assert.equal(result.goal?.appliedUsageOperations.at(-1)?.phase, 'validation')
  } finally {
    deleteSession(session.id)
  }
})

test('resume preserves validation phase and cannot bypass hard limits', () => {
  for (const reason of ['max-rounds', 'token-limit'] as const) {
    const session = createSession(`goal hard limit ${reason}`)
    try {
      const created = createOrReplaceGoal(session.id, 'Hard limit').goal!
      const blocked = { ...created, status: 'blocked' as const, stopReason: reason }
      const path = join(dataDir, `${session.id}.json`)
      writeFileSync(path, JSON.stringify({ schemaVersion: 4, data: { ...getSession(session.id), goal: blocked } }), 'utf8')
      assert.deepEqual(resumeGoal(session.id, { goalId: blocked.id, generation: blocked.generation, revision: blocked.revision }), { success: false, error: 'invalid-transition' })
    } finally {
      deleteSession(session.id)
    }
  }

  const session = createSession('goal validation resume')
  try {
    const created = createOrReplaceGoal(session.id, 'Resume validation').goal!
    const executing = claimGoalPhase(session.id, { goalId: created.id, generation: created.generation, revision: created.revision, phase: 'execution', invocationId: 'execute-resume' }).goal!
    const committed = commitGoalExecution(session.id, {
      goalId: executing.id, generation: executing.generation, revision: executing.revision,
      invocationId: 'execute-resume', usageOperationId: 'usage-resume',
      message: { id: 'message-resume', role: 'assistant', content: 'evidence', createdAt: 60 }
    }).goal!
    const paused = pauseGoal(session.id, { goalId: committed.id, generation: committed.generation, revision: committed.revision, stopReason: 'user-paused' }).goal!
    assert.equal(paused.resumePhase, 'validation')
    const resumed = resumeGoal(session.id, { goalId: paused.id, generation: paused.generation, revision: paused.revision }).goal!
    assert.equal(resumed.status, 'validating')
    assert.equal(resumed.resumePhase, undefined)
  } finally {
    deleteSession(session.id)
  }
})

test('goal evaluation completes or blocks at hard round and token limits', () => {
  for (const scenario of [
    { name: 'complete', maxRounds: 2, tokenLimit: 100, usage: 5, outcome: 'complete' as const, status: 'completed', reason: 'completed' },
    { name: 'round', maxRounds: 1, tokenLimit: 100, usage: 5, outcome: 'continue' as const, status: 'blocked', reason: 'max-rounds' },
    { name: 'tokens', maxRounds: 2, tokenLimit: 5, usage: 5, outcome: 'continue' as const, status: 'blocked', reason: 'token-limit' },
    { name: 'blocked', maxRounds: 2, tokenLimit: 100, usage: 5, outcome: 'blocked' as const, status: 'blocked', reason: 'evaluator-blocked' }
  ]) {
    const session = createSession(`goal evaluation ${scenario.name}`)
    try {
      const created = createOrReplaceGoal(session.id, { objective: scenario.name, maxRounds: scenario.maxRounds, tokenLimit: scenario.tokenLimit }).goal!
      const executing = claimGoalPhase(session.id, {
        goalId: created.id, generation: created.generation, revision: created.revision,
        phase: 'execution', invocationId: `execute-${scenario.name}`
      }).goal!
      const committed = commitGoalExecution(session.id, {
        goalId: executing.id, generation: executing.generation, revision: executing.revision,
        invocationId: `execute-${scenario.name}`, usageOperationId: `usage-${scenario.name}`,
        message: { id: `message-${scenario.name}`, role: 'assistant', content: scenario.name, createdAt: 50 },
        usage: { totalTokens: scenario.usage }
      }).goal!
      if (committed.status === 'blocked') {
        assert.equal(committed.status, scenario.status)
        assert.equal(committed.stopReason, scenario.reason)
        continue
      }
      const validating = claimGoalPhase(session.id, {
        goalId: committed.id, generation: committed.generation, revision: committed.revision,
        phase: 'validation', invocationId: `validate-${scenario.name}`
      }).goal!
      const result = commitGoalEvaluation(session.id, {
        goalId: validating.id, generation: validating.generation, revision: validating.revision,
        invocationId: `validate-${scenario.name}`, outcome: scenario.outcome, evaluation: 'bounded evaluation'
      })
      assert.equal(result.goal?.status, scenario.status)
      assert.equal(result.goal?.stopReason, scenario.reason)
    } finally {
      deleteSession(session.id)
    }
  }
})

test('sessions start without a project and can bind then clear one', () => {
  const session = createSession('session project test')
  try {
    assert.equal(session.projectId, undefined)
    assert.equal(setSessionProject(session.id, 'missing-project'), false)
    assert.equal(setSessionProject(session.id, null), true)
    assert.equal(getSession(session.id)?.projectId, undefined)
  } finally {
    deleteSession(session.id)
  }
})

test('legacy sessions migrate pending queue and activity defaults and write schema v7', () => {
  const id = `legacy-queue-${crypto.randomUUID()}`
  const legacy = { id, title: 'Legacy queue', createdAt: 1, updatedAt: 2, messages: [] }
  const path = join(dataDir, `${id}.json`)
  writeFileSync(path, JSON.stringify({ schemaVersion: 4, data: legacy }), 'utf8')
  const loaded = getSession(id)
  assert.deepEqual(loaded?.pendingUserMessages, [])
  assert.equal(loaded?.messageQueueRevision, 0)
  assert.equal(enqueuePendingUserMessage(id, {
    mode: 'queue', message: { id: 'legacy-pending', role: 'user', content: 'later', createdAt: 3 }
  }).success, true)
  const stored = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(stored.schemaVersion, 7)
  assert.deepEqual(stored.data.runActivity, { state: 'idle', terminalRevision: 0, seenTerminalRevision: 0 })
  assert.equal(stored.data.messageQueueRevision, 1)
  assert.equal(stored.data.pendingUserMessages[0].message.id, 'legacy-pending')
  deleteSession(id)
})

test('pending user messages enqueue idempotently, remain outside canonical messages, and claim FIFO', () => {
  const session = createSession('pending fifo')
  try {
    const first = { id: 'pending-first', role: 'user' as const, content: 'first', createdAt: 10 }
    const second = { id: 'pending-second', role: 'user' as const, content: 'second', createdAt: 11 }
    const firstEnqueue = enqueuePendingUserMessage(session.id, { mode: 'queue', message: first })
    const replay = enqueuePendingUserMessage(session.id, { mode: 'queue', message: first })
    const secondEnqueue = enqueuePendingUserMessage(session.id, { mode: 'queue', message: second })
    assert.equal(firstEnqueue.changed, true)
    assert.equal(replay.changed, false)
    assert.equal(replay.messageQueueRevision, firstEnqueue.messageQueueRevision)
    assert.equal(secondEnqueue.pendingMessage?.sequence, firstEnqueue.pendingMessage!.sequence + 1)
    assert.deepEqual(getSession(session.id)?.messages, [])
    assert.deepEqual(listPendingUserMessages(session.id).pending.map((pending) => pending.message.id), [first.id, second.id])
    assert.equal(claimPendingUserMessage(session.id, second.id, 'run-next').error, 'invalid-order')

    assert.equal(appendMessage(session.id, { id: 'assistant-before-claim', role: 'assistant', content: 'durable result', createdAt: 12 }), true)
    const claimedFirst = claimNextPendingUserMessage(session.id, 'run-next')
    const claimedSecond = claimNextPendingUserMessage(session.id, 'run-next')
    assert.equal(claimedFirst.pendingMessage?.message.id, first.id)
    assert.equal(claimedSecond.pendingMessage?.message.id, second.id)
    assert.deepEqual(getSession(session.id)?.messages.map((message) => message.id), ['assistant-before-claim', first.id, second.id])
    assert.deepEqual(listPendingUserMessages(session.id).pending, [])
    assert.equal(claimNextPendingUserMessage(session.id, 'run-next').error, 'not-found')
  } finally {
    deleteSession(session.id)
  }
})

test('pending cancellation only removes queued messages and claim replay is idempotent', () => {
  const session = createSession('pending cancel')
  try {
    const cancelled = { id: 'pending-cancelled', role: 'user' as const, content: 'cancel me', createdAt: 20 }
    const claimed = { id: 'pending-claimed', role: 'user' as const, content: 'claim me', createdAt: 21 }
    assert.equal(enqueuePendingUserMessage(session.id, { mode: 'queue', message: cancelled }).success, true)
    assert.equal(enqueuePendingUserMessage(session.id, { mode: 'queue', message: claimed }).success, true)
    assert.equal(cancelPendingUserMessage(session.id, cancelled.id).success, true)
    assert.equal(cancelPendingUserMessage(session.id, cancelled.id).error, 'not-found')
    const firstClaim = claimPendingUserMessage(session.id, claimed.id, 'run-claim')
    const replay = claimPendingUserMessage(session.id, claimed.id, 'run-claim')
    assert.equal(firstClaim.changed, true)
    assert.equal(replay.changed, false)
    assert.equal(cancelPendingUserMessage(session.id, claimed.id).error, 'not-queued')
    assert.equal(getSession(session.id)?.messages.filter((message) => message.id === claimed.id).length, 1)
    assert.equal(completePendingUserMessage(session.id, claimed.id, 'run-other').error, 'conflict')
    const beforeCompletionRevision = getSession(session.id)!.messageQueueRevision
    const completed = completePendingUserMessage(session.id, claimed.id, 'run-claim')
    assert.equal(completed.success, true)
    assert.equal(completed.messageQueueRevision, beforeCompletionRevision + 1)
    assert.equal(getSession(session.id)?.pendingUserMessages.some((pending) => pending.message.id === claimed.id), false)
    assert.equal(getSession(session.id)?.messages.filter((message) => message.id === claimed.id).length, 1)
  } finally {
    deleteSession(session.id)
  }
})

test('queued messages can be promoted individually to steer the active run', () => {
  const session = createSession('pending promotion')
  try {
    const first = { id: 'pending-promote-first', role: 'user' as const, content: 'first queued', createdAt: 25 }
    const second = { id: 'pending-promote-second', role: 'user' as const, content: 'second queued', createdAt: 26 }
    assert.equal(enqueuePendingUserMessage(session.id, { mode: 'queue', message: first }).success, true)
    assert.equal(enqueuePendingUserMessage(session.id, { mode: 'queue', message: second }).success, true)

    const promoted = steerPendingUserMessage(session.id, second.id, 'run-active')
    assert.equal(promoted.pendingMessage?.mode, 'steer')
    assert.equal(promoted.pendingMessage?.targetRunId, 'run-active')
    assert.equal(steerPendingUserMessage(session.id, second.id, 'run-active').changed, false)
    assert.equal(steerPendingUserMessage(session.id, second.id, 'run-other').error, 'conflict')
    assert.equal(claimPendingUserMessage(session.id, second.id, 'run-active').success, true)
    assert.equal(claimNextPendingUserMessage(session.id, 'run-queue').pendingMessage?.message.id, first.id)
    assert.deepEqual(getSession(session.id)?.messages.map((message) => message.id), [second.id, first.id])
  } finally {
    deleteSession(session.id)
  }
})

test('restart reconciliation restores orphan claims and steers idempotently', () => {
  const session = createSession('pending restart reconciliation')
  try {
    const queued = { id: 'pending-recovery-queue', role: 'user' as const, content: 'queue later', createdAt: 35 }
    const steer = { id: 'pending-recovery-steer', role: 'user' as const, content: 'steer now', createdAt: 36 }
    assert.equal(enqueuePendingUserMessage(session.id, { mode: 'queue', message: queued }).success, true)
    assert.equal(enqueuePendingUserMessage(session.id, { mode: 'steer', targetRunId: 'run-crashed', message: steer }).success, true)
    assert.equal(claimPendingUserMessage(session.id, queued.id, 'run-crashed').success, true)
    const beforeRestartRevision = getSession(session.id)!.messageQueueRevision

    setSessionsDataDirForTests(null)
    setSessionsDataDirForTests(dataDir)
    const recovered = getSession(session.id)!
    assert.deepEqual(recovered.messages, [])
    assert.deepEqual(recovered.pendingUserMessages.map((pending) => ({
      id: pending.message.id,
      mode: pending.mode,
      status: pending.status,
      targetRunId: pending.targetRunId,
      claimedByRunId: pending.claimedByRunId
    })), [
      { id: queued.id, mode: 'queue', status: 'queued', targetRunId: undefined, claimedByRunId: undefined },
      { id: steer.id, mode: 'queue', status: 'queued', targetRunId: undefined, claimedByRunId: undefined }
    ])
    assert.equal(recovered.messageQueueRevision, beforeRestartRevision + 1)
    const storedAfterFirstRecovery = readFileSync(join(dataDir, `${session.id}.json`), 'utf8')
    assert.equal(getSession(session.id)?.messageQueueRevision, recovered.messageQueueRevision)
    assert.equal(readFileSync(join(dataDir, `${session.id}.json`), 'utf8'), storedAfterFirstRecovery)
  } finally {
    deleteSession(session.id)
  }
})

test('specific steer claim, downgrade, and restore preserve canonical ordering', () => {
  const session = createSession('pending steer')
  try {
    const queued = { id: 'pending-ordinary', role: 'user' as const, content: 'ordinary', createdAt: 30 }
    const steer = { id: 'pending-steer', role: 'user' as const, content: 'steer now', createdAt: 31 }
    assert.equal(appendMessage(session.id, { id: 'canonical-user', role: 'user', content: 'start', createdAt: 28 }), true)
    assert.equal(appendMessage(session.id, { id: 'canonical-assistant', role: 'assistant', content: 'working', createdAt: 29 }), true)
    assert.equal(enqueuePendingUserMessage(session.id, { mode: 'queue', message: queued }).success, true)
    assert.equal(enqueuePendingUserMessage(session.id, { mode: 'steer', targetRunId: 'run-target', message: steer }).success, true)
    assert.equal(claimPendingUserMessage(session.id, steer.id, 'run-other').error, 'conflict')
    assert.equal(claimPendingUserMessage(session.id, steer.id, 'run-target').success, true)
    assert.deepEqual(getSession(session.id)?.messages.map((message) => message.id), ['canonical-user', 'canonical-assistant', steer.id])
    assert.equal(restorePendingUserMessageClaim(session.id, steer.id, 'run-target').success, true)
    assert.deepEqual(getSession(session.id)?.messages.map((message) => message.id), ['canonical-user', 'canonical-assistant'])
    const downgraded = downgradePendingSteer(session.id, steer.id)
    assert.equal(downgraded.pendingMessage?.mode, 'queue')
    assert.equal(downgraded.pendingMessage?.targetRunId, undefined)
    assert.deepEqual(listPendingUserMessages(session.id).pending.map((pending) => pending.message.id), [queued.id, steer.id])
    assert.equal(claimNextPendingUserMessage(session.id, 'run-queue').pendingMessage?.message.id, queued.id)
    assert.equal(claimNextPendingUserMessage(session.id, 'run-queue').pendingMessage?.message.id, steer.id)
    assert.deepEqual(getSession(session.id)?.messages.map((message) => message.id), [
      'canonical-user', 'canonical-assistant', queued.id, steer.id
    ])
  } finally {
    deleteSession(session.id)
  }
})

test('reads legacy JSON and writes the schema-versioned envelope', () => {
  const id = `legacy-${crypto.randomUUID()}`
  const legacy = { id, title: 'Legacy', createdAt: 1, updatedAt: 2, messages: [] }
  writeFileSync(join(dataDir, `${id}.json`), JSON.stringify(legacy), 'utf8')
  assert.deepEqual(getSession(id), { ...legacy, pendingUserMessages: [], messageQueueRevision: 0, runActivity: { state: 'idle', terminalRevision: 0, seenTerminalRevision: 0 } })
  assert.equal(appendMessage(id, { id: 'm1', role: 'user', content: 'hello', createdAt: 3 }), true)
  const stored = JSON.parse(readFileSync(join(dataDir, `${id}.json`), 'utf8'))
  assert.equal(stored.schemaVersion, 7)
  assert.equal(stored.data.id, id)
  deleteSession(id)
})

test('legacy string goals migrate to interrupted structured state and never auto-run', () => {
  const id = `legacy-goal-${crypto.randomUUID()}`
  const data = { id, title: 'Legacy goal', createdAt: 1, updatedAt: 2, goal: 'Finish the migration safely', messages: [] }
  writeFileSync(join(dataDir, `${id}.json`), JSON.stringify({ schemaVersion: 3, data }), 'utf8')
  const loaded = getSession(id)
  assert.equal(loaded?.goal?.objective, 'Finish the migration safely')
  assert.equal(loaded?.goal?.status, 'interrupted')
  assert.equal(loaded?.goal?.stopReason, 'legacy-migration')
  assert.equal(loaded?.goal?.tokenLimit, undefined)
  assert.deepEqual(loaded?.goal?.currentInvocationIds, {})
  const stored = JSON.parse(readFileSync(join(dataDir, `${id}.json`), 'utf8'))
  assert.equal(stored.schemaVersion, 7)
    assert.equal(stored.data.goal.status, 'interrupted')
    assert.deepEqual(claimGoalPhase(id, {
      goalId: loaded!.goal!.id,
      generation: loaded!.goal!.generation,
      revision: loaded!.goal!.revision,
      phase: 'execution',
      invocationId: 'legacy-auto-run'
    }), { success: false, error: 'invalid-transition' })
    deleteSession(id)

})

test('pre-v7 default token limits migrate to unlimited while other limits remain explicit', () => {
  for (const [tokenLimit, expected] of [
    [LEGACY_DEFAULT_GOAL_TOKEN_LIMIT, undefined],
    [LEGACY_DEFAULT_GOAL_TOKEN_LIMIT - 1, LEGACY_DEFAULT_GOAL_TOKEN_LIMIT - 1]
  ] as const) {
    const session = createSession(`legacy token limit ${tokenLimit}`)
    try {
      createOrReplaceGoal(session.id, { objective: 'Migrate the legacy token limit', tokenLimit })
      const path = join(dataDir, `${session.id}.json`)
      const stored = JSON.parse(readFileSync(path, 'utf8'))
      stored.schemaVersion = 6
      writeFileSync(path, JSON.stringify(stored), 'utf8')
      setSessionsDataDirForTests(null)
      setSessionsDataDirForTests(dataDir)
      assert.equal(getSession(session.id)?.goal?.tokenLimit, expected)
      assert.equal(appendMessage(session.id, { id: `migrate-${tokenLimit}`, role: 'user', content: 'rewrite', createdAt: 3 }), true)
      const rewritten = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(rewritten.schemaVersion, 7)
      assert.equal(rewritten.data.goal.tokenLimit, expected)
      assert.equal(Object.hasOwn(rewritten.data.goal, 'tokenLimit'), expected !== undefined)
    } finally {
      deleteSession(session.id)
    }
  }
})

test('v7 preserves an explicit one-million token limit', () => {
  const session = createSession('explicit one million token limit')
  try {
    createOrReplaceGoal(session.id, { objective: 'Keep this explicit limit', tokenLimit: LEGACY_DEFAULT_GOAL_TOKEN_LIMIT })
    setSessionsDataDirForTests(null)
    setSessionsDataDirForTests(dataDir)
    assert.equal(getSession(session.id)?.goal?.tokenLimit, LEGACY_DEFAULT_GOAL_TOKEN_LIMIT)
  } finally {
    deleteSession(session.id)
  }
})

test('loads v1 and v2 session envelopes without requiring a goal', () => {
  for (const schemaVersion of [1, 2] as const) {
    const id = `schema-${schemaVersion}-${crypto.randomUUID()}`
    const data = { id, title: `Schema ${schemaVersion}`, createdAt: 1, updatedAt: 2, messages: [] }
    writeFileSync(join(dataDir, `${id}.json`), JSON.stringify({ schemaVersion, data }), 'utf8')
    assert.deepEqual(getSession(id), { ...data, pendingUserMessages: [], messageQueueRevision: 0, runActivity: { state: 'idle', terminalRevision: 0, seenTerminalRevision: 0 } })
    assert.equal(listSessions().find((item) => item.id === id)?.goal, undefined)
    deleteSession(id)
  }
})

test('falls back to a valid backup when the primary file is corrupt', () => {
  const session = createSession('backup')
  const path = join(dataDir, `${session.id}.json`)
  const backup = { id: session.id, title: 'Recovered', createdAt: 1, updatedAt: 3, messages: [] }
  writeFileSync(`${path}.bak`, JSON.stringify({ schemaVersion: 1, data: backup }), 'utf8')
  writeFileSync(path, '{not-json', 'utf8')
  assert.deepEqual(getSession(session.id), { ...backup, pendingUserMessages: [], messageQueueRevision: 0, runActivity: { state: 'idle', terminalRevision: 0, seenTerminalRevision: 0 } })
  assert.equal(listSessions().some((item) => item.title === 'Recovered'), true)
  assert.equal(deleteSession(session.id), true)
  assert.equal(existsSync(path), false)
  assert.equal(existsSync(`${path}.bak`), false)
})

test('assistant usage and tool segments survive a session round trip', () => {
  const session = createSession('usage round trip')
  const assistant = {
    id: 'assistant-usage',
    role: 'assistant' as const,
    content: 'done',
    createdAt: 2,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      noCacheTokens: 40,
      cacheReadTokens: 60,
      cacheWriteTokens: 5,
      stepCount: 3
    },
    segments: [{
      type: 'tools' as const,
      tools: [{
        toolCallId: 'call-agent',
        toolName: 'Agent',
        input: { prompt: 'inspect' },
        output: 'result',
        metadata: { usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } },
        status: 'done' as const
      }]
    }]
  }
  try {
    assert.equal(appendMessage(session.id, assistant), true)
    assert.deepEqual(getSession(session.id)?.messages.at(-1), assistant)
  } finally {
    deleteSession(session.id)
  }
})

test('generated image tool metadata survives a session round trip', () => {
  const session = createSession('generated image metadata round trip')
  const generatedImage = {
    id: 'generated-image-1',
    sessionId: session.id,
    filename: 'generated-image-1.jpg',
    mediaType: 'image/jpeg' as const,
    sizeBytes: 1234,
    createdAt: 2
  }
  const toolCall = {
    toolCallId: 'call-generate-image',
    toolName: 'GenerateImage',
    input: { prompt: 'painted clown warrior' },
    output: `Generated image saved as ${generatedImage.filename}`,
    metadata: { generatedImages: [generatedImage] },
    status: 'done' as const
  }
  const assistant = {
    id: 'assistant-generated-image',
    role: 'assistant' as const,
    content: '',
    createdAt: 3,
    toolCalls: [toolCall],
    segments: [{ type: 'tools' as const, tools: [toolCall] }]
  }

  try {
    assert.equal(appendMessage(session.id, assistant), true)
    assert.deepEqual(getSession(session.id)?.messages.at(-1), assistant)
  } finally {
    deleteSession(session.id)
  }
})

test('runMode survives round trips, legacy messages remain valid, and invalid modes are rejected', () => {
  const session = createSession('run mode validation')
  try {
    assert.equal(appendMessage(session.id, { id: 'legacy', role: 'user', content: 'legacy', createdAt: 1 }), true)
    assert.equal(appendMessage(session.id, { id: 'research-user', role: 'user', content: 'research', runMode: 'research', createdAt: 2 }), true)
    assert.equal(appendMessage(session.id, { id: 'research-assistant', role: 'assistant', content: 'report', runMode: 'research', createdAt: 3 }), true)
    assert.deepEqual(getSession(session.id)?.messages.map((message) => message.runMode), [undefined, 'research', 'research'])
    assert.equal(appendMessage(session.id, { id: 'invalid', role: 'user', content: 'bad', runMode: 'invalid' as never, createdAt: 4 }), false)
  } finally {
    deleteSession(session.id)
  }
})

test('setContextCheckpoint rejects stale expected snapshot hashes', () => {
  const session = createSession('checkpoint stale hash')
  try {
    const source = [
      { id: 'checkpoint-u1', role: 'user' as const, content: 'old', createdAt: 1 },
      { id: 'checkpoint-a1', role: 'assistant' as const, content: 'answer', createdAt: 2 }
    ]
    for (const message of source) assert.equal(appendMessage(session.id, message), true)
    const expectedMessagesHash = hashChatMessages(source)
    assert.equal(appendMessage(session.id, { id: 'checkpoint-u2', role: 'user', content: 'new', createdAt: 3 }), true)
    const checkpoint = {
      version: 1 as const,
      policyVersion: DEFAULT_CONTEXT_POLICY_VERSION,
      sourceFromMessageId: source[0].id,
      sourceUntilMessageId: source[1].id,
      sourceHash: hashSessionMessageRange(source, source[0].id, source[1].id) ?? '',
      createdAt: 4,
      summary: {
        goal: '', confirmedFacts: [], decisions: [], filesRead: [], changesMade: [], failedAttempts: [], openTasks: [], criticalIdentifiers: []
      },
      estimatedSourceTokens: 2,
      estimatedSummaryTokens: 1
    }
    assert.equal(setContextCheckpoint(session.id, checkpoint, expectedMessagesHash), false)
    assert.equal(getSession(session.id)?.contextCheckpoint, undefined)
  } finally {
    deleteSession(session.id)
  }
})

test('large sessions restore bounded message data without temp-file leaks', () => {
  const session = createSession('large session')
  const messages = Array.from({ length: 10_000 }, (_, index) => ({
    id: `large-${index}`,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message-${index}-${'x'.repeat(80)}`,
    createdAt: index + 1
  }))
  assert.equal(replaceMessages(session.id, messages), true)
  const loaded = getSession(session.id)
  assert.ok(loaded)
  assert.equal(loaded.messages.length, messages.length)
  assert.equal(loaded.messages.at(-1)?.id, 'large-9999')
  assert.equal(readdirSync(dataDir).some((file) => file.endsWith('.tmp')), false)
  assert.equal(readdirSync(dataDir).some((file) => file.endsWith('.lock')), false)
  deleteSession(session.id)
})
