import type {
  ApprovalRequest,
  GoalState,
  SessionActivitySummary,
  SessionMeta,
  SessionRunActivityRecord,
  SessionSummary,
  SessionSummaryChangedEvent
} from '@shared/types'
import type { ActiveRunSummary, RunActivityEvent } from './run-registry'
import type { ApprovalActivityEvent } from './agent/approval'

export interface SessionSummaryScope {
  browserWindowId: number
  webContentsId: number
}

export interface SessionSummaryDependencies {
  listSessions: () => SessionMeta[]
  getSessionRunActivity: (sessionId: string) => SessionRunActivityRecord | null
  markSessionRunActivitySeen: (sessionId: string, observedTerminalRevision: number) => SessionRunActivityRecord | null
  listActiveRuns: (browserWindowId: number) => ActiveRunSummary[]
  listPendingApprovals: (webContentsId: number) => ApprovalRequest[]
  subscribeRunActivity: (listener: (event: RunActivityEvent) => void) => () => void
  subscribeApprovalActivity: (listener: (event: ApprovalActivityEvent) => void) => () => void
  scopeForBrowserWindow: (browserWindowId: number) => SessionSummaryScope | null
  scopeForWebContents: (webContentsId: number) => SessionSummaryScope | null
  sendChanged: (webContentsId: number, event: SessionSummaryChangedEvent) => void
}

export class SessionSummaryService {
  private readonly unsubscribeRunActivity: () => void
  private readonly unsubscribeApprovalActivity: () => void

  constructor(private readonly dependencies: SessionSummaryDependencies) {
    this.unsubscribeRunActivity = dependencies.subscribeRunActivity((event) => {
      const scope = dependencies.scopeForBrowserWindow(event.run.windowId)
      if (scope) this.sendCurrentSummary(scope, event.run.sessionId)
    })
    this.unsubscribeApprovalActivity = dependencies.subscribeApprovalActivity((event) => {
      const scope = dependencies.scopeForWebContents(event.webContentsId)
      if (scope) this.sendCurrentSummary(scope, event.sessionId)
    })
  }

  listSummaries(scope: SessionSummaryScope): SessionSummary[] {
    const activeRuns = new Map(this.dependencies.listActiveRuns(scope.browserWindowId).map((run) => [run.sessionId, run]))
    const pendingApprovals = groupPendingApprovals(this.dependencies.listPendingApprovals(scope.webContentsId))
    return this.dependencies.listSessions().map((session) => {
      const activeRun = activeRuns.get(session.id)
      return this.buildSummary(
        session,
        activeRun,
        relevantApprovalCount(pendingApprovals.get(session.id) ?? [], activeRun)
      )
    })
  }

  markSeen(scope: SessionSummaryScope, sessionId: unknown, observedTerminalRevision: unknown): SessionSummary | null {
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(observedTerminalRevision) || (observedTerminalRevision as number) < 0) return null
    const before = this.dependencies.getSessionRunActivity(sessionId)
    if (!before) return null
    const after = this.dependencies.markSessionRunActivitySeen(sessionId, observedTerminalRevision as number)
    if (!after) return null
    const summary = this.findSummary(scope, sessionId)
    if (summary && after.seenTerminalRevision !== before.seenTerminalRevision) {
      this.dependencies.sendChanged(scope.webContentsId, { type: 'upsert', sessionId, summary })
    }
    return summary
  }

  pushSummary(scope: SessionSummaryScope, sessionId: string): void {
    this.sendCurrentSummary(scope, sessionId)
  }

  pushDeleted(webContentsId: number, sessionId: string): void {
    this.dependencies.sendChanged(webContentsId, { type: 'delete', sessionId })
  }

  dispose(): void {
    this.unsubscribeRunActivity()
    this.unsubscribeApprovalActivity()
  }

  private sendCurrentSummary(scope: SessionSummaryScope, sessionId: string): void {
    const summary = this.findSummary(scope, sessionId)
    this.dependencies.sendChanged(scope.webContentsId, summary
      ? { type: 'upsert', sessionId, summary }
      : { type: 'delete', sessionId })
  }

  private findSummary(scope: SessionSummaryScope, sessionId: string): SessionSummary | null {
    const session = this.dependencies.listSessions().find((candidate) => candidate.id === sessionId)
    if (!session) return null
    const activeRun = this.dependencies.listActiveRuns(scope.browserWindowId).find((run) => run.sessionId === sessionId)
    const pendingApprovalCount = relevantApprovalCount(
      this.dependencies.listPendingApprovals(scope.webContentsId).filter((approval) => approval.sessionId === sessionId),
      activeRun
    )
    return this.buildSummary(session, activeRun, pendingApprovalCount)
  }

  private buildSummary(session: SessionMeta, activeRun: ActiveRunSummary | undefined, pendingApprovalCount: number): SessionSummary {
    const durable = this.dependencies.getSessionRunActivity(session.id) ?? idleRunActivity()
    return {
      ...session,
      activity: mergeSessionActivity(durable, activeRun, pendingApprovalCount, session.goal)
    }
  }
}

