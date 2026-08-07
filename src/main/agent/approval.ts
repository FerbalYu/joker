import { createHash } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { ApprovalDecision, ApprovalGate, ToolDefinition } from '../tools/registry'
import { classifyToolRisk, type ToolRisk } from '../tools/risk'
import type { ApprovalRequest, RunMode } from '@shared/types'

export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto'
export type ApprovalResolutionReason = 'resolved' | 'cancelled' | 'timeout'

export interface ApprovalResolvedEvent {
  requestId: string
  sessionId: string
  runId: string
}

export interface ApprovalActivityEvent {
  type: 'pending' | ApprovalResolutionReason
  requestId: string
  sessionId: string
  runId: string
  reason?: ApprovalResolutionReason
  /** Explicit alias for windowId, which is an Electron WebContents.id. */
  webContentsId: number
  windowId: number
  pendingCount: number
  request: ApprovalRequest
}

export type ApprovalActivityListener = (event: ApprovalActivityEvent) => void

export interface ApprovalScope {
  /** Electron WebContents.id; kept as windowId for API compatibility. */
  windowId: number
  sessionId: string
  runId: string
}

export interface ExplicitApprovalGrant extends ApprovalScope {
  requestId: string
  toolName: string
  requestHash: string
  approvedAt: number
}

export interface ExplicitApprovalRequestOptions {
  toolName: string
  input: Record<string, unknown>
  scope: ApprovalScope
  sendRequest: (request: ApprovalRequest) => void
  notifyResolved?: (event: ApprovalResolvedEvent) => void
}

interface PendingApproval extends ApprovalScope {
  requestId: string
  request: ApprovalRequest
  resolve: (approved: boolean) => void
  notifyResolved?: (event: ApprovalResolvedEvent) => void
  timer: ReturnType<typeof setTimeout>
}

