import type { BrowserWindow } from 'electron'
import type { UserQuestionAnswerPayload, UserQuestionRequest } from '@shared/types'

export type UserQuestionOption = UserQuestionRequest['options'][number]
export type UserQuestionAnswer = UserQuestionAnswerPayload

interface PendingQuestion {
  request: UserQuestionRequest
  resolve: (answer: UserQuestionAnswer) => void
  timer: ReturnType<typeof setTimeout>
}

/** Window/run-scoped pending user questions; answers carry structured payloads. */
class UserQuestionRegistry {
  private readonly pending = new Map<string, PendingQuestion>()

  constructor(private readonly timeoutMs = 86_400_000) {}

  add(request: UserQuestionRequest, resolve: (answer: UserQuestionAnswer) => void): void {
    const timer = setTimeout(() => {
      const pending = this.pending.get(request.requestId)
      if (!pending) return
      this.finish(pending, { requestId: request.requestId, sessionId: request.sessionId, runId: request.runId, selectedIds: [], freeText: null, cancelled: true })
    }, this.timeoutMs)
    this.pending.set(request.requestId, { request, resolve, timer })
  }

  answer(answer: UserQuestionAnswer): boolean {
    const pending = this.pending.get(answer.requestId)
    if (!pending) return false
    if (pending.request.sessionId !== answer.sessionId || pending.request.runId !== answer.runId) return false
    this.finish(pending, answer)
    return true
  }

  cancelRun(sessionId: string, runId: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.request.sessionId !== sessionId || pending.request.runId !== runId) continue
      this.finish(pending, { requestId: pending.request.requestId, sessionId, runId, selectedIds: [], freeText: null, cancelled: true })
    }
  }

  listPending(sessionId?: string): UserQuestionRequest[] {
    return [...this.pending.values()]
      .filter((pending) => sessionId === undefined || pending.request.sessionId === sessionId)
      .map((pending) => pending.request)
  }

  private finish(pending: PendingQuestion, answer: UserQuestionAnswer): void {
    this.pending.delete(pending.request.requestId)
    clearTimeout(pending.timer)
    pending.resolve(answer)
  }
}

export const userQuestionRegistry = new UserQuestionRegistry()

export function isUserQuestionAnswer(value: unknown): value is UserQuestionAnswer {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<UserQuestionAnswer>
  return typeof candidate.requestId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.runId === 'string' &&
    Array.isArray(candidate.selectedIds) &&
    candidate.selectedIds.every((id) => typeof id === 'string') &&
    (candidate.freeText === null || typeof candidate.freeText === 'string')
}

export async function registerUserQuestionIpc(): Promise<void> {
  const { ipcMain } = await import('electron')
  ipcMain.handle('user-question:answer', (_event, value: unknown) => {
    if (!isUserQuestionAnswer(value)) return false
    return userQuestionRegistry.answer(value)
  })
  ipcMain.handle('user-question:list-pending', (_event, sessionId?: unknown) =>
    userQuestionRegistry.listPending(typeof sessionId === 'string' ? sessionId : undefined))
}

/** Push a question to the owning window and wait for the structured answer. */
export function askUserQuestion(win: BrowserWindow, request: UserQuestionRequest): Promise<UserQuestionAnswer> {
  return new Promise((resolve) => {
    userQuestionRegistry.add(request, resolve)
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Question owner is unavailable')
      win.webContents.send('user-question:request', request)
    } catch {
      userQuestionRegistry.answer({
        requestId: request.requestId,
        sessionId: request.sessionId,
        runId: request.runId,
        selectedIds: [],
        freeText: null,
        cancelled: true
      })
    }
  })
}
