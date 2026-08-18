import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApprovalRequest, GoalState, StreamEvent } from '@shared/types'
import {
  formatElapsedDuration,
  initialRunActivityState,
  runActivityDataStatus,
  runActivityLabel,
  runActivityReducer,
  toRunActivityViewModel,
  type RunActivityAction,
  type RunActivityState
} from './run-activity'

const started = (): RunActivityState => runActivityReducer(initialRunActivityState, {
  type: 'send-accepted',
  runId: 'run-a',
  sessionId: 'session-a',
  runMode: 'research'
})

const streamEvent = <T extends StreamEvent>(event: T): RunActivityAction => event

void test('elapsed duration uses compact clock formatting', () => {
  assert.equal(formatElapsedDuration(0), '00:00')
  assert.equal(formatElapsedDuration(9_999), '00:09')
  assert.equal(formatElapsedDuration(65_000), '01:05')
  assert.equal(formatElapsedDuration(3_661_000), '1:01:01')
  assert.equal(formatElapsedDuration(-1_000), '00:00')
})

void test('send acceptance, message start, step start and tokens advance model activity', () => {
  const starting = started()
  assert.equal(starting.phase, 'starting')
  assert.equal(starting.runMode, 'research')

  const waiting = runActivityReducer(starting, streamEvent({
    type: 'message-start',
    sessionId: 'session-a',
    runId: 'run-a',
    messageId: 'message-a',
    runMode: 'chat'
  }))
  assert.equal(waiting.phase, 'waiting-model')
  assert.equal(waiting.runMode, 'chat')

  const nextStep = runActivityReducer(waiting, {
    type: 'step-start',
    sessionId: 'session-a',
    runId: 'run-a'
  })
  assert.equal(nextStep.phase, 'waiting-model')

  const streaming = runActivityReducer(nextStep, streamEvent({
    type: 'token',
    sessionId: 'session-a',
    runId: 'run-a',
    text: 'Hello'
  }))
  assert.equal(streaming.phase, 'streaming-text')
})

void test('tool completion keeps running-tools while another tool is active', () => {
  const firstProposed = runActivityReducer(started(), streamEvent({
    type: 'tool-call',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-a',
    toolName: 'Read',
    input: { path: 'a.txt' },
    proposedAt: 10,
    updatedAt: 10
  }))
  const first = runActivityReducer(firstProposed, streamEvent({
    type: 'tool-status',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-a',
    toolName: 'Read',
    status: 'running',
    startedAt: 20,
    updatedAt: 20
  }))
  const secondProposed = runActivityReducer(first, streamEvent({
    type: 'tool-call',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-b',
    toolName: 'Search',
    input: { query: 'status' },
    proposedAt: 30,
    updatedAt: 30
  }))
  const second = runActivityReducer(secondProposed, streamEvent({
    type: 'tool-status',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-b',
    toolName: 'Search',
    status: 'running',
    startedAt: 40,
    updatedAt: 40
  }))
  const oneDone = runActivityReducer(second, streamEvent({
    type: 'tool-result',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-a',
    toolName: 'Read',
    output: 'contents'
  }))
  assert.equal(oneDone.phase, 'running-tools')
  assert.deepEqual(oneDone.toolCalls.map((tool) => tool.status), ['done', 'running'])

  const allSettled = runActivityReducer(oneDone, streamEvent({
    type: 'tool-error',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-b',
    toolName: 'Search',
    error: 'not found'
  }))
  assert.equal(allSettled.phase, 'waiting-model')
  assert.equal(allSettled.toolCalls[1]?.status, 'error')
})

void test('approval, message end and goal updates retain useful run context', () => {
  const goal = { id: 'goal-a', status: 'executing' } as GoalState
  const withGoal = runActivityReducer(started(), streamEvent({
    type: 'goal-update',
    sessionId: 'session-a',
    runId: 'run-a',
    goal
  }))
  assert.equal(withGoal.goal, goal)

  const approval: ApprovalRequest = {
    requestId: 'approval-a',
    windowId: 1,
    runId: 'run-a',
    sessionId: 'session-a',
    toolCallId: 'tool-approval',
    toolName: 'Bash',
    input: { command: 'npm test' }
  }
  const proposed = runActivityReducer(withGoal, streamEvent({
    type: 'tool-call',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-approval',
    toolName: 'Bash',
    input: approval.input,
    proposedAt: 10,
    updatedAt: 10
  }))
  const awaiting = runActivityReducer(proposed, { type: 'approval', request: approval })
  assert.equal(awaiting.phase, 'awaiting-approval')
  assert.equal(awaiting.approval, approval)
  assert.equal(awaiting.toolCalls[0]?.status, 'awaiting-approval')
  assert.equal(awaiting.toolCalls[0]?.startedAt, undefined)

  const stillAwaiting = runActivityReducer(awaiting, streamEvent({
    type: 'tool-status',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-approval',
    toolName: 'Bash',
    status: 'proposed',
    approvalDecidedAt: 20,
    approvalOutcome: 'allow',
    updatedAt: 20
  }))
  assert.equal(stillAwaiting.toolCalls[0]?.status, 'awaiting-approval')

  const resolved = runActivityReducer(stillAwaiting, {
    type: 'approval-resolved',
    event: {
      requestId: approval.requestId,
      sessionId: approval.sessionId,
      runId: approval.runId,
      toolCallId: approval.toolCallId,
      approved: true,
      reason: 'resolved',
      resolvedAt: 20
    }
  })
  assert.equal(resolved.phase, 'waiting-model')
  assert.equal(resolved.approval, null)
  assert.equal(resolved.toolCalls[0]?.status, 'proposed')

  const finalizing = runActivityReducer(awaiting, streamEvent({
    type: 'message-end',
    sessionId: 'session-a',
    runId: 'run-a',
    messageId: 'message-a'
  }))
  assert.equal(finalizing.phase, 'finalizing')
  assert.equal(finalizing.approval, null)
})