export function mergeSessionActivity(
  durable: SessionRunActivityRecord,
  activeRun: ActiveRunSummary | undefined,
  pendingApprovalCount: number,
  goal?: GoalState
): SessionActivitySummary {
  const revision = {
    terminalRevision: durable.terminalRevision,
    seenTerminalRevision: durable.seenTerminalRevision,
    unread: durable.terminalRevision > durable.seenTerminalRevision,
    pendingApprovalCount
  }
  const pendingMatchesRun = pendingApprovalCount > 0

  if (pendingMatchesRun) {
    return {
      ...revision,
      status: 'awaiting-user',
      livePhase: 'awaiting-approval',
      ...(activeRun ? liveRunFields(activeRun) : durableRunFields(durable))
    }
  }

  if (activeRun) {
    return {
      ...revision,
      status: 'running',
      livePhase: livePhase(activeRun.phase),
      ...liveRunFields(activeRun)
    }
  }

  if (goal?.status === 'blocked') {
    return {
      ...revision,
      status: 'awaiting-user',
      ...durableRunFields(durable),
      error: goal.feedback ?? goal.evaluation ?? goal.stopReason ?? durable.error ?? 'Goal blocked'
    }
  }

  if (goal?.status === 'interrupted') {
    return {
      ...revision,
      status: 'interrupted',
      ...durableRunFields(durable),
      error: goal.feedback ?? goal.stopReason ?? durable.error ?? 'Goal interrupted'
    }
  }

  return {
    ...revision,
    status: durable.state === 'needs-user-action' ? 'awaiting-user' : durable.state,
    ...durableRunFields(durable)
  }
}

function livePhase(phase: ActiveRunSummary['phase']): NonNullable<SessionActivitySummary['livePhase']> {
  switch (phase) {
    case 'starting':
      return 'starting'
    case 'streaming':
      return 'streaming-text'
    case 'tool':
    case 'goal-execution':
      return 'running-tools'
    case 'error':
    case 'aborting':
      return 'finalizing'
    case 'running':
    case 'goal-validation':
      return 'waiting-model'
  }
}

function liveRunFields(run: ActiveRunSummary): Pick<SessionActivitySummary, 'runId' | 'kind' | 'startedAt'> {
  return { runId: run.runId, kind: run.kind, startedAt: run.startedAt }
}

function durableRunFields(durable: SessionRunActivityRecord): Partial<SessionActivitySummary> {
  return {
    ...(durable.runId ? { runId: durable.runId } : {}),
    ...(durable.kind ? { kind: durable.kind } : {}),
    ...(durable.startedAt !== undefined ? { startedAt: durable.startedAt } : {}),
    ...(durable.finishedAt !== undefined ? { finishedAt: durable.finishedAt } : {}),
    ...(durable.error ? { error: durable.error } : {})
  }
}

function groupPendingApprovals(approvals: ApprovalRequest[]): Map<string, ApprovalRequest[]> {
  const grouped = new Map<string, ApprovalRequest[]>()
  for (const approval of approvals) {
    const sessionApprovals = grouped.get(approval.sessionId) ?? []
    sessionApprovals.push(approval)
    grouped.set(approval.sessionId, sessionApprovals)
  }
  return grouped
}

function relevantApprovalCount(approvals: ApprovalRequest[], activeRun: ActiveRunSummary | undefined): number {
  if (!activeRun) return approvals.length
  if (activeRun.kind === 'goal') return approvals.length
  return approvals.filter((approval) => approval.runId === activeRun.runId).length
}

function idleRunActivity(): SessionRunActivityRecord {
  return { state: 'idle', terminalRevision: 0, seenTerminalRevision: 0 }
}