/** Pure, window/run/session-scoped approval state. */
export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly modes = new Map<number, ApprovalMode>()
  private readonly activityListeners = new Set<ApprovalActivityListener>()

  constructor(private readonly timeoutMs = 300000) {}

  setMode(windowId: number, mode: ApprovalMode): void {
    this.modes.set(windowId, mode)
  }

  getMode(windowId: number): ApprovalMode {
    return this.modes.get(windowId) ?? 'suggest'
  }

  deleteWindow(windowId: number): void {
    this.cancelWhere((item) => item.windowId === windowId)
    this.modes.delete(windowId)
  }

  cancelWindow(windowId: number): void {
    this.cancelWhere((item) => item.windowId === windowId)
  }

  cancelSession(windowId: number, sessionId: string): void {
    this.cancelWhere((item) => item.windowId === windowId && item.sessionId === sessionId)
  }

  cancelRun(scope: ApprovalScope): void {
    this.cancelWhere((item) => item.windowId === scope.windowId && item.sessionId === scope.sessionId && item.runId === scope.runId)
  }

  add(request: ApprovalRequest, resolve: (approved: boolean) => void, notifyResolved?: (event: ApprovalResolvedEvent) => void): void {
    const scope: ApprovalScope = {
      windowId: request.windowId,
      sessionId: request.sessionId,
      runId: request.runId
    }
    const timer = setTimeout(() => {
      const pending = this.pending.get(request.requestId)
      if (!pending) return
      this.finish(pending, false, 'timeout')
    }, this.timeoutMs)
    const pending = { ...scope, requestId: request.requestId, request, resolve, notifyResolved, timer }
    this.pending.set(request.requestId, pending)
    this.emitActivity(pending, 'pending')
  }

  cancel(requestId: string, scope: ApprovalScope): boolean {
    const pending = this.getPending(requestId, scope)
    if (!pending) return false
    this.finish(pending, false, 'cancelled')
    return true
  }

  resolve(requestId: string, scope: ApprovalScope, approved: boolean): boolean {
    const pending = this.getPending(requestId, scope)
    if (!pending) return false
    this.finish(pending, approved, 'resolved')
    return true
  }

  listPending(windowId: number): ApprovalRequest[] {
    return [...this.pending.values()]
      .filter((pending) => pending.windowId === windowId)
      .map((pending) => pending.request)
  }

  subscribeActivity(listener: ApprovalActivityListener): () => void {
    this.activityListeners.add(listener)
    return () => this.activityListeners.delete(listener)
  }

  get size(): number {
    return this.pending.size
  }

  private getPending(requestId: string, scope: ApprovalScope): PendingApproval | undefined {
    const pending = this.pending.get(requestId)
    if (!pending || pending.windowId !== scope.windowId || pending.sessionId !== scope.sessionId || pending.runId !== scope.runId) {
      return undefined
    }
    return pending
  }

  private finish(pending: PendingApproval, approved: boolean, reason: ApprovalResolutionReason): void {
    this.pending.delete(pending.requestId)
    clearTimeout(pending.timer)
    pending.resolve(approved)
    const resolvedEvent: ApprovalResolvedEvent = {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      runId: pending.runId
    }
    try {
      pending.notifyResolved?.(resolvedEvent)
    } catch {
      // Resolution must complete even if the owning renderer disappears mid-notification.
    }
    this.emitActivity(pending, reason)
  }

  private emitActivity(pending: PendingApproval, type: ApprovalActivityEvent['type']): void {
    const event: ApprovalActivityEvent = {
      type,
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      runId: pending.runId,
      ...(type === 'pending' ? {} : { reason: type }),
      webContentsId: pending.windowId,
      windowId: pending.windowId,
      pendingCount: this.countPendingScope(pending),
      request: pending.request
    }
    for (const listener of this.activityListeners) {
      try {
        listener(event)
      } catch {
        // Observers must not affect approval resolution.
      }
    }
  }

  private countPendingScope(scope: ApprovalScope): number {
    let count = 0
    for (const pending of this.pending.values()) {
      if (pending.windowId === scope.windowId && pending.sessionId === scope.sessionId && pending.runId === scope.runId) count += 1
    }
    return count
  }

  private cancelWhere(predicate: (item: PendingApproval) => boolean): void {
    for (const pending of [...this.pending.values()]) {
      if (!predicate(pending)) continue
      this.finish(pending, false, 'cancelled')
    }
  }
}

const registry = new ApprovalRegistry()
const webContentsIdsByBrowserWindowId = new Map<number, number>()
let approvalIpcRegistered = false

export interface PermissionDecision {
  action: 'allow' | 'deny' | 'ask'
  risk: ToolRisk
  reason: string
}

const RESEARCH_SAFE_TOOLS = new Set(['TodoWrite', 'PresentResearchReport'])
const RESEARCH_WEB_TOOLS = new Set(['WebSearch', 'WebRead'])

export function evaluateToolPermission(
  mode: ApprovalMode,
  runMode: RunMode,
  toolName: string,
  tool?: Pick<ToolDefinition, 'risk' | 'source'>,
  researchWebApproved = false
): PermissionDecision {
  const risk = classifyToolRisk(toolName, tool?.risk, tool?.source)
  if (runMode === 'research') {
    if (RESEARCH_SAFE_TOOLS.has(toolName)) return { action: 'allow', risk, reason: 'research-safe tool' }
    if (!RESEARCH_WEB_TOOLS.has(toolName)) return { action: 'deny', risk, reason: 'tool is unavailable in research mode' }
    if (researchWebApproved) return { action: 'allow', risk, reason: 'research web access approved for this run' }
    if (mode === 'full-auto') return { action: 'allow', risk, reason: 'full-auto mode' }
    return { action: 'ask', risk, reason: 'research web access requires approval' }
  }

  if (tool?.source?.type === 'generated') {
    if (tool.source.runtimeQualificationLevel === 'L1') {
      return { action: 'ask', risk, reason: 'L1 Generated Tool execution requires approval' }
    }
  }

  if (toolName === 'ToolPromote') {
    return { action: 'allow', risk, reason: 'promotion service owns explicit approval' }
  }

  if (risk === 'read') return { action: 'allow', risk, reason: 'read-only tool' }
  if (mode === 'full-auto') return { action: 'allow', risk, reason: 'full-auto mode' }
  if (mode === 'auto-edit' && risk === 'write_local') return { action: 'allow', risk, reason: 'auto-edit mode' }
  return { action: 'ask', risk, reason: `${risk} tool requires approval` }
}

