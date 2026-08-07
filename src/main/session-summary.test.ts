import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApprovalRequest, GoalState, SessionMeta, SessionRunActivityRecord, SessionSummaryChangedEvent } from '@shared/types'
import type { ApprovalActivityEvent } from './agent/approval'
import type { ActiveRunSummary, RunActivityEvent } from './run-registry'
import { mergeSessionActivity, SessionSummaryService, type SessionSummaryDependencies, type SessionSummaryScope } from './session-summary'

const durable = (overrides: Partial<SessionRunActivityRecord> = {}): SessionRunActivityRecord => ({
  state: 'completed',
  terminalRevision: 4,
  seenTerminalRevision: 2,
  runId: 'durable-run',
  kind: 'chat',
  startedAt: 10,
  finishedAt: 20,
  ...overrides
})

const activeRun = (overrides: Partial<ActiveRunSummary> = {}): ActiveRunSummary => ({
  windowId: 11,
  sessionId: 'session-a',
  runId: 'live-run',
  kind: 'goal',
  phase: 'streaming',
  startedAt: 30,
  ...overrides
})

void test('pending approval and live run override durable and Goal terminal status', () => {
  const blockedGoal = { status: 'blocked', stopReason: 'evaluator-blocked' } as GoalState
  const awaiting = mergeSessionActivity(durable({ state: 'failed', error: 'old failure' }), activeRun(), 2, blockedGoal)
  assert.deepEqual(awaiting, {
    status: 'awaiting-user',
    livePhase: 'awaiting-approval',
    terminalRevision: 4,
    seenTerminalRevision: 2,
    unread: true,
    pendingApprovalCount: 2,
    runId: 'live-run',
    kind: 'goal',
    startedAt: 30
  })

  const running = mergeSessionActivity(durable({ state: 'failed' }), activeRun({ phase: 'tool' }), 0, blockedGoal)
  assert.equal(running.status, 'running')
  assert.equal(running.livePhase, 'running-tools')
  assert.equal(running.runId, 'live-run')
})

void test('Goal blocked and interrupted override durable terminal display when no live activity exists', () => {
  const blocked = mergeSessionActivity(durable({ state: 'completed' }), undefined, 0, {
    status: 'blocked',
    feedback: 'Need user input'
  } as GoalState)
  assert.equal(blocked.status, 'awaiting-user')
  assert.equal(blocked.error, 'Need user input')
  assert.equal(blocked.unread, true)

  const interrupted = mergeSessionActivity(durable({ state: 'completed' }), undefined, 0, {
    status: 'interrupted',
    stopReason: 'recovered-after-restart'
  } as GoalState)
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.error, 'recovered-after-restart')
})

void test('markSeen preserves a newer terminal revision and emits the authoritative raced summary', () => {
  const scope: SessionSummaryScope = { browserWindowId: 11, webContentsId: 22 }
  const session: SessionMeta = { id: 'session-a', title: 'A', createdAt: 1, updatedAt: 2 }
  let record = durable({ terminalRevision: 1, seenTerminalRevision: 0 })
  let runListener: ((event: RunActivityEvent) => void) | undefined
  let approvalListener: ((event: ApprovalActivityEvent) => void) | undefined
  const changed: Array<{ webContentsId: number; event: SessionSummaryChangedEvent }> = []
  const dependencies: SessionSummaryDependencies = {
    listSessions: () => [session],
    getSessionRunActivity: () => structuredClone(record),
    markSessionRunActivitySeen: (_sessionId, observedRevision) => {
      record = { ...record, terminalRevision: 2, seenTerminalRevision: Math.min(2, observedRevision) }
      return structuredClone(record)
    },
    listActiveRuns: () => [],
    listPendingApprovals: () => [],
    subscribeRunActivity: (listener) => {
      runListener = listener
      return () => { runListener = undefined }
    },
    subscribeApprovalActivity: (listener) => {
      approvalListener = listener
      return () => { approvalListener = undefined }
    },
    scopeForBrowserWindow: () => scope,
    scopeForWebContents: () => scope,
    sendChanged: (webContentsId, event) => changed.push({ webContentsId, event })
  }
  const service = new SessionSummaryService(dependencies)

  const summary = service.markSeen(scope, session.id, 1)
  assert.equal(summary?.activity.terminalRevision, 2)
  assert.equal(summary?.activity.seenTerminalRevision, 1)
  assert.equal(summary?.activity.unread, true)
  assert.equal(changed.length, 1)
  assert.equal(changed[0]?.webContentsId, 22)
  assert.equal(changed[0]?.event.summary?.activity.unread, true)

  service.dispose()
  assert.equal(runListener, undefined)
  assert.equal(approvalListener, undefined)
})

void test('activity pushes remain scoped to the owning renderer window', () => {
  const session: SessionMeta = { id: 'session-a', title: 'A', createdAt: 1, updatedAt: 2 }
  let runs: ActiveRunSummary[] = []
  let approvals: ApprovalRequest[] = []
  let runListener: ((event: RunActivityEvent) => void) | undefined
  let approvalListener: ((event: ApprovalActivityEvent) => void) | undefined
  const changed: Array<{ webContentsId: number; event: SessionSummaryChangedEvent }> = []
  const scope: SessionSummaryScope = { browserWindowId: 11, webContentsId: 22 }
  const service = new SessionSummaryService({
    listSessions: () => [session],
    getSessionRunActivity: () => durable({ state: 'running', terminalRevision: 0, seenTerminalRevision: 0 }),
    markSessionRunActivitySeen: () => durable(),
    listActiveRuns: (windowId) => runs.filter((run) => run.windowId === windowId),
    listPendingApprovals: (webContentsId) => webContentsId === 22 ? approvals : [],
    subscribeRunActivity: (listener) => {
      runListener = listener
      return () => undefined
    },
    subscribeApprovalActivity: (listener) => {
      approvalListener = listener
      return () => undefined
    },
    scopeForBrowserWindow: (windowId) => windowId === 11 ? scope : null,
    scopeForWebContents: (webContentsId) => webContentsId === 22 ? scope : null,
    sendChanged: (webContentsId, event) => changed.push({ webContentsId, event })
  })

  approvals = [{ requestId: 'goal-approval', windowId: 22, sessionId: session.id, runId: 'goal-invocation', toolName: 'Bash', input: {} }]
  assert.equal(service.listSummaries(scope)[0]?.activity.status, 'awaiting-user')
  assert.equal(service.listSummaries(scope)[0]?.activity.pendingApprovalCount, 1)

  runs = [activeRun({ kind: 'chat' })]
  approvals = [{ requestId: 'stale-approval', windowId: 22, sessionId: session.id, runId: 'old-run', toolName: 'Bash', input: {} }]
  assert.equal(service.listSummaries(scope)[0]?.activity.status, 'running')
  runListener?.({ type: 'start', run: runs[0]! })
  runListener?.({ type: 'phase', run: activeRun({ windowId: 99 }) })
  approvals = [{ requestId: 'approval-a', windowId: 22, sessionId: session.id, runId: 'live-run', toolName: 'Bash', input: {} }]
  approvalListener?.({
    type: 'pending',
    requestId: 'approval-a',
    sessionId: session.id,
    runId: 'live-run',
    webContentsId: 22,
    windowId: 22,
    pendingCount: 1,
    request: approvals[0]!
  })

  assert.equal(changed.length, 2)
  assert.deepEqual(changed.map((item) => item.webContentsId), [22, 22])
  assert.equal(changed[0]?.event.summary?.activity.status, 'running')
  assert.equal(changed[1]?.event.summary?.activity.status, 'awaiting-user')
  service.dispose()
})
