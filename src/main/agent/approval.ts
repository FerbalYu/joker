import type { BrowserWindow } from 'electron'
import type { ApprovalDecision, ApprovalGate, ToolDefinition } from '../tools/registry'
import { classifyToolRisk, type ToolRisk } from '../tools/risk'
import type { ApprovalRequest, RunMode } from '@shared/types'

export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto'

export interface ApprovalScope {
  windowId: number
  sessionId: string
  runId: string
}

interface PendingApproval extends ApprovalScope {
  requestId: string
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/** Pure, window/run/session-scoped approval state. */
export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly modes = new Map<number, ApprovalMode>()

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

  add(scope: ApprovalScope, requestId: string, resolve: (approved: boolean) => void): void {
    const timer = setTimeout(() => {
      const pending = this.pending.get(requestId)
      if (!pending) return
      this.pending.delete(requestId)
      pending.resolve(false)
    }, 300000)
    this.pending.set(requestId, { ...scope, requestId, resolve, timer })
  }

  resolve(requestId: string, scope: ApprovalScope, approved: boolean): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || pending.windowId !== scope.windowId || pending.sessionId !== scope.sessionId || pending.runId !== scope.runId) {
      return false
    }
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(approved)
    return true
  }

  get size(): number {
    return this.pending.size
  }

  private cancelWhere(predicate: (item: PendingApproval) => boolean): void {
    for (const [requestId, pending] of this.pending) {
      if (!predicate(pending)) continue
      this.pending.delete(requestId)
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
  }
}

const registry = new ApprovalRegistry()
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

  if (risk === 'read') return { action: 'allow', risk, reason: 'read-only tool' }
  if (mode === 'full-auto') return { action: 'allow', risk, reason: 'full-auto mode' }
  if (mode === 'auto-edit' && risk === 'write_local') return { action: 'allow', risk, reason: 'auto-edit mode' }
  return { action: 'ask', risk, reason: `${risk} tool requires approval` }
}

export function setApprovalMode(mode: ApprovalMode, windowId?: number): void {
  // The optional legacy form keeps callers source-compatible; IPC always supplies a window id.
  registry.setMode(windowId ?? 0, mode)
}

export function getApprovalMode(windowId?: number): ApprovalMode {
  return registry.getMode(windowId ?? 0)
}

export async function registerApprovalIpc(): Promise<void> {
  if (approvalIpcRegistered) return
  const { ipcMain } = await import('electron')
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
  ipcMain.handle('approval:set-mode', (event, mode: unknown) => {
    if (!isApprovalMode(mode)) return false
    registry.setMode(event.sender.id, mode)
    return true
  })
  if (process.env['JOKER_E2E_MULTIWINDOW'] === '1') {
    ipcMain.handle('approval:pending-count', () => registry.size)
  }
}

export function createApprovalGate(win: BrowserWindow, sessionId: string, runId?: string, runMode: RunMode = 'chat'): ApprovalGate {
  const scope: ApprovalScope = { windowId: win.id, sessionId, runId: runId ?? crypto.randomUUID() }
  let researchWebApproved = false
  return async (
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
    win.webContents.send('approval:request', request)

    const approved = await new Promise<boolean>((resolve) => {
      registry.add(scope, requestId, resolve)
    })
    if (approved && researchWebRequest) researchWebApproved = true
    return {
      outcome: approved ? 'allow' : 'deny',
      risk: decision.risk,
      reason: approved ? 'approved by user' : 'denied by user',
      approvedByUser: approved
    }
  }
}

export function resolveApproval(requestId: string, approved: boolean, scope?: ApprovalScope): boolean {
  // Direct callers should pass scope. The optional legacy form intentionally cannot resolve a request.
  return scope ? registry.resolve(requestId, scope, approved) : false
}

export function cancelApprovalsForWindow(windowId: number): void {
  registry.cancelWindow(windowId)
}

export function cancelApprovalsForSession(windowId: number, sessionId: string): void {
  registry.cancelSession(windowId, sessionId)
}

export function cancelApprovalsForRun(scope: ApprovalScope): void {
  registry.cancelRun(scope)
}

export function cleanupApprovalWindow(windowId: number): void {
  registry.deleteWindow(windowId)
}

export function getApprovalRegistry(): ApprovalRegistry {
  return registry
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