export function setApprovalMode(mode: ApprovalMode, windowId?: number): void {
  // The optional legacy form keeps callers source-compatible; ids are WebContents ids.
  registry.setMode(resolveWebContentsId(windowId ?? 0), mode)
}

export function getApprovalMode(windowId?: number): ApprovalMode {
  return registry.getMode(resolveWebContentsId(windowId ?? 0))
}

export async function registerApprovalIpc(): Promise<void> {
  if (approvalIpcRegistered) return
  const { ipcMain, BrowserWindow: ElectronBrowserWindow } = await import('electron')
  if (approvalIpcRegistered) return
  approvalIpcRegistered = true
  ipcMain.handle('approval:response', (event, data: unknown) => {
    if (!isApprovalResponse(data)) return false
    const request = data
    return registry.resolve(request.requestId, {
      windowId: event.sender.id,
      sessionId: request.sessionId,
      runId: request.runId
    }, request.approved)
  })
  ipcMain.handle('approval:list-pending', (event) => registry.listPending(event.sender.id))
  ipcMain.handle('approval:set-mode', (event, mode: unknown) => {
    if (!isApprovalMode(mode)) return false
    const browserWindow = ElectronBrowserWindow.fromWebContents(event.sender)
    if (browserWindow) webContentsIdsByBrowserWindowId.set(browserWindow.id, event.sender.id)
    registry.setMode(event.sender.id, mode)
    return true
  })
  if (process.env['JOKER_E2E_MULTIWINDOW'] === '1') {
    ipcMain.handle('approval:pending-count', () => registry.size)
  }
}

export function createApprovalGate(win: BrowserWindow, sessionId: string, runId?: string, runMode: RunMode = 'chat'): ApprovalGate {
  const webContentsId = win.webContents.id
  webContentsIdsByBrowserWindowId.set(win.id, webContentsId)
  const scope: ApprovalScope = { windowId: webContentsId, sessionId, runId: runId ?? crypto.randomUUID() }
  let researchWebApproved = false
  const gate: ApprovalGate = async (
    toolName: string,
    input: Record<string, unknown>,
    tool?: Pick<ToolDefinition, 'risk' | 'source'>
  ): Promise<ApprovalDecision> => {
    const decision = evaluateToolPermission(registry.getMode(scope.windowId), runMode, toolName, tool, researchWebApproved)
    if (decision.action !== 'ask') {
      return { outcome: decision.action, risk: decision.risk, reason: decision.reason }
    }

    const requestId = crypto.randomUUID()
    const researchWebRequest = runMode === 'research' && RESEARCH_WEB_TOOLS.has(toolName)
    const request: ApprovalRequest = {
      requestId,
      windowId: scope.windowId,
      runId: scope.runId,
      sessionId: scope.sessionId,
      toolName: researchWebRequest ? 'ResearchWebAccess' : toolName,
      input: researchWebRequest
        ? { tools: ['WebSearch', 'WebRead'], firstCall: { toolName, input: sanitizeInput(toolName, input) } }
        : sanitizeInput(toolName, input)
    }
    const approved = await new Promise<boolean>((resolve) => {
      registry.add(request, resolve, (event) => {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send('approval:resolved', event)
        }
      })
      try {
        if (win.isDestroyed() || win.webContents.isDestroyed()) {
          registry.cancel(requestId, scope)
          return
        }
        win.webContents.send('approval:request', request)
      } catch {
        registry.cancel(requestId, scope)
      }
    })
    if (approved && researchWebRequest) researchWebApproved = true
    return {
      outcome: approved ? 'allow' : 'deny',
      risk: decision.risk,
      reason: approved ? 'approved by user' : 'denied by user',
      approvedByUser: approved
    }
  }
  gate.requestExplicitApproval = ({ toolName, input, sessionId: requestedSessionId, runId: requestedRunId }) => {
    if (requestedSessionId !== scope.sessionId || requestedRunId !== scope.runId) return Promise.resolve(null)
    return requestExplicitApproval({
      toolName,
      input,
      scope,
      sendRequest: (request) => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Approval owner is unavailable')
        win.webContents.send('approval:request', request)
      },
      notifyResolved: (event) => {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('approval:resolved', event)
      }
    }).then((grant) => grant ? { ...grant, webContentsId: grant.windowId } : null)
  }
  return gate
}