void test('abort request and terminal events clean up after authoritative done', () => {
  const cancelling = runActivityReducer(started(), { type: 'abort-request' })
  assert.equal(cancelling.phase, 'cancelling')

  const cancelled = runActivityReducer(cancelling, streamEvent({
    type: 'abort',
    sessionId: 'session-a',
    runId: 'run-a'
  }))
  assert.equal(cancelled.phase, 'cancelled')
  assert.equal(runActivityReducer(cancelled, streamEvent({ type: 'done', sessionId: 'session-a', runId: 'run-a' })).phase, 'idle')

  const failed = runActivityReducer(started(), streamEvent({
    type: 'error',
    sessionId: 'session-a',
    runId: 'run-a',
    error: 'provider failed'
  }))
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.error, 'provider failed')
  assert.equal(runActivityReducer(failed, streamEvent({ type: 'done', sessionId: 'session-a', runId: 'run-a' })).phase, 'idle')

  const completed = runActivityReducer(
    runActivityReducer(started(), streamEvent({ type: 'message-end', sessionId: 'session-a', runId: 'run-a', messageId: 'message-a' })),
    streamEvent({ type: 'done', sessionId: 'session-a', runId: 'run-a' })
  )
  assert.deepEqual(completed, initialRunActivityState)
})

void test('tool status telemetry retains timing and timeout outcome', () => {
  const proposed = runActivityReducer(started(), streamEvent({
    type: 'tool-call',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-timed',
    toolName: 'Bash',
    input: { command: 'npm test' },
    proposedAt: 90,
    updatedAt: 90
  }))
  const heartbeat = runActivityReducer(proposed, streamEvent({
    type: 'tool-status',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-timed',
    toolName: 'Bash',
    status: 'running',
    startedAt: 100,
    updatedAt: 500,
    lastProgressAt: 100,
    deadlineAt: 1_100,
    heartbeat: true
  }))
  assert.equal(heartbeat.toolCalls[0]?.updatedAt, 500)
  assert.equal(heartbeat.toolCalls[0]?.lastProgressAt, 100)

  const timedOut = runActivityReducer(heartbeat, streamEvent({
    type: 'tool-error',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-timed',
    toolName: 'Bash',
    error: 'Tool execution timed out',
    status: 'timed-out',
    startedAt: 100,
    updatedAt: 1_100,
    lastProgressAt: 100,
    deadlineAt: 1_100,
    durationMs: 1_000
  }))
  assert.equal(timedOut.phase, 'waiting-model')
  assert.equal(timedOut.toolCalls[0]?.status, 'timed-out')
  assert.equal(timedOut.toolCalls[0]?.durationMs, 1_000)
})

void test('labels, data status and view model expose localized activity details', () => {
  assert.equal(runActivityLabel('running-tools', 'zh'), '正在运行工具')
  assert.equal(runActivityLabel('running-tools', 'en'), 'Running tools')
  assert.equal(runActivityDataStatus('awaiting-approval'), 'waiting')
  assert.equal(runActivityDataStatus('streaming-text'), 'running')
  assert.equal(runActivityDataStatus('failed'), 'failed')

  const proposed = runActivityReducer(started(), streamEvent({
    type: 'tool-call',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-a',
    toolName: 'Read',
    input: {},
    proposedAt: 10,
    updatedAt: 10
  }))
  assert.equal(proposed.phase, 'waiting-model')
  const state = runActivityReducer(proposed, streamEvent({
    type: 'tool-status',
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-a',
    toolName: 'Read',
    status: 'running',
    startedAt: 20,
    updatedAt: 20
  }))
  assert.deepEqual(toRunActivityViewModel(state, 'en'), {
    phase: 'running-tools',
    label: 'Running tools',
    dataStatus: 'running',
    runMode: 'research',
    toolCount: 1,
    toolName: 'Read'
  })
  assert.deepEqual(toRunActivityViewModel(initialRunActivityState, 'zh'), {
    phase: 'idle',
    label: '空闲',
    dataStatus: 'idle'
  })
})
