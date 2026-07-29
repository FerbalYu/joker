import type { BrowserWindow } from 'electron'
import type { ApprovalGate } from '../tools/registry'
import type { ApprovalRequest } from '@shared/types'

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

// Read-only tools that never need approval
const ALWAYS_SAFE = new Set(['Read', 'Grep', 'Glob', 'TodoWrite', 'GitStatus', 'GitDiff', 'GitLog', 'GitBranch'])
// Write tools that are auto-approved in 'auto-edit' mode
const WRITE_TOOLS = new Set(['Write', 'Edit'])

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

export function createApprovalGate(win: BrowserWindow, sessionId: string, runId?: string): ApprovalGate {
  const scope: ApprovalScope = { windowId: win.id, sessionId, runId: runId ?? crypto.randomUUID() }
  return async (toolName: string, input: Record<string, unknown>): Promise<boolean> => {
    const mode = registry.getMode(scope.windowId)
    if (mode === 'full-auto') return true
    if (ALWAYS_SAFE.has(toolName)) return true
    if (mode === 'auto-edit' && WRITE_TOOLS.has(toolName)) return true

    const requestId = crypto.randomUUID()
    const request: ApprovalRequest = {
      requestId,
      windowId: scope.windowId,
      runId: scope.runId,
      sessionId: scope.sessionId,
      toolName,
      input: sanitizeInput(toolName, input)
    }
    win.webContents.send('approval:request', request)

    return new Promise<boolean>((resolve) => {
      registry.add(scope, requestId, resolve)
    })
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