export function requestExplicitApproval(options: ExplicitApprovalRequestOptions): Promise<ExplicitApprovalGrant | null> {
  const request: ApprovalRequest = {
    requestId: crypto.randomUUID(),
    windowId: options.scope.windowId,
    sessionId: options.scope.sessionId,
    runId: options.scope.runId,
    toolName: options.toolName,
    input: sanitizeInput(options.toolName, options.input)
  }
  const requestHash = hashApprovalRequest(request)
  return new Promise((resolve) => {
    registry.add(request, (approved) => {
      resolve(approved ? {
        requestId: request.requestId,
        windowId: request.windowId,
        sessionId: request.sessionId,
        runId: request.runId,
        toolName: request.toolName,
        requestHash,
        approvedAt: Date.now()
      } : null)
    }, options.notifyResolved)
    try {
      options.sendRequest(request)
    } catch {
      registry.cancel(request.requestId, options.scope)
    }
  })
}

function hashApprovalRequest(request: ApprovalRequest): string {
  return createHash('sha256').update(JSON.stringify({
    requestId: request.requestId,
    windowId: request.windowId,
    sessionId: request.sessionId,
    runId: request.runId,
    toolName: request.toolName,
    input: request.input
  })).digest('hex')
}

export function resolveApproval(requestId: string, approved: boolean, scope?: ApprovalScope): boolean {
  // Direct callers should pass scope. The optional legacy form intentionally cannot resolve a request.
  return scope ? registry.resolve(requestId, scope, approved) : false
}

export function cancelApprovalsForWindow(windowId: number): void {
  registry.cancelWindow(resolveWebContentsId(windowId))
}

export function cancelApprovalsForSession(windowId: number, sessionId: string): void {
  registry.cancelSession(resolveWebContentsId(windowId), sessionId)
}

export function cancelApprovalsForRun(scope: ApprovalScope): void {
  registry.cancelRun({ ...scope, windowId: resolveWebContentsId(scope.windowId) })
}

export function cleanupApprovalWindow(windowId: number): void {
  const webContentsId = resolveWebContentsId(windowId)
  registry.deleteWindow(webContentsId)
  webContentsIdsByBrowserWindowId.delete(windowId)
  for (const [browserWindowId, mappedWebContentsId] of webContentsIdsByBrowserWindowId) {
    if (mappedWebContentsId === webContentsId) webContentsIdsByBrowserWindowId.delete(browserWindowId)
  }
}

export function getApprovalRegistry(): ApprovalRegistry {
  return registry
}

export function subscribeApprovalActivity(listener: ApprovalActivityListener): () => void {
  return registry.subscribeActivity(listener)
}

function resolveWebContentsId(windowId: number): number {
  return webContentsIdsByBrowserWindowId.get(windowId) ?? windowId
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === 'suggest' || value === 'auto-edit' || value === 'full-auto'
}

function isApprovalResponse(value: unknown): value is { requestId: string; approved: boolean; sessionId: string; runId: string } {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return typeof data.requestId === 'string' && typeof data.sessionId === 'string' && typeof data.runId === 'string' && typeof data.approved === 'boolean'
}

// Trim large inputs for display
function sanitizeInput(_toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    result[key] = typeof value === 'string' && value.length > 500 ? value.slice(0, 500) + '... [truncated]' : value
  }
  return result
}
