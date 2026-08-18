import { projectToolCallsFromOperations, projectToolCallsIntoMessages, readOperations, readSpilledToolResult, readToolRecoveries, resolveToolRecovery } from '../store/operations'
import { BrowserWindow, ipcMain, webContents } from 'electron'
import { compactSession } from '../agent/session-compact'
import { getApprovalRegistry, subscribeApprovalActivity } from '../agent/approval'
import { SessionSummaryService, type SessionSummaryScope } from '../session-summary'
import { abortGoalSession, listActiveRuns, subscribeRunActivity } from '../stream'
import {
  createSession,
  getSession,
  listSessions,
  appendMessage,
  listPendingUserMessages,
  replaceMessages,
  deleteSession,
  renameSession,
  createOrReplaceGoal,
  pauseGoal,
  resumeGoal,
  clearGoal,
  getSessionRunActivity,
  markSessionRunActivitySeen,
  setSessionProject
} from '../store/sessions'

let sessionSummaryService: SessionSummaryService | null = null

function scopeForBrowserWindow(browserWindowId: number): SessionSummaryScope | null {
  const window = BrowserWindow.fromId(browserWindowId)
  return window && !window.isDestroyed()
    ? { browserWindowId: window.id, webContentsId: window.webContents.id }
    : null
}

function scopeForWebContents(webContentsId: number): SessionSummaryScope | null {
  const owner = webContents.fromId(webContentsId)
  const window = owner ? BrowserWindow.fromWebContents(owner) : null
  return window && !window.isDestroyed()
    ? { browserWindowId: window.id, webContentsId }
    : null
}

function summaryService(): SessionSummaryService {
  if (sessionSummaryService) return sessionSummaryService
  sessionSummaryService = new SessionSummaryService({
    listSessions,
    getSessionRunActivity,
    markSessionRunActivitySeen,
    listActiveRuns,
    listPendingApprovals: (webContentsId) => getApprovalRegistry().listPending(webContentsId),
    subscribeRunActivity,
    subscribeApprovalActivity,
    scopeForBrowserWindow,
    scopeForWebContents,
    sendChanged: (webContentsId, event) => {
      const owner = webContents.fromId(webContentsId)
      if (owner && !owner.isDestroyed()) owner.send('session:summary-changed', event)
    }
  })
  return sessionSummaryService
}

export function registerSessionIpc(): void {
  summaryService()

  ipcMain.handle('session:create', (event, title?: string) => {
    const session = createSession(title)
    const scope = scopeForWebContents(event.sender.id)
    if (scope) summaryService().pushSummary(scope, session.id)
    return session
  })

  ipcMain.handle('session:get', (event, id: string) => {
    const session = getSession(id)
    if (!session) return null
    const scope = scopeForWebContents(event.sender.id)
    const activeRunIds = new Set((scope ? listActiveRuns(scope.browserWindowId) : []).filter((run) => run.sessionId === id).map((run) => run.runId))
    const pendingApprovalToolCallIds = new Set(getApprovalRegistry().listPending(event.sender.id)
      .filter((request) => request.sessionId === id && request.toolCallId)
      .map((request) => request.toolCallId!))
    const projections = projectToolCallsFromOperations(readOperations(id), {
      activeRunIds,
      pendingApprovalToolCallIds,
      assumeApprovalPending: false
    }).filter((projection) => !activeRunIds.has(projection.runId))
    return { ...session, messages: projectToolCallsIntoMessages(session.messages, projections) }
  })

  ipcMain.handle('session:list', () => {
    return listSessions()
  })

  ipcMain.handle('session:list-summaries', (event) => {
    const scope = scopeForWebContents(event.sender.id)
    return scope ? summaryService().listSummaries(scope) : []
  })

  ipcMain.handle('session:mark-seen', (event, sessionId: unknown, observedTerminalRevision: unknown) => {
    const scope = scopeForWebContents(event.sender.id)
    return scope ? summaryService().markSeen(scope, sessionId, observedTerminalRevision) : null
  })

  ipcMain.handle('session:append', (_event, sessionId: string, message: unknown) => {
    return appendMessage(sessionId, message as Parameters<typeof appendMessage>[1])
  })

  ipcMain.handle('session:replace-messages', (_event, sessionId: string, messages: unknown) => {
    return replaceMessages(sessionId, messages as Parameters<typeof replaceMessages>[1])
  })

  ipcMain.handle('session:pending', (_event, sessionId: unknown) => {
    return typeof sessionId === 'string'
      ? listPendingUserMessages(sessionId)
      : { success: false, pending: [], messageQueueRevision: 0, error: 'invalid-session' }
  })

  ipcMain.handle('session:delete', (event, id: string) => {
    const deleted = deleteSession(id)
    if (deleted) summaryService().pushDeleted(event.sender.id, id)
    return deleted
  })

  ipcMain.handle('session:rename', (event, id: string, title: string) => {
    const renamed = renameSession(id, title)
    const scope = scopeForWebContents(event.sender.id)
    if (renamed && scope) summaryService().pushSummary(scope, id)
    return renamed
  })

  ipcMain.handle('session:goal-inspect', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return { success: false, error: 'invalid-session' }
    const session = getSession(sessionId)
    return session ? { success: true, changed: false, goal: session.goal } : { success: false, error: 'invalid-session' }
  })

  ipcMain.handle('session:goal-create', (_event, sessionId: unknown, input: unknown) => {
    if (typeof sessionId !== 'string') return { success: false, error: 'invalid-session' }
    const session = getSession(sessionId)
    if (!session) return { success: false, error: 'invalid-session' }
    if (session.goal) return { success: false, error: 'invalid-transition' }
    return createOrReplaceGoal(sessionId, input)
  })

  ipcMain.handle('session:goal-replace', (_event, sessionId: unknown, input: unknown) => {
    if (typeof sessionId !== 'string') return { success: false, error: 'invalid-session' }
    const result = createOrReplaceGoal(sessionId, input)
    if (result.success) abortGoalSession(sessionId)
    return result
  })

  ipcMain.handle('session:goal-pause', (_event, sessionId: unknown, input: unknown) => {
    if (typeof sessionId !== 'string') return { success: false, error: 'invalid-session' }
    const result = pauseGoal(sessionId, input)
    if (result.success) abortGoalSession(sessionId)
    return result
  })

  ipcMain.handle('session:goal-resume', (_event, sessionId: unknown, input: unknown) => {
    if (typeof sessionId !== 'string') return { success: false, error: 'invalid-session' }
    return resumeGoal(sessionId, input)
  })

  ipcMain.handle('session:goal-clear', (_event, sessionId: unknown, input: unknown) => {
    if (typeof sessionId !== 'string') return { success: false, error: 'invalid-session' }
    const result = clearGoal(sessionId, input)
    if (result.success && result.changed) abortGoalSession(sessionId)
    return result
  })

  ipcMain.handle('session:compact', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      return { success: false, changed: false, beforeTokens: 0, afterTokens: 0, sourceMessageCount: 0, retainedMessageCount: 0, error: 'invalid-session' }
    }
    return compactSession(sessionId)
  })

  ipcMain.handle('session:read-tool-result', (_event, sessionId: unknown, spillId: unknown, offsetBytes: unknown, limitBytes: unknown) => {
    if (typeof sessionId !== 'string' || typeof spillId !== 'string' || !getSession(sessionId)) return null
    return readSpilledToolResult(sessionId, spillId, typeof offsetBytes === 'number' ? offsetBytes : 0, typeof limitBytes === 'number' ? limitBytes : 64_000)
  })

  ipcMain.handle('session:list-recoveries', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !getSession(sessionId)) return []
    return readToolRecoveries(sessionId)
  })

  ipcMain.handle('session:resolve-recovery', (_event, sessionId: unknown, input: unknown) => {
    if (typeof sessionId !== 'string' || !getSession(sessionId)) return { success: false, changed: false, error: 'invalid-session' }
    if (!input || typeof input !== 'object') return { success: false, changed: false, error: 'invalid-input' }
    const value = input as { recoveryId?: unknown; expectedRevision?: unknown; resolution?: unknown; note?: unknown }
    if (typeof value.recoveryId !== 'string' || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) return { success: false, changed: false, error: 'invalid-input' }
    if (!['verified-not-applied', 'verified-applied', 'user-authorized-retry', 'superseded'].includes(String(value.resolution))) return { success: false, changed: false, error: 'invalid-resolution' }
    return resolveToolRecovery(sessionId, { recoveryId: value.recoveryId, expectedRevision: Number(value.expectedRevision), resolution: value.resolution as Parameters<typeof resolveToolRecovery>[1]['resolution'], ...(typeof value.note === 'string' ? { note: value.note } : {}) })
  })

  ipcMain.handle('session:set-project', (event, sessionId: unknown, projectId: unknown) => {
    if (typeof sessionId !== 'string' || (projectId !== null && typeof projectId !== 'string')) return false
    const changed = setSessionProject(sessionId, projectId as string | null)
    const scope = scopeForWebContents(event.sender.id)
    if (changed && scope) summaryService().pushSummary(scope, sessionId)
    return changed
  })
}
